/**
 * migrate/submit-view.js — First-actor /migrate/submit page.
 *
 * Pick an asset, pick where the replacement section comes from, look at the
 * diff, submit it for review. The DocDB version (where the record lives) and
 * the metadata-service version (where the proposed replacement section is
 * pulled from) are independent: a v1 record can be patched with v2
 * subject/procedures data and vice versa.
 *
 * Submitting stores a *proposal* on the QC portal (see METADATA-AUTH.md in
 * aind-qc-portal). Nothing is written to DocDB until a second QC-portal user
 * approves it on /migrate/review.
 *
 * URL params kept in sync:
 *   ?dbDocdb=v1|v2  ?dbSvc=v1|v2  ?id=<asset id or subject_id>
 *   ?endpoint=subject|procedures  ?scope=asset|subject
 */

import { html } from 'htm/preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import {
  accountDisplayName,
  getQcAccount,
  loginForQc,
  logoutQc,
} from '../lib/qc-spa-auth.js';
import {
  clearMetadataCache,
  createProposalsBatch,
  diffJson,
  DB_VERSIONS,
  DiffView,
  ENDPOINT_CONFIG,
  ENDPOINTS,
  fetchFullRecord,
  fetchMetadataServiceSection,
  fetchRecordsForSubject,
  getAtPath,
  lookupIdForEndpoint,
  lookupLabelForEndpoint,
  QcLoginBar,
  setAtPath,
} from './lib.js';

export function MigrateSubmitPage() {
  const initial = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const dbDocdb = p.get('dbDocdb') === 'v1' ? 'v1'
      : p.get('dbDocdb') === 'v2' ? 'v2'
      : p.get('db') === 'v1' ? 'v1' : 'v2'; // legacy ?db= fallback
    const dbSvc = p.get('dbSvc') === 'v1' ? 'v1'
      : p.get('dbSvc') === 'v2' ? 'v2'
      : dbDocdb;
    const id = p.get('id') ?? p.get('name') ?? '';
    const ep = p.get('endpoint');
    const endpoint = ENDPOINTS.includes(ep) ? ep : 'subject';
    const scope = p.get('scope') === 'subject' ? 'subject' : 'asset';
    return { dbDocdb, dbSvc, id, endpoint, scope };
  }, []);

  const [dbDocdb, setDbDocdb] = useState(initial.dbDocdb);
  const [dbSvc, setDbSvc] = useState(initial.dbSvc);
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [scope, setScope] = useState(initial.scope);
  const [assetInput, setAssetInput] = useState(initial.id);
  const [selectedId, setSelectedId] = useState(initial.id);

  const [currentRecords, setCurrentRecords] = useState([]);
  const [candidate, setCandidate] = useState(null);
  const [loadStatus, setLoadStatus] = useState('idle');
  const [loadError, setLoadError] = useState('');
  const [serviceWarning, setServiceWarning] = useState(null);
  const [cacheHit, setCacheHit] = useState(false);

  const [account, setAccount] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading');

  const [submitState, setSubmitState] = useState('idle');
  const [submitProgress, setSubmitProgress] = useState({ completed: 0, total: 0 });
  const [proposals, setProposals] = useState([]);
  const [submittedIds, setSubmittedIds] = useState([]);
  const [submitError, setSubmitError] = useState('');
  const [duplicateIds, setDuplicateIds] = useState([]);
  const [note, setNote] = useState('');

  const isSubjectScope = scope === 'subject';
  const currentRecord = currentRecords[0] ?? null;
  const targetPath = ENDPOINT_CONFIG[endpoint]?.targetPath ?? null;
  const user = account ? accountDisplayName(account) : null;

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('dbDocdb', dbDocdb);
    url.searchParams.set('dbSvc', dbSvc);
    url.searchParams.delete('db');
    if (isSubjectScope) url.searchParams.set('scope', 'subject');
    else url.searchParams.delete('scope');
    if (selectedId) url.searchParams.set('id', selectedId);
    else url.searchParams.delete('id');
    url.searchParams.delete('name');
    if (endpoint) url.searchParams.set('endpoint', endpoint);
    else url.searchParams.delete('endpoint');
    history.replaceState({}, '', url);
  }, [dbDocdb, dbSvc, selectedId, endpoint, isSubjectScope]);

  const refreshUser = useCallback(async () => {
    try {
      setAccount(await getQcAccount());
    } catch {
      setAccount(null);
    } finally {
      setAuthStatus('ready');
    }
  }, []);

  const startLogin = useCallback(() => {
    loginForQc().catch((error) => {
      setAuthStatus('ready');
      setSubmitState('error');
      setSubmitError(error.message || String(error));
    });
  }, []);

  useEffect(() => { refreshUser(); }, [refreshUser]);

  useEffect(() => {
    if (!selectedId || !endpoint) {
      setCurrentRecords([]);
      setCandidate(null);
      setLoadStatus('idle');
      setLoadError('');
      setServiceWarning(null);
      return undefined;
    }
    const ctrl = new AbortController();
    setLoadStatus('loading');
    setLoadError('');
    setServiceWarning(null);
    setCacheHit(false);
    setCurrentRecords([]);
    setCandidate(null);
    setSubmitState('idle');
    setSubmitProgress({ completed: 0, total: 0 });
    setProposals([]);
    setSubmittedIds([]);
    setSubmitError('');
    setDuplicateIds([]);

    (async () => {
      try {
        const records = isSubjectScope
          ? await fetchRecordsForSubject(dbDocdb, selectedId, ctrl.signal)
          : [await fetchFullRecord(dbDocdb, selectedId, ctrl.signal)];
        if (ctrl.signal.aborted) return;
        if (records.length === 0) {
          throw new Error(isSubjectScope
            ? `No DocDB assets found for subject_id "${selectedId}" in ${dbDocdb}.`
            : `Asset "${selectedId}" not found in DocDB ${dbDocdb}.`);
        }
        const record = records[0];
        setCurrentRecords(records);

        const lookupIds = isSubjectScope
          ? records.map((item) => lookupIdForEndpoint(item, endpoint))
          : [lookupIdForEndpoint(record, endpoint)];
        const missingIndex = lookupIds.findIndex((lookupId) => !lookupId);
        if (missingIndex >= 0) {
          const missing = records[missingIndex];
          throw new Error(`Asset "${missing?.name ?? missing?._id ?? selectedId}" has no ${lookupLabelForEndpoint(endpoint)} — cannot query metadata service.`);
        }
        const uniqueLookupIds = [...new Set(lookupIds)];
        const serviceResults = await Promise.all(
          uniqueLookupIds.map((lookupId) => fetchMetadataServiceSection(dbSvc, endpoint, lookupId, ctrl.signal)),
        );
        if (ctrl.signal.aborted) return;
        const byLookupId = new Map(uniqueLookupIds.map((lookupId, index) => [lookupId, serviceResults[index]]));
        const sections = lookupIds.map((lookupId) => byLookupId.get(lookupId).data);
        const warnings = [...new Set(serviceResults.map((result) => result.warning).filter(Boolean))];
        setServiceWarning(warnings.length ? warnings.join(' ') : null);
        setCacheHit(serviceResults.length > 0 && serviceResults.every((result) => result.fromCache));
        setCandidate(isSubjectScope ? sections : sections[0]);
        setLoadStatus('ready');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        console.error('[migrate/submit] load failed:', err);
        setLoadError(err.message || String(err));
        setLoadStatus('error');
      }
    })();

    return () => ctrl.abort();
  }, [dbDocdb, dbSvc, selectedId, endpoint, isSubjectScope]);

  const mergedRecords = useMemo(() => {
    if (candidate == null || !targetPath) return [];
    return currentRecords.map((record, index) => setAtPath(
      record,
      targetPath,
      isSubjectScope ? candidate[index] : candidate,
    ));
  }, [isSubjectScope, currentRecords, candidate, targetPath]);

  const recordChanges = useMemo(() => {
    if (candidate == null || !targetPath) return [];
    return currentRecords.map((record, index) => ({
      record,
      merged: mergedRecords[index],
      diff: diffJson(
        getAtPath(record, targetPath) ?? null,
        isSubjectScope ? candidate[index] : candidate,
      ),
    }));
  }, [isSubjectScope, currentRecords, candidate, targetPath, mergedRecords]);

  const sectionDiff = useMemo(
    () => recordChanges.find((item) => item.diff.length > 0)?.diff ?? recordChanges[0]?.diff ?? null,
    [recordChanges],
  );

  const changedRecords = useMemo(
    () => recordChanges.filter((item) => item.diff.length > 0),
    [recordChanges],
  );

  const unsubmittedRecords = useMemo(
    () => changedRecords.filter((item) => !submittedIds.includes(
      String(item.record._id ?? item.record.name ?? selectedId),
    )),
    [changedRecords, selectedId, submittedIds],
  );

  function handleFetch() {
    const name = assetInput.trim();
    if (!name) return;
    setSubmitState('idle');
    setSubmitProgress({ completed: 0, total: 0 });
    setProposals([]);
    setSubmittedIds([]);
    setSubmitError('');
    setDuplicateIds([]);
    setSelectedId(name);
  }

  async function handleSubmit() {
    const pending = unsubmittedRecords;
    if (pending.length === 0) return;
    setSubmitState('submitting');
    setSubmitProgress({ completed: 0, total: pending.length });
    setSubmitError('');
    setDuplicateIds([]);
    const inputs = pending.map(({ record, merged: next }) => ({
      version: dbDocdb,
      id: next._id ?? record._id ?? record.name ?? selectedId,
      body: next,
      note,
    }));
    const results = await createProposalsBatch(inputs, {
      onProgress: ({ completed, total }) => setSubmitProgress({ completed, total }),
    });
    const created = results.filter((result) => result.proposal).map((result) => result.proposal);
    const failed = results.filter((result) => result.error);
    const duplicate = failed
      .map((result) => result.error)
      .filter((error) => error?.code === 'duplicate_proposal')
      .map((error) => error.payload?.proposal_id)
      .filter(Boolean);
    const duplicateRecordIds = failed
      .filter(({ error }) => error?.code === 'duplicate_proposal')
      .map(({ input }) => input.id)
      .filter(Boolean);
    const unresolved = failed.filter(({ error }) => error?.code !== 'duplicate_proposal');
    setProposals((previous) => {
      const all = [...previous, ...created];
      return all.filter((proposal, index) => all.findIndex((p) => p.proposal_id === proposal.proposal_id) === index);
    });
    setSubmittedIds((previous) => [
      ...new Set([
        ...previous,
        ...created.map((proposal) => String(proposal.record_id)),
        ...duplicateRecordIds.map(String),
      ]),
    ]);
    setDuplicateIds(duplicate);

    if (failed.some(({ error }) => error?.code === 'not_authenticated' || error?.status === 401)) {
      startLogin();
    }
    if (unresolved.length === 0) {
      setSubmitState('submitted');
      return;
    }
    console.error('[migrate/submit] batch submit failed:', failed);
    setSubmitState('error');
    setSubmitError(`${created.length} proposal${created.length === 1 ? '' : 's'} submitted; ${unresolved.length} could not be submitted.`);
  }

  function handleCopyUrl() {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  }

  const noChanges = recordChanges.length > 0 && changedRecords.length === 0;
  const submitDisabled = !currentRecord
    || noChanges
    || submitState === 'submitting'
    || submitState === 'submitted';
  const loadingMessage = `Fetching ${isSubjectScope ? 'subject assets from' : 'from'} DocDB ${dbDocdb} + metadata-service ${dbSvc}${endpoint === 'procedures' ? ' (procedures can take ~45s — cached for 24 h)' : ''}…`;

  return html`
    <div class="migrate-page">
      <h1>Submit metadata migration</h1>
      <p class="migrate-intro">
        Choose the versions and section to copy. Enter an asset name or subject
        ID, then review the proposed changes and submit them for approval.
        Submitting creates a proposal; it does not change DocDB. A second QC
        Portal user must approve it on the${' '}<a href="/migrate/review">review page</a>.
      </p>

      <${QcLoginBar}
        user=${user}
        status=${authStatus}
        onLogin=${startLogin}
        onLogout=${() => logoutQc()}
      />

      <section class="migrate-section">
        <div class="migrate-controls-row">
          <div class="migrate-control">
            <label>DocDB version</label>
            <div class="migrate-toggle" role="group" aria-label="DocDB version">
              ${DB_VERSIONS.map(
                (d) => html`
                  <button
                    class=${`migrate-toggle-btn ${dbDocdb === d ? 'is-active' : ''}`}
                    onClick=${() => setDbDocdb(d)}
                  >${d}</button>`,
              )}
            </div>
          </div>
          <div class="migrate-control">
            <label>Metadata-service version</label>
            <div class="migrate-toggle" role="group" aria-label="Metadata-service version">
              ${DB_VERSIONS.map(
                (d) => html`
                  <button
                    class=${`migrate-toggle-btn ${dbSvc === d ? 'is-active' : ''}`}
                    onClick=${() => setDbSvc(d)}
                  >${d}</button>`,
              )}
            </div>
          </div>
          <div class="migrate-control">
            <label>Endpoint</label>
            <div class="migrate-toggle" role="group" aria-label="Endpoint">
              ${ENDPOINTS.map(
                (e) => html`
                  <button
                  class=${`migrate-toggle-btn ${endpoint === e ? 'is-active' : ''}`}
                    onClick=${() => setEndpoint(e)}
                  >${e}</button>`,
              )}
            </div>
          </div>
          <div class="migrate-control">
            <label>Scope</label>
            <div class="migrate-toggle" role="group" aria-label="Migration scope">
              <button
                class=${`migrate-toggle-btn ${scope === 'asset' ? 'is-active' : ''}`}
                onClick=${() => setScope('asset')}
              >Asset</button>
              <button
                class=${`migrate-toggle-btn ${scope === 'subject' ? 'is-active' : ''}`}
                onClick=${() => setScope('subject')}
              >Subject</button>
            </div>
          </div>
        </div>
      </section>

      <section class="migrate-section">
        <div class="migrate-lookup-row">
          <input
            type="text"
            class="migrate-asset-input"
            placeholder=${isSubjectScope ? 'subject_id…' : 'Asset name or _id…'}
            value=${assetInput}
            onInput=${(e) => setAssetInput(e.currentTarget.value)}
            onKeyDown=${(e) => e.key === 'Enter' && handleFetch()}
          />
          <button
            class="btn-primary"
            disabled=${!assetInput.trim() || loadStatus === 'loading'}
            onClick=${handleFetch}
          >${loadStatus === 'loading' ? 'Loading…' : 'Fetch'}</button>
          <button
            class="btn-secondary"
            disabled=${!assetInput.trim() || loadStatus === 'loading'}
            onClick=${() => {
              const lookupIds = isSubjectScope
                ? currentRecords.map((record) => lookupIdForEndpoint(record, endpoint)).filter(Boolean)
                : [lookupIdForEndpoint(currentRecord, endpoint) || assetInput.trim()];
              [...new Set(lookupIds)].forEach((lookupId) => clearMetadataCache(dbSvc, endpoint, lookupId));
              setCacheHit(false);
            }}
          >Clear cache</button>
        </div>
        ${loadStatus === 'error'
          ? html`<p class="error-banner" style="margin-top:8px">${loadError}</p>`
          : null}
      </section>

      ${selectedId && loadStatus !== 'error'
        ? html`
            <section class="migrate-section">
              <h2>${isSubjectScope ? 'Selected subject' : 'Selected asset'}</h2>
              <div class="migrate-selected">
                ${isSubjectScope
                  ? currentRecords.length
                    ? html`
                        <div><strong>subject_id:</strong> <code>${selectedId}</code></div>
                        <div><strong>assets:</strong> ${currentRecords.length}</div>
                      `
                    : html`<div><strong>looking up:</strong> <code>${selectedId}</code></div>`
                  : currentRecord
                  ? html`
                      <div><strong>_id:</strong> <code>${currentRecord._id ?? selectedId}</code></div>
                      <div><strong>name:</strong> ${currentRecord.name ?? '—'}</div>
                      <div><strong>subject_id:</strong> ${currentRecord?.subject?.subject_id ?? '—'}</div>
                      <div><strong>project_name:</strong> ${currentRecord?.data_description?.project_name ?? '—'}</div>
                    `
                  : html`<div><strong>looking up:</strong> <code>${selectedId}</code></div>`}
              </div>

              ${isSubjectScope && currentRecords.length
                ? html`
                    <div class="migrate-table-responsive" style="margin-top:12px; max-height:240px">
                      <table class="data-table migrate-table">
                        <thead><tr><th>Asset</th><th>_id</th><th>Change</th></tr></thead>
                        <tbody>
                          ${recordChanges.map(({ record, diff }) => html`
                            <tr key=${record._id ?? record.name}>
                              <td>${record.name ?? '—'}</td>
                              <td class="migrate-id-cell">${record._id ?? '—'}</td>
                              <td>${diff.length ? 'will change' : 'already matches'}</td>
                            </tr>`)}
                        </tbody>
                      </table>
                    </div>`
                : null}

              ${loadStatus === 'loading'
                ? html`<p class="loading-message">${loadingMessage}</p>`
                : null}

              ${loadStatus === 'ready'
                ? html`
                    ${cacheHit
                      ? html`<p class="info-banner" style="margin-top:8px">Metadata-service response loaded from cache (24 h). Use "Clear cache" to force a fresh fetch.</p>`
                      : null}
                    ${serviceWarning
                      ? html`<p class="warning-banner" style="margin-top:8px">${serviceWarning}</p>`
                      : null}
                    ${isSubjectScope
                      ? html`<p class="info-banner" style="margin-top:8px">
                          This ${endpoint} replacement will be proposed for
                          ${currentRecords.length} assets; ${changedRecords.length}
                          ${changedRecords.length === 1 ? 'asset needs' : 'assets need'} a change.
                        </p>`
                      : null}
                    <${DiffView}
                      entries=${sectionDiff}
                      title=${`Proposed changes to '${endpoint}' (DocDB ${dbDocdb} ← metadata-service ${dbSvc})`}
                    />

                    ${submitState !== 'submitted' && !noChanges
                      ? html`
                          <div class="migrate-note-row">
                            <label for="migrate-note">Note for the reviewer (optional)</label>
                            <input
                              id="migrate-note"
                              type="text"
                              class="migrate-asset-input"
                              placeholder="Why this change is right…"
                              value=${note}
                              onInput=${(e) => setNote(e.currentTarget.value)}
                            />
                          </div>`
                      : null}

                    <div class="migrate-submit-row">
                      <button
                        class="btn-primary migrate-action-btn"
                        onClick=${user ? handleSubmit : startLogin}
                        disabled=${submitDisabled}
                      >${submitState === 'submitting'
                        ? `Submitting ${submitProgress.completed} of ${submitProgress.total}…`
                        : user ? (unsubmittedRecords.length > 1 ? `Submit ${unsubmittedRecords.length} assets for review` : 'Submit for review')
                        : 'Log in to submit'}</button>
                      <button class="btn-secondary" onClick=${handleCopyUrl}>Copy shareable URL</button>
                      <a class="btn-secondary" href="/migrate/review">Open review queue →</a>
                    </div>

                    ${submitState === 'submitted' && (proposals.length || duplicateIds.length)
                      ? html`
                          <div class="migrate-submit-banner migrate-pending">
                            <strong>${proposals.length + duplicateIds.length} proposal${proposals.length + duplicateIds.length === 1 ? '' : 's'} queued for review.</strong> Nothing has been
                            written to DocDB yet — a second QC-portal user has to
                            approve them. Send the reviewer this link:
                            ${proposals[0]
                              ? html` ${' '}<a href=${`/migrate/review?focus=${encodeURIComponent(proposals[0].proposal_id)}`}>
                                  /migrate/review?focus=${proposals[0].proposal_id}
                                </a>
                                <div class="migrate-pending-poll">
                                  The review page groups proposals with the same change.
                                </div>`
                              : null}
                            ${duplicateIds.length
                              ? html`<div class="migrate-pending-poll">
                                  ${duplicateIds.length} matching proposal${duplicateIds.length === 1 ? ' already exists' : 's already exist'} in the queue.
                                  ${duplicateIds.map((id) => html`<a href=${`/migrate/review?focus=${encodeURIComponent(id)}`}>Open ${id}</a>${' '}`)}
                                </div>`
                              : null}
                          </div>`
                      : null}

                    ${submitState === 'error'
                      ? html`
                          <div class="migrate-submit-banner migrate-error">
                            <strong>Submission error.</strong> ${submitError}
                            ${duplicateIds.length
                              ? html` ${duplicateIds.map((id) => html`<a href=${`/migrate/review?focus=${encodeURIComponent(id)}`}>Open existing proposal ${id} →</a>${' '}`)}`
                              : null}
                          </div>`
                      : null}
                  `
                : null}
            </section>`
        : null}
    </div>`;
}

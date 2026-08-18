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
 *   ?dbDocdb=v1|v2  ?dbSvc=v1|v2  ?id=<asset id or name>  ?endpoint=subject|procedures
 */

import { html } from 'htm/preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { getQcUser, loginToQcPortal, logoutQcPortal } from '../lib/qc-auth.js';
import {
  clearMetadataCache,
  createProposal,
  diffJson,
  DB_VERSIONS,
  DiffView,
  ENDPOINT_CONFIG,
  ENDPOINTS,
  fetchFullRecord,
  fetchMetadataServiceSection,
  getAtPath,
  lookupIdForEndpoint,
  lookupLabelForEndpoint,
  QcLoginBar,
  setAtPath,
} from './lib.js';

// Sentinel endpoint value for the free-form "Edit" mode — not a real
// metadata-service endpoint, so it lives outside ENDPOINTS.
const EDIT = 'edit';

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
    const endpoint = ep === EDIT || ENDPOINTS.includes(ep) ? ep : 'subject';
    return { dbDocdb, dbSvc, id, endpoint };
  }, []);

  const [dbDocdb, setDbDocdb] = useState(initial.dbDocdb);
  const [dbSvc, setDbSvc] = useState(initial.dbSvc);
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [assetInput, setAssetInput] = useState(initial.id);
  const [selectedId, setSelectedId] = useState(initial.id);

  const [currentRecord, setCurrentRecord] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [loadStatus, setLoadStatus] = useState('idle');
  const [loadError, setLoadError] = useState('');
  const [serviceWarning, setServiceWarning] = useState(null);
  const [cacheHit, setCacheHit] = useState(false);

  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading');

  const [submitState, setSubmitState] = useState('idle');
  const [proposal, setProposal] = useState(null);
  const [submitError, setSubmitError] = useState('');
  const [duplicateId, setDuplicateId] = useState(null);
  const [note, setNote] = useState('');

  const [originalRecord, setOriginalRecord] = useState(null);

  // Free-form edit mode: editText holds the JSON the user is editing; editing
  // toggles between the editor (true) and the summary-of-changes view (false).
  const [editText, setEditText] = useState('');
  const [editing, setEditing] = useState(false);

  const isEdit = endpoint === EDIT;
  const targetPath = isEdit ? null : ENDPOINT_CONFIG[endpoint]?.targetPath ?? null;

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('dbDocdb', dbDocdb);
    url.searchParams.set('dbSvc', dbSvc);
    url.searchParams.delete('db');
    if (selectedId) url.searchParams.set('id', selectedId);
    else url.searchParams.delete('id');
    url.searchParams.delete('name');
    if (endpoint) url.searchParams.set('endpoint', endpoint);
    else url.searchParams.delete('endpoint');
    history.replaceState({}, '', url);
  }, [dbDocdb, dbSvc, selectedId, endpoint]);

  const refreshUser = useCallback(async () => {
    const me = await getQcUser();
    setUser(me?.user ?? null);
    setAuthStatus('ready');
  }, []);

  useEffect(() => { refreshUser(); }, [refreshUser]);

  useEffect(() => {
    if (!selectedId || !endpoint) {
      setCurrentRecord(null);
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
    setCurrentRecord(null);
    setCandidate(null);
    setEditing(false);
    setSubmitState('idle');
    setProposal(null);
    setSubmitError('');
    setDuplicateId(null);

    (async () => {
      try {
        const record = await fetchFullRecord(dbDocdb, selectedId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setCurrentRecord(record);
        setOriginalRecord((prev) => prev ?? record);

        // Edit mode pulls nothing from the metadata service — the user edits
        // the DocDB record directly.
        if (endpoint === EDIT) {
          setEditText(JSON.stringify(record, null, 2));
          setEditing(true);
          setLoadStatus('ready');
          return;
        }

        const lookupId = lookupIdForEndpoint(record, endpoint);
        if (!lookupId) {
          throw new Error(`Selected asset has no ${lookupLabelForEndpoint(endpoint)} — cannot query metadata service.`);
        }
        const { data: section, warning, fromCache } =
          await fetchMetadataServiceSection(dbSvc, endpoint, lookupId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setServiceWarning(warning ?? null);
        setCacheHit(fromCache);
        setCandidate(section);
        setLoadStatus('ready');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        console.error('[migrate/submit] load failed:', err);
        setLoadError(err.message || String(err));
        setLoadStatus('error');
      }
    })();

    return () => ctrl.abort();
  }, [dbDocdb, dbSvc, selectedId, endpoint]);

  // Parse the editor text (edit mode only). Returns { record } on success or
  // { error } so the UI can show a parse error without throwing.
  const parsedEdit = useMemo(() => {
    if (!isEdit) return null;
    try {
      return { record: JSON.parse(editText) };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }, [isEdit, editText]);

  const merged = useMemo(() => {
    if (isEdit) return currentRecord; // submit the edited record as-is
    return currentRecord && candidate != null
      ? setAtPath(currentRecord, targetPath, candidate)
      : null;
  }, [isEdit, currentRecord, candidate, targetPath]);

  const sectionDiff = useMemo(() => {
    if (isEdit) {
      // While editing, preview against the live (parseable) text; once done,
      // currentRecord holds the committed edits.
      const next = editing ? parsedEdit?.record : currentRecord;
      return originalRecord && next ? diffJson(originalRecord, next) : null;
    }
    return currentRecord && candidate != null
      ? diffJson(getAtPath(currentRecord, targetPath) ?? null, candidate)
      : null;
  }, [isEdit, editing, parsedEdit, originalRecord, currentRecord, candidate, targetPath]);

  function handleFetch() {
    const name = assetInput.trim();
    if (!name) return;
    setSubmitState('idle');
    setProposal(null);
    setSubmitError('');
    setDuplicateId(null);
    setOriginalRecord(null);
    setSelectedId(name);
  }

  async function handleSubmit() {
    if (!merged) return;
    setSubmitState('submitting');
    setSubmitError('');
    setDuplicateId(null);
    try {
      const created = await createProposal({
        version: dbDocdb,
        id: merged._id ?? selectedId,
        body: merged,
        note,
      });
      setProposal(created);
      setSubmitState('submitted');
    } catch (err) {
      console.error('[migrate/submit] submit failed:', err);
      if (err.code === 'not_authenticated') {
        loginToQcPortal();
        return;
      }
      if (err.code === 'duplicate_proposal') {
        setDuplicateId(err.payload.proposal_id ?? null);
      }
      setSubmitState('error');
      setSubmitError(err.payload?.detail || err.message || String(err));
    }
  }

  function handleCopyUrl() {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  }

  function handleDoneEditing() {
    if (!parsedEdit || parsedEdit.error) return;
    setCurrentRecord(parsedEdit.record);
    setEditing(false);
  }

  function handleResumeEditing() {
    // Re-open the editor with the current (committed) record as a starting point.
    if (currentRecord) setEditText(JSON.stringify(currentRecord, null, 2));
    setEditing(true);
  }

  const noChanges = sectionDiff != null && sectionDiff.length === 0;
  const submitDisabled = (isEdit && editing)
    || noChanges
    || submitState === 'submitting'
    || submitState === 'submitted';

  return html`
    <div class="migrate-page">
      <h1>Submit metadata migration</h1>
      <p class="migrate-intro">
        Propose a DocDB record repair by pulling <code>subject</code>,
        <code>procedures</code>, <code>funding</code> or
        <code>investigators</code> from the internal
        <code>aind-metadata-service</code> and merging it into a DocDB record.
        Subject and procedures are looked up by <code>subject.subject_id</code>;
        funding and investigators by <code>data_description.project_name</code>
        and merged into <code>data_description</code>. Or pick <code>Edit</code>
        to change any fields by hand. The DocDB and metadata-service versions are
        independent — you can pull v2 metadata into a v1 record, or vice versa.
        Nothing is written to DocDB when you submit: the proposal is stored on
        the QC portal and shown publicly on the
        <a href="/migrate/review">review page</a> until a second QC-portal user
        approves it.
      </p>

      <${QcLoginBar}
        user=${user}
        status=${authStatus}
        onLogin=${() => loginToQcPortal()}
        onLogout=${() => logoutQcPortal(refreshUser)}
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
              <button
                class=${`migrate-toggle-btn ${isEdit ? 'is-active' : ''}`}
                title="Edit the DocDB record directly"
                onClick=${() => setEndpoint(EDIT)}
              >Edit</button>
            </div>
          </div>
        </div>
      </section>

      <section class="migrate-section">
        <div class="migrate-lookup-row">
          <input
            type="text"
            class="migrate-asset-input"
            placeholder="Asset name or _id…"
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
            title="Clear cached metadata-service response for this asset+endpoint"
            disabled=${!assetInput.trim() || loadStatus === 'loading' || isEdit}
            onClick=${() => {
              const lookupId = (currentRecord && lookupIdForEndpoint(currentRecord, endpoint)) || assetInput.trim();
              clearMetadataCache(dbSvc, endpoint, lookupId);
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
              <h2>Selected asset</h2>
              <div class="migrate-selected">
                ${currentRecord
                  ? html`
                      <div><strong>_id:</strong> <code>${currentRecord._id ?? selectedId}</code></div>
                      <div><strong>name:</strong> ${currentRecord.name ?? '—'}</div>
                      <div><strong>subject_id:</strong> ${currentRecord?.subject?.subject_id ?? '—'}</div>
                      <div><strong>project_name:</strong> ${currentRecord?.data_description?.project_name ?? '—'}</div>
                    `
                  : html`<div><strong>looking up:</strong> <code>${selectedId}</code></div>`}
              </div>

              ${loadStatus === 'loading'
                ? html`<p class="loading-message">${isEdit
                    ? html`Fetching record from DocDB ${dbDocdb}…`
                    : html`Fetching from DocDB ${dbDocdb} + metadata-service ${dbSvc}${endpoint === 'procedures' ? ' (procedures can take ~45s — cached for 24 h)' : ''}…`}</p>`
                : null}

              ${loadStatus === 'ready'
                ? html`
                    ${isEdit
                      ? html`
                          ${editing
                            ? html`
                                <div class="migrate-edit">
                                  <p class="migrate-edit-hint">
                                    Edit the DocDB record JSON below, then click
                                    <strong>Done editing</strong> to review the summary of changes.
                                  </p>
                                  <textarea
                                    class="migrate-edit-textarea"
                                    spellcheck="false"
                                    value=${editText}
                                    onInput=${(e) => setEditText(e.currentTarget.value)}
                                  ></textarea>
                                  ${parsedEdit?.error
                                    ? html`<p class="error-banner" style="margin-top:8px">Invalid JSON: ${parsedEdit.error}</p>`
                                    : null}
                                  <div class="migrate-edit-actions">
                                    <button
                                      class="btn-primary"
                                      disabled=${Boolean(parsedEdit?.error)}
                                      onClick=${handleDoneEditing}
                                    >Done editing</button>
                                  </div>
                                  <${DiffView}
                                    entries=${parsedEdit?.error ? null : sectionDiff}
                                    title="Summary of changes (live preview)"
                                  />
                                </div>`
                            : html`
                                <div class="migrate-edit-actions" style="margin-bottom:8px">
                                  <button class="btn-secondary" onClick=${handleResumeEditing}>Resume editing</button>
                                </div>
                                <${DiffView}
                                  entries=${sectionDiff}
                                  title="Summary of changes to apply to DocDB"
                                />`}
                        `
                      : html`
                          ${cacheHit
                            ? html`<p class="info-banner" style="margin-top:8px">Metadata-service response loaded from cache (24 h). Use "Clear cache" to force a fresh fetch.</p>`
                            : null}
                          ${serviceWarning
                            ? html`<p class="warning-banner" style="margin-top:8px">${serviceWarning}</p>`
                            : null}
                          <${DiffView}
                            entries=${sectionDiff}
                            title=${`Proposed changes to '${endpoint}' (DocDB ${dbDocdb} ← metadata-service ${dbSvc})`}
                          />`}

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
                        onClick=${user ? handleSubmit : () => loginToQcPortal()}
                        disabled=${submitDisabled}
                      >${submitState === 'submitting' ? 'Submitting…'
                        : user ? 'Submit for review'
                        : 'Log in to submit'}</button>
                      <button class="btn-secondary" onClick=${handleCopyUrl}>Copy shareable URL</button>
                      <a class="btn-secondary" href="/migrate/review">Open review queue →</a>
                    </div>

                    ${submitState === 'submitted' && proposal
                      ? html`
                          <div class="migrate-submit-banner migrate-pending">
                            <strong>Submitted for review.</strong> Nothing has been
                            written to DocDB yet — a second QC-portal user has to
                            approve it. Send them this link:
                            ${' '}<a href=${`/migrate/review?focus=${encodeURIComponent(proposal.proposal_id)}`}>
                              /migrate/review?focus=${proposal.proposal_id}
                            </a>
                            <div class="migrate-pending-poll">
                              Body hash <code>${proposal.body_hash?.slice(0, 12)}…</code>
                            </div>
                          </div>`
                      : null}

                    ${submitState === 'error'
                      ? html`
                          <div class="migrate-submit-banner migrate-error">
                            <strong>Submission error.</strong> ${submitError}
                            ${duplicateId
                              ? html` <a href=${`/migrate/review?focus=${encodeURIComponent(duplicateId)}`}>Open the existing proposal →</a>`
                              : null}
                          </div>`
                      : null}
                  `
                : null}
            </section>`
        : null}
    </div>`;
}

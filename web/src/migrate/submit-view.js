/**
 * migrate/submit-view.js — First-actor /migrate/submit page.
 *
 * Replaces the old single-page MigratePage. Key change: the DocDB version
 * (where the record lives) and the metadata-service version (where the
 * proposed replacement section is pulled from) are now independent. A v1
 * record can be patched with v2 subject/procedures data and vice versa.
 *
 * URL params kept in sync:
 *   ?dbDocdb=v1|v2  ?dbSvc=v1|v2  ?id=<asset id or name>  ?endpoint=subject|procedures
 */

import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { QC_PORTAL_BASE } from '../constants.js';
import {
  buildMergedRecord,
  clearAuthCookies,
  clearMetadataCache,
  deepEqual,
  diffJson,
  DB_VERSIONS,
  DiffView,
  ENDPOINTS,
  fetchFullRecord,
  fetchMetadataServiceSection,
  readCookie,
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
    const endpoint = ENDPOINTS.includes(p.get('endpoint')) ? p.get('endpoint') : 'subject';
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

  const [token, setToken] = useState(() => readCookie('qc_auth_token'));
  const [tokenExpiresAt, setTokenExpiresAt] = useState(() => {
    const v = readCookie('qc_auth_token_expires_at');
    return v ? Number(v) * 1000 : null;
  });
  const [submitState, setSubmitState] = useState('idle');
  const [submitResult, setSubmitResult] = useState(null);
  const [submitError, setSubmitError] = useState('');

  const [originalRecord, setOriginalRecord] = useState(null);

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

  useEffect(() => {
    const handler = () => {
      const t = readCookie('qc_auth_token');
      const exp = readCookie('qc_auth_token_expires_at');
      setToken(t || null);
      setTokenExpiresAt(exp ? Number(exp) * 1000 : null);
    };
    handler();
    window.addEventListener('focus', handler);
    const id = setInterval(handler, 5000);
    return () => { window.removeEventListener('focus', handler); clearInterval(id); };
  }, []);

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
    setSubmitState('idle');
    setSubmitResult(null);
    setSubmitError('');

    (async () => {
      try {
        const record = await fetchFullRecord(dbDocdb, selectedId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setCurrentRecord(record);
        setOriginalRecord((prev) => prev ?? record);

        const subjectId = record?.subject?.subject_id;
        if (!subjectId) {
          throw new Error('Selected asset has no subject.subject_id — cannot query metadata service.');
        }
        const { data: section, warning, fromCache } =
          await fetchMetadataServiceSection(dbSvc, endpoint, subjectId, ctrl.signal);
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

  const merged = useMemo(
    () => (currentRecord && candidate ? buildMergedRecord(currentRecord, endpoint, candidate) : null),
    [currentRecord, candidate, endpoint],
  );
  const sectionDiff = useMemo(
    () => (currentRecord && candidate ? diffJson(currentRecord[endpoint] ?? null, candidate) : null),
    [currentRecord, candidate, endpoint],
  );
  const finalDiff = useMemo(
    () => (originalRecord && currentRecord && originalRecord !== currentRecord
      ? diffJson(originalRecord[endpoint] ?? null, currentRecord[endpoint] ?? null)
      : null),
    [originalRecord, currentRecord, endpoint],
  );

  useEffect(() => {
    if (submitState !== 'pending') return undefined;
    const id = setInterval(async () => {
      try {
        const fresh = await fetchFullRecord(dbDocdb, selectedId);
        if (candidate && deepEqual(fresh[endpoint] ?? null, candidate)) {
          setCurrentRecord(fresh);
          setSubmitState('submitted');
          setSubmitResult((r) => r || { status: 'submitted', detected_via: 'polling' });
        }
      } catch (err) {
        console.debug('[migrate/submit] poll failed:', err.message);
      }
    }, 10000);
    return () => clearInterval(id);
  }, [submitState, dbDocdb, selectedId, candidate, endpoint]);

  function handleFetch() {
    const name = assetInput.trim();
    if (!name) return;
    setSubmitState('idle');
    setSubmitResult(null);
    setSubmitError('');
    setOriginalRecord(null);
    setSelectedId(name);
  }

  function handleRequestToken() {
    const id = currentRecord?._id ?? selectedId;
    if (!id) return;
    const here = window.location.href;
    const url = `${QC_PORTAL_BASE}/metadata/token`
      + `?id=${encodeURIComponent(id)}`
      + `&redirect=${encodeURIComponent(here)}`;
    window.location.assign(url);
  }

  async function handleSubmit() {
    if (!token || !merged) return;
    setSubmitState('submitting');
    setSubmitResult(null);
    setSubmitError('');
    try {
      const url = `${QC_PORTAL_BASE}/metadata/${dbDocdb}?auth-token=${encodeURIComponent(token)}`;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });
      let body;
      try { body = await resp.json(); }
      catch { body = { error: await resp.text().catch(() => '') }; }

      if (resp.status === 401 && body?.error === 'invalid_token') {
        // Token was rejected (typically because the QC portal restarted and
        // its in-memory token table was wiped). Clear the dead cookie,
        // reset state so the page is in a clean retry-ready state if the
        // user lands back without a token, then bounce through the
        // re-validation redirect.
        clearAuthCookies();
        setToken(null);
        setTokenExpiresAt(null);
        setSubmitState('idle');
        setSubmitResult(null);
        setSubmitError('');
        handleRequestToken();
        return;
      }

      if (!resp.ok) {
        setSubmitState('error');
        setSubmitResult(body);
        setSubmitError(`HTTP ${resp.status}: ${body?.error || body?.detail || JSON.stringify(body)}`);
        return;
      }

      setSubmitResult(body);
      if (body?.status === 'pending') {
        setSubmitState('pending');
      } else if (body?.status === 'submitted') {
        setSubmitState('submitted');
        try {
          const fresh = await fetchFullRecord(dbDocdb, selectedId);
          setCurrentRecord(fresh);
        } catch { /* ignore */ }
      } else if (body?.status === 'failed') {
        setSubmitState('failed');
      } else {
        setSubmitState('error');
        setSubmitError('Unexpected response from QC portal.');
      }
    } catch (err) {
      console.error('[migrate/submit] submit failed:', err);
      setSubmitState('error');
      setSubmitError(err.message || String(err));
    }
  }

  function handleCopyUrl() {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  }

  const tokenLabel = token
    ? (tokenExpiresAt
        ? `Submit (token expires ${new Date(tokenExpiresAt).toLocaleString()})`
        : 'Submit')
    : 'Validate token';

  return html`
    <div class="migrate-page">
      <h1>Submit metadata migration</h1>
      <p class="migrate-intro">
        Propose a DocDB record repair by pulling <code>subject.json</code> or
        <code>procedures.json</code> from the internal
        <code>aind-metadata-service</code> and merging it into a DocDB record.
        The DocDB and metadata-service versions are independent — you can pull
        v2 metadata into a v1 record, or vice versa. Once submitted, the
        proposed change is visible publicly on the
        <a href="/migrate/review">review page</a> until a second QC-portal user
        approves it.
      </p>

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
          <div class="migrate-control migrate-control-right">
            <label>QC portal</label>
            <${QcLoginButton}
              token=${token}
              assetName=${currentRecord?.name ?? assetInput.trim() ?? selectedId}
            />
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
            disabled=${!assetInput.trim() || loadStatus === 'loading'}
            onClick=${() => {
              const subjectId = currentRecord?.subject?.subject_id ?? assetInput.trim();
              clearMetadataCache(dbSvc, endpoint, subjectId);
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
                    `
                  : html`<div><strong>looking up:</strong> <code>${selectedId}</code></div>`}
              </div>

              ${loadStatus === 'loading'
                ? html`<p class="loading-message">Fetching from DocDB ${dbDocdb} + metadata-service ${dbSvc}${endpoint === 'procedures' ? ' (procedures can take ~45s — cached for 24 h)' : ''}…</p>`
                : null}

              ${loadStatus === 'ready'
                ? html`
                    ${cacheHit
                      ? html`<p class="info-banner" style="margin-top:8px">Metadata-service response loaded from cache (24 h). Use "Clear cache" to force a fresh fetch.</p>`
                      : null}
                    ${serviceWarning
                      ? html`<p class="warning-banner" style="margin-top:8px">${serviceWarning}</p>`
                      : null}
                    <${DiffView}
                      entries=${sectionDiff}
                      title=${`Proposed changes to '${endpoint}' (DocDB ${dbDocdb} ← metadata-service ${dbSvc})`}
                    />

                    <div class="migrate-submit-row">
                      <button
                        class=${`${token ? 'btn-primary' : 'btn-secondary'} migrate-action-btn`}
                        onClick=${token ? handleSubmit : handleRequestToken}
                        disabled=${(sectionDiff && sectionDiff.length === 0)
                          || submitState === 'submitting'
                          || submitState === 'submitted'
                          || submitState === 'pending'}
                      >${submitState === 'submitting' ? 'Submitting…' : tokenLabel}</button>
                      <button class="btn-secondary" onClick=${handleCopyUrl}>Copy shareable URL</button>
                      <a class="btn-secondary" href="/migrate/review">Open review queue →</a>
                    </div>

                    ${submitState === 'pending'
                      ? html`
                          <div class="migrate-submit-banner migrate-pending">
                            <strong>1/2 — submitted; awaiting second approver.</strong>
                            ${submitResult?.expires_at
                              ? html` Token expires ${new Date(submitResult.expires_at * 1000).toLocaleString()}.`
                              : null}
                            The pending request now appears on the
                            <a href="/migrate/review">review page</a> for any QC-portal user.
                            <div class="migrate-pending-poll">Polling DocDB every 10s to detect upsert…</div>
                          </div>`
                      : null}

                    ${submitState === 'submitted'
                      ? html`
                          <div class="migrate-submit-banner migrate-success">
                            <strong>✓ Upsert applied.</strong>
                            ${submitResult?.docdb_status
                              ? html` DocDB status: ${submitResult.docdb_status}.`
                              : null}
                            ${finalDiff
                              ? html`<${DiffView} entries=${finalDiff} title="Final change applied to DocDB" />`
                              : null}
                          </div>`
                      : null}

                    ${submitState === 'failed'
                      ? html`
                          <div class="migrate-submit-banner migrate-failed">
                            <strong>DocDB upsert failed.</strong>
                            ${submitResult?.docdb_status
                              ? html` Status ${submitResult.docdb_status}.`
                              : null}
                            Tokens are NOT consumed; retry from the review page.
                            <pre class="migrate-submit-detail">${JSON.stringify(submitResult, null, 2)}</pre>
                          </div>`
                      : null}

                    ${submitState === 'error'
                      ? html`
                          <div class="migrate-submit-banner migrate-error">
                            <strong>Submission error.</strong> ${submitError}
                            ${submitResult
                              ? html`<pre class="migrate-submit-detail">${JSON.stringify(submitResult, null, 2)}</pre>`
                              : null}
                          </div>`
                      : null}
                  `
                : null}
            </section>`
        : null}
    </div>`;
}

function QcLoginButton({ token, assetName }) {
  const loggedIn = Boolean(token);
  const next = assetName ? `/view?name=${encodeURIComponent(assetName)}` : '/';
  const href = `${QC_PORTAL_BASE}/login?next=${encodeURIComponent(next)}`;
  if (loggedIn) {
    return html`<button class="migrate-login-btn is-logged-in" disabled>Logged in</button>`;
  }
  return html`<a class="migrate-login-btn" href=${href} target="_blank" rel="noopener noreferrer">Login</a>`;
}

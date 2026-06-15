/**
 * migrate/view.js — Two-actor metadata migration tool (hidden /migrate page).
 *
 * Workflow:
 *   1. User picks a DocDB version (v1 or v2) and selects an asset from a
 *      searchable table. Asset list is fetched with a projection of
 *      `{ _id, name }` from the chosen DocDB.
 *   2. User picks an endpoint (`subject` or `procedures`). The page fetches
 *      the full asset record from DocDB and the latest section from the
 *      internal aind-metadata-service via /metadata-service/<...>.
 *   3. A merged candidate record is built (current record with the chosen
 *      section replaced) and a row-level JSON diff is displayed.
 *   4. The user clicks "Validate token" → redirected to the QC portal's
 *      `/metadata/token` endpoint, which sets a cross-subdomain cookie.
 *   5. On return, the button becomes "Submit". Submitting POSTs the merged
 *      record to `${QC_PORTAL_BASE}/metadata/${db}?auth-token=…`.
 *   6. The first submitter sees a "pending" status with a shareable URL.
 *      The second submitter (or a refresh once the upsert succeeded) sees
 *      the final state with highlighted changes.
 *
 * URL params kept in sync (so a link can be shared with the second actor):
 *   ?db=v1|v2  ?id=<asset_id>  ?endpoint=subject|procedures
 *
 * Note: token cookies are issued on `.allenneuraldynamics.org`, so the
 * "Validate token" button only round-trips correctly when the page itself
 * is served from an `*.allenneuraldynamics.org` subdomain. On localhost the
 * UI still renders but the token cookie is unreadable.
 */

import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { QC_PORTAL_BASE } from '../constants.js';
import { queryDocDb } from '../lib/docdb.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCDB_BASES = {
  v1: 'https://api.allenneuraldynamics.org/v1/metadata_index/data_assets',
  v2: 'https://api.allenneuraldynamics.org/v2/metadata_index/data_assets',
};
const METADATA_SERVICE_PATHS = {
  v1: {
    subject: (id) => `/metadata-service/subject/${encodeURIComponent(id)}`,
    procedures: (id) => `/metadata-service/procedures/${encodeURIComponent(id)}`,
  },
  v2: {
    subject: (id) => `/metadata-service/api/v2/subject/${encodeURIComponent(id)}`,
    procedures: (id) => `/metadata-service/api/v2/procedures/${encodeURIComponent(id)}`,
  },
};
const ENDPOINTS = ['subject', 'procedures'];

// ---------------------------------------------------------------------------
// Helpers — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Read the value of a non-HttpOnly cookie by name.
 * @param {string} name
 * @returns {string|null}
 */
export function readCookie(name) {
  const parts = (document.cookie || '').split('; ');
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) return decodeURIComponent(part.slice(name.length + 1));
  }
  return null;
}

/**
 * Deep value equality via JSON canonicalisation.
 * @param {*} a
 * @param {*} b
 */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Stable, key-sorted JSON serialisation. Used for equality checks and for
 * fingerprinting payloads.
 * @param {*} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * Extract the actual data payload from a metadata-service response.
 *
 * v1 returns `{ message: "...", data: { ... } }`, v2 returns the model
 * directly. v1 also returns `status_code` in the body; we surface any
 * non-2xx upstream status as an error.
 *
 * @param {object} resp - Parsed JSON body.
 * @param {'v1'|'v2'} db
 * @returns {object} Plain section data (e.g. a Subject or Procedures object).
 */
export function extractServicePayload(resp, db) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('Empty response from metadata service');
  }
  if (db === 'v1') {
    if ('data' in resp) {
      if (resp.data == null) {
        const msg = resp.message || 'Metadata service returned no data';
        throw new Error(msg);
      }
      return resp.data;
    }
    return resp;
  }
  // v2: object returned directly. Detect FastAPI-style error envelopes that
  // have NO usable data field (just a string detail with no object body).
  if (resp.detail && typeof resp.detail === 'string' && Object.keys(resp).length === 1) {
    throw new Error(resp.detail);
  }
  return resp;
}

/**
 * Recursively compute a row-level diff between two JSON values.
 *
 * Produces a flat list of {path, kind, oldValue, newValue} entries where
 * kind is one of 'added' | 'removed' | 'changed'. Subtrees that are equal
 * (per canonical JSON) are skipped entirely.
 *
 * @param {*} oldVal
 * @param {*} newVal
 * @param {string[]} [path]
 * @returns {Array<{path:string,kind:string,oldValue:*,newValue:*}>}
 */
export function diffJson(oldVal, newVal, path = []) {
  if (deepEqual(oldVal, newVal)) return [];

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // Recurse into objects.
  if (isObj(oldVal) && isObj(newVal)) {
    const out = [];
    const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
    const sorted = [...keys].sort();
    for (const k of sorted) {
      out.push(...diffJson(oldVal[k], newVal[k], [...path, k]));
    }
    return out;
  }

  // Recurse element-wise into arrays of equal length; otherwise treat as a
  // single replacement (arrays whose length differs are nearly always a
  // wholesale change for our purposes).
  if (Array.isArray(oldVal) && Array.isArray(newVal) && oldVal.length === newVal.length) {
    const out = [];
    for (let i = 0; i < oldVal.length; i++) {
      out.push(...diffJson(oldVal[i], newVal[i], [...path, `[${i}]`]));
    }
    return out;
  }

  const pathStr = path.join('.') || '(root)';
  if (oldVal === undefined) return [{ path: pathStr, kind: 'added', oldValue: undefined, newValue: newVal }];
  if (newVal === undefined) return [{ path: pathStr, kind: 'removed', oldValue: oldVal, newValue: undefined }];
  return [{ path: pathStr, kind: 'changed', oldValue: oldVal, newValue: newVal }];
}

/**
 * Format a value for display in the diff table — short scalars as-is, longer
 * objects/arrays as pretty JSON.
 */
export function formatDiffValue(v) {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const json = JSON.stringify(v, null, 2);
  return json;
}

/**
 * Build the merged candidate record: the current full asset with the chosen
 * top-level section (`subject` or `procedures`) replaced.
 */
export function buildMergedRecord(currentRecord, section, newValue) {
  if (!currentRecord) return null;
  return { ...currentRecord, [section]: newValue };
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function fetchFullRecord(db, assetId, signal) {
  const records = await queryDocDb(
    { _id: assetId },
    { baseUrl: DOCDB_BASES[db], limit: 1, signal },
  );
  if (!records.length) throw new Error(`Asset "${assetId}" not found in DocDB ${db}.`);
  return records[0];
}

async function fetchMetadataServiceSection(db, endpoint, subjectId, signal) {
  const path = METADATA_SERVICE_PATHS[db][endpoint](subjectId);
  const resp = await fetch(path, { signal });
  if (!resp.ok) {
    if (resp.status === 502) {
      throw new Error('You must be on the Allen Institute internal network or VPN to use the migration tools');
    }
    let text = '';
    try { text = await resp.text(); } catch { /* ignore */ }
    throw new Error(`metadata service ${resp.status} ${resp.statusText}${text ? ` — ${text}` : ''}`);
  }
  const body = await resp.json();
  return extractServicePayload(body, db);
}

// ---------------------------------------------------------------------------
// Diff view component
// ---------------------------------------------------------------------------

function DiffView({ entries, title }) {
  if (!entries) return null;
  if (entries.length === 0) {
    return html`<p class="migrate-diff-empty">No differences — the asset already matches the metadata service.</p>`;
  }
  return html`
    <div class="migrate-diff">
      ${title ? html`<h3 class="migrate-diff-title">${title}</h3>` : null}
      <table class="data-table migrate-diff-table">
        <thead>
          <tr>
            <th>Path</th>
            <th>Kind</th>
            <th>Old value</th>
            <th>New value</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(
            (e) => html`
              <tr class=${`migrate-diff-${e.kind}`}>
                <td class="migrate-diff-path">${e.path}</td>
                <td class="migrate-diff-kind">${e.kind}</td>
                <td><pre class="migrate-diff-value">${formatDiffValue(e.oldValue)}</pre></td>
                <td><pre class="migrate-diff-value">${formatDiffValue(e.newValue)}</pre></td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
}

// ---------------------------------------------------------------------------
// Top-level page component
// ---------------------------------------------------------------------------

export function MigratePage() {
  // ── URL-synced state ────────────────────────────────────────────────────
  const initial = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    const db = p.get('db') === 'v1' ? 'v1' : 'v2';
    const id = p.get('id') ?? '';
    const endpoint = ENDPOINTS.includes(p.get('endpoint')) ? p.get('endpoint') : 'subject';
    return { db, id, endpoint };
  }, []);

  const [db, setDb] = useState(initial.db);
  const [selectedId, setSelectedId] = useState(initial.id);
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [assetInput, setAssetInput] = useState(
    // pre-fill input from URL so shared links work
    () => new URLSearchParams(window.location.search).get('name') ?? initial.id,
  );

  // ── Selected record / candidate / diff ──────────────────────────────────
  const [currentRecord, setCurrentRecord] = useState(null);
  const [candidate, setCandidate] = useState(null);
  const [loadStatus, setLoadStatus] = useState('idle');  // idle | loading | ready | error
  const [loadError, setLoadError] = useState('');

  // ── Token + submission state ────────────────────────────────────────────
  const [token, setToken] = useState(() => readCookie('qc_auth_token'));
  const [tokenExpiresAt, setTokenExpiresAt] = useState(() => {
    const v = readCookie('qc_auth_token_expires_at');
    return v ? Number(v) * 1000 : null;
  });
  const [submitState, setSubmitState] = useState('idle');  // idle | submitting | pending | submitted | failed | error
  const [submitResult, setSubmitResult] = useState(null);
  const [submitError, setSubmitError] = useState('');

  // ── Track the originally observed record so we can highlight the change
  //    after the second-actor upsert completes.
  const [originalRecord, setOriginalRecord] = useState(null);

  // Keep URL in sync with state.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('db', db);
    if (selectedId) { url.searchParams.set('id', selectedId); url.searchParams.set('name', assetInput); }
    else { url.searchParams.delete('id'); url.searchParams.delete('name'); }
    if (endpoint) url.searchParams.set('endpoint', endpoint); else url.searchParams.delete('endpoint');
    history.replaceState({}, '', url);
  }, [db, selectedId, endpoint, assetInput]);

  // Watch the cookie — it may appear after the QC-portal redirect (token flow).
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

  // Load current record + candidate section whenever selectedId changes.
  // selectedId is only set when the user explicitly clicks "Fetch".
  useEffect(() => {
    if (!selectedId || !endpoint) {
      setCurrentRecord(null);
      setCandidate(null);
      setLoadStatus('idle');
      setLoadError('');
      return undefined;
    }
    const ctrl = new AbortController();
    setLoadStatus('loading');
    setLoadError('');
    setCurrentRecord(null);
    setCandidate(null);
    setSubmitState('idle');
    setSubmitResult(null);
    setSubmitError('');

    (async () => {
      try {
        // selectedId may be a name or a UUID; try name first, then _id.
        let record;
        const byName = await queryDocDb({ name: selectedId }, { baseUrl: DOCDB_BASES[db], limit: 1, signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        if (byName.length) {
          record = byName[0];
        } else {
          record = await fetchFullRecord(db, selectedId, ctrl.signal);
        }
        if (ctrl.signal.aborted) return;
        setCurrentRecord(record);
        // Remember the pre-submission state for the "final highlight" view.
        setOriginalRecord((prev) => prev ?? record);

        const subjectId = record?.subject?.subject_id;
        if (!subjectId) {
          throw new Error('Selected asset has no subject.subject_id — cannot query metadata service.');
        }
        const section = await fetchMetadataServiceSection(db, endpoint, subjectId, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setCandidate(section);
        setLoadStatus('ready');
      } catch (err) {
        if (ctrl.signal.aborted) return;
        console.error('[migrate] load failed:', err);
        setLoadError(err.message || String(err));
        setLoadStatus('error');
      }
    })();

    return () => ctrl.abort();
  }, [db, selectedId, endpoint]);

  // Derived: merged record and diffs.
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

  // After submission, periodically refresh the DocDB record so the page can
  // detect when the second approver lands and the upsert completes.
  useEffect(() => {
    if (submitState !== 'pending') return undefined;
    const id = setInterval(async () => {
      try {
        const fresh = await fetchFullRecord(db, selectedId);
        // Did the section change to match what we submitted?
        if (candidate && deepEqual(fresh[endpoint] ?? null, candidate)) {
          setCurrentRecord(fresh);
          setSubmitState('submitted');
          setSubmitResult((r) => r || { status: 'submitted', detected_via: 'polling' });
        }
      } catch (err) {
        console.debug('[migrate] poll failed:', err.message);
      }
    }, 10000);
    return () => clearInterval(id);
  }, [submitState, db, selectedId, candidate, endpoint]);

  // ── Action handlers ─────────────────────────────────────────────────────

  function handleFetch() {
    const name = assetInput.trim();
    if (!name) return;
    // Reset submission state and trigger the load effect.
    setSubmitState('idle');
    setSubmitResult(null);
    setSubmitError('');
    setOriginalRecord(null);
    setSelectedId(name);
  }

  function handleRequestToken() {
    if (!selectedId) return;
    const here = window.location.href;
    const url = `${QC_PORTAL_BASE}/metadata/token`
      + `?id=${encodeURIComponent(selectedId)}`
      + `&redirect=${encodeURIComponent(here)}`;
    window.location.assign(url);
  }

  async function handleSubmit() {
    if (!token || !merged) return;
    setSubmitState('submitting');
    setSubmitResult(null);
    setSubmitError('');
    try {
      const url = `${QC_PORTAL_BASE}/metadata/${db}?auth-token=${encodeURIComponent(token)}`;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(merged),
      });
      let body;
      try { body = await resp.json(); }
      catch { body = { error: await resp.text().catch(() => '') }; }

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
        // Refresh the record so finalDiff can highlight the change.
        try {
          const fresh = await fetchFullRecord(db, selectedId);
          setCurrentRecord(fresh);
        } catch { /* ignore */ }
      } else if (body?.status === 'failed') {
        setSubmitState('failed');
      } else {
        setSubmitState('error');
        setSubmitError('Unexpected response from QC portal.');
      }
    } catch (err) {
      console.error('[migrate] submit failed:', err);
      setSubmitState('error');
      setSubmitError(err.message || String(err));
    }
  }

  function handleCopyUrl() {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  }

  // ── Render ─────────────────────────────────────────────────────────────

  const tokenLabel = token
    ? (tokenExpiresAt ? `Submit (token expires ${new Date(tokenExpiresAt).toLocaleString()})` : 'Submit')
    : 'Validate token';

  return html`
    <div class="migrate-page">
      <h1>Two-actor metadata migration</h1>
      <p class="migrate-intro">
        Repair a DocDB record by pulling <code>subject.json</code> or
        <code>procedures.json</code> from the internal
        <code>aind-metadata-service</code>, then push the merged record to
        DocDB via the QC portal's two-party token flow. Two distinct
        QC-portal-authenticated users must each submit byte-identical payloads
        before the upsert is applied.
      </p>

      <section class="migrate-section">
        <div class="migrate-controls-row">
          <div class="migrate-control">
            <label>Database</label>
            <div class="migrate-toggle" role="group" aria-label="Database version">
              ${['v1', 'v2'].map(
                (d) => html`
                  <button
                    class=${`migrate-toggle-btn ${db === d ? 'is-active' : ''}`}
                    onClick=${() => setDb(d)}
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
                <div><strong>_id:</strong> <code>${selectedId}</code></div>
                ${currentRecord
                  ? html`
                      <div><strong>name:</strong> ${currentRecord.name ?? '—'}</div>
                      <div><strong>subject_id:</strong> ${currentRecord?.subject?.subject_id ?? '—'}</div>
                    `
                  : null}
              </div>

              ${loadStatus === 'loading'
                ? html`<p class="loading-message">Fetching from DocDB + metadata service${endpoint === 'procedures' ? ' (procedures can take ~45s)' : ''}…</p>`
                : null}

              ${loadStatus === 'ready'
                ? html`
                    <${DiffView}
                      entries=${sectionDiff}
                      title=${`Changes to '${endpoint}' if submitted`}
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
                    </div>

                    ${submitState === 'pending'
                      ? html`
                          <div class="migrate-submit-banner migrate-pending">
                            <strong>1/2 — awaiting second approver.</strong>
                            ${submitResult?.expires_at
                              ? html` Token expires ${new Date(submitResult.expires_at * 1000).toLocaleString()}.`
                              : null}
                            Share this URL with the second person, who must visit it, click
                            "Validate token", then "Submit".
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
                            Tokens are NOT consumed; the second approver can retry.
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


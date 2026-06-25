/**
 * migrate/review-view.js — Second-actor /migrate/review page.
 *
 * Lists all pending metadata migrations from the QC portal (combined across
 * v1 and v2 DocDB), lets the user open one in a detail pane, diff the
 * proposed body against the live record, and approve as the second of two
 * required QC-portal-authenticated users. After approval the page polls
 * DocDB for ~10 seconds to confirm the upsert landed, then displays the
 * actual diff applied — without clearing the detail pane, so the reviewer
 * can close it and move on to the next pending entry.
 *
 * URL params:
 *   ?focus=<body_hash>  Highlights / auto-opens a specific pending entry.
 */

import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { QC_PORTAL_BASE } from '../constants.js';
import {
  canonicalJson,
  deepEqual,
  diffJson,
  DiffView,
  fetchFullRecord,
  readCookie,
  topLevelChangedSections,
} from './lib.js';

const POLL_INTERVAL_MS = 10000;
const POST_SUBMIT_DELAY_MS = 2000;
const POST_SUBMIT_RETRIES = 5;

async function fetchAllPending(signal) {
  const resp = await fetch(`${QC_PORTAL_BASE}/metadata/pending`, {
    credentials: 'include',
    signal,
  });
  if (!resp.ok) throw new Error(`QC portal pending list HTTP ${resp.status}`);
  const body = await resp.json();
  return Array.isArray(body?.pending) ? body.pending : [];
}

export function MigrateReviewPage() {
  const [pending, setPending] = useState([]);
  const [listStatus, setListStatus] = useState('idle');
  const [listError, setListError] = useState('');

  const initialFocus = useMemo(() => {
    return new URLSearchParams(window.location.search).get('focus') ?? null;
  }, []);
  const [openHash, setOpenHash] = useState(initialFocus);

  const [token, setToken] = useState(() => readCookie('qc_auth_token'));
  const [tokenExpiresAt, setTokenExpiresAt] = useState(() => {
    const v = readCookie('qc_auth_token_expires_at');
    return v ? Number(v) * 1000 : null;
  });

  // Keep a stable map of details by body_hash so review state survives list
  // refreshes (e.g. once an entry is upserted it disappears from /pending but
  // we want to keep the "confirmed" detail panel open).
  // detail entries: { entry, currentRecord, originalRecord, status, error, submitResult }
  const [details, setDetails] = useState(/** @type {Record<string, any>} */ ({}));

  useEffect(() => {
    const url = new URL(window.location.href);
    if (openHash) url.searchParams.set('focus', openHash);
    else url.searchParams.delete('focus');
    history.replaceState({}, '', url);
  }, [openHash]);

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

  async function refreshList(signal) {
    setListStatus('loading');
    setListError('');
    try {
      const items = await fetchAllPending(signal);
      if (signal?.aborted) return;
      setPending(items);
      setListStatus('ready');
    } catch (err) {
      if (signal?.aborted) return;
      console.error('[migrate/review] list failed:', err);
      setListError(err.message || String(err));
      setListStatus('error');
    }
  }

  useEffect(() => {
    const ctrl = new AbortController();
    refreshList(ctrl.signal);
    const id = setInterval(() => refreshList(ctrl.signal), POLL_INTERVAL_MS);
    return () => { ctrl.abort(); clearInterval(id); };
  }, []);

  // Load the current DocDB record for any newly opened detail.
  useEffect(() => {
    if (!openHash) return undefined;
    const entry = pending.find((p) => p.body_hash === openHash);
    // If the entry has disappeared (e.g. already upserted) but we have a
    // cached detail (from a previous submission), keep showing it.
    if (!entry) return undefined;

    // Avoid re-loading if we already loaded this hash.
    const existing = details[openHash];
    if (existing && existing.currentRecord) return undefined;

    const ctrl = new AbortController();
    setDetails((d) => ({
      ...d,
      [openHash]: { ...(d[openHash] ?? {}), entry, status: 'loading' },
    }));

    (async () => {
      try {
        const current = await fetchFullRecord(entry.version, entry.id, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setDetails((d) => ({
          ...d,
          [openHash]: {
            ...(d[openHash] ?? {}),
            entry,
            currentRecord: current,
            originalRecord: current,
            status: 'ready',
          },
        }));
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setDetails((d) => ({
          ...d,
          [openHash]: {
            ...(d[openHash] ?? {}),
            entry,
            status: 'load-error',
            error: err.message || String(err),
          },
        }));
      }
    })();

    return () => ctrl.abort();
  }, [openHash, pending]);

  function handleRequestToken(entry) {
    if (!entry) return;
    const url = new URL(window.location.href);
    url.searchParams.set('focus', entry.body_hash);
    const tokenUrl = `${QC_PORTAL_BASE}/metadata/token`
      + `?id=${encodeURIComponent(entry.id)}`
      + `&redirect=${encodeURIComponent(url.toString())}`;
    window.location.assign(tokenUrl);
  }

  async function pollForUpsert(entry, expectedBody) {
    for (let i = 0; i < POST_SUBMIT_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, POST_SUBMIT_DELAY_MS));
      try {
        const fresh = await fetchFullRecord(entry.version, entry.id);
        if (deepEqual(fresh, expectedBody) || deepEqual(stripVolatile(fresh), stripVolatile(expectedBody))) {
          return { matched: true, record: fresh };
        }
        // Last resort: capture freshest record to display even if mismatched.
        if (i === POST_SUBMIT_RETRIES - 1) return { matched: false, record: fresh };
      } catch (err) {
        if (i === POST_SUBMIT_RETRIES - 1) return { matched: false, error: err };
      }
    }
    return { matched: false };
  }

  async function handleApprove(entry) {
    const hash = entry.body_hash;
    if (!token) { handleRequestToken(entry); return; }

    setDetails((d) => ({
      ...d,
      [hash]: { ...(d[hash] ?? { entry }), status: 'submitting', error: '' },
    }));

    try {
      const url = `${QC_PORTAL_BASE}/metadata/${entry.version}?auth-token=${encodeURIComponent(token)}`;
      const resp = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry.body),
      });
      let body;
      try { body = await resp.json(); }
      catch { body = { error: await resp.text().catch(() => '') }; }

      if (!resp.ok) {
        setDetails((d) => ({
          ...d,
          [hash]: {
            ...(d[hash] ?? { entry }),
            status: 'error',
            submitResult: body,
            error: `HTTP ${resp.status}: ${body?.error || body?.detail || JSON.stringify(body)}`,
          },
        }));
        return;
      }

      if (body?.status === 'pending') {
        // Should be rare on review (first submitter already counted), but
        // possible if the original submitter approved their own request.
        setDetails((d) => ({
          ...d,
          [hash]: {
            ...(d[hash] ?? { entry }),
            status: 'still-pending',
            submitResult: body,
          },
        }));
        return;
      }

      if (body?.status === 'failed') {
        setDetails((d) => ({
          ...d,
          [hash]: {
            ...(d[hash] ?? { entry }),
            status: 'failed',
            submitResult: body,
          },
        }));
        return;
      }

      // status === 'submitted' — verify upsert by re-pulling.
      setDetails((d) => ({
        ...d,
        [hash]: {
          ...(d[hash] ?? { entry }),
          status: 'verifying',
          submitResult: body,
        },
      }));

      const { matched, record, error } = await pollForUpsert(entry, entry.body);
      setDetails((d) => ({
        ...d,
        [hash]: {
          ...(d[hash] ?? { entry }),
          status: matched ? 'confirmed' : 'verification-mismatch',
          currentRecord: record ?? d[hash]?.currentRecord ?? null,
          submitResult: body,
          error: error ? (error.message || String(error)) : '',
        },
      }));
    } catch (err) {
      console.error('[migrate/review] submit failed:', err);
      setDetails((d) => ({
        ...d,
        [hash]: {
          ...(d[hash] ?? { entry }),
          status: 'error',
          error: err.message || String(err),
        },
      }));
    }
  }

  function handleClose(hash) {
    if (openHash === hash) setOpenHash(null);
    setDetails((d) => {
      const next = { ...d };
      delete next[hash];
      return next;
    });
  }

  const tokenLabel = token
    ? (tokenExpiresAt ? `token valid · expires ${new Date(tokenExpiresAt).toLocaleString()}` : 'token valid')
    : 'no token (will redirect to validate)';

  return html`
    <div class="migrate-page">
      <h1>Review pending migrations</h1>
      <p class="migrate-intro">
        Every pending metadata migration submitted via
        <a href="/migrate/submit">/migrate/submit</a> shows up here. Open one
        to diff the proposed change against the live DocDB record, then
        approve as the second of two required QC-portal users. Approved
        upserts are verified against DocDB before the panel marks them
        confirmed.
        <br/><span class="text-secondary">Token status: ${tokenLabel}.</span>
      </p>

      <section class="migrate-section">
        <div class="migrate-controls-row">
          <button class="btn-secondary" onClick=${() => refreshList()}>
            ${listStatus === 'loading' ? 'Refreshing…' : 'Refresh list'}
          </button>
          <a class="btn-secondary" href="/migrate/submit">Open submit page →</a>
        </div>
        ${listStatus === 'error'
          ? html`<p class="error-banner" style="margin-top:8px">${listError}</p>`
          : null}
      </section>

      <section class="migrate-section">
        <h2>Pending (${pending.length})</h2>
        ${pending.length === 0
          ? html`<p class="migrate-empty">${listStatus === 'loading' ? 'Loading…' : 'No pending migrations.'}</p>`
          : html`
              <div class="migrate-table-responsive">
                <table class="data-table migrate-table">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Asset</th>
                      <th>_id</th>
                      <th>Changed sections</th>
                      <th>Submissions</th>
                      <th>Hash</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${pending.map((p) => {
                      const open = openHash === p.body_hash;
                      const detail = details[p.body_hash];
                      const sections = detail?.originalRecord
                        ? topLevelChangedSections(detail.originalRecord, p.body).join(', ')
                        : '—';
                      const name = p.body?.name ?? '—';
                      return html`
                        <tr
                          key=${p.body_hash}
                          class=${open ? 'migrate-row-selected' : ''}
                          onClick=${() => setOpenHash(open ? null : p.body_hash)}
                        >
                          <td>${p.version}</td>
                          <td>${name}</td>
                          <td class="migrate-id-cell">${p.id}</td>
                          <td>${sections}</td>
                          <td>${p.submissions}/${p.required ?? 2}</td>
                          <td class="migrate-id-cell">${p.body_hash.slice(0, 10)}…</td>
                          <td>
                            <button class="btn-secondary" onClick=${(e) => { e.stopPropagation(); setOpenHash(open ? null : p.body_hash); }}>
                              ${open ? 'Close' : 'Review'}
                            </button>
                          </td>
                        </tr>
                      `;
                    })}
                  </tbody>
                </table>
              </div>
            `}
      </section>

      ${Object.entries(details)
        .filter(([_, d]) => d && d.entry)
        .map(([hash, d]) => html`
          <${ReviewDetail}
            key=${hash}
            detail=${d}
            isOpen=${openHash === hash}
            token=${token}
            onApprove=${() => handleApprove(d.entry)}
            onRequestToken=${() => handleRequestToken(d.entry)}
            onClose=${() => handleClose(hash)}
            onCopyUrl=${() => {
              const url = new URL(window.location.href);
              url.searchParams.set('focus', hash);
              navigator.clipboard.writeText(url.toString()).catch(() => {});
            }}
          />
        `)}
    </div>`;
}

/** Render one pending-entry detail panel. */
function ReviewDetail({ detail, isOpen, token, onApprove, onRequestToken, onClose, onCopyUrl }) {
  const { entry, currentRecord, originalRecord, status, error, submitResult } = detail;

  const proposed = entry.body;
  const liveDiff = useMemo(
    () => (currentRecord ? diffJson(currentRecord, proposed) : null),
    [currentRecord, proposed],
  );
  const appliedDiff = useMemo(
    () => (originalRecord && currentRecord && originalRecord !== currentRecord
      ? diffJson(originalRecord, currentRecord)
      : null),
    [originalRecord, currentRecord],
  );

  const submitting = status === 'submitting' || status === 'verifying';
  const isConfirmed = status === 'confirmed';
  const isMismatched = status === 'verification-mismatch';
  const actionLabel = !token
    ? 'Validate token (second approver)'
    : isConfirmed ? 'Approved ✓'
    : submitting ? (status === 'verifying' ? 'Verifying…' : 'Submitting…')
    : 'Approve (consume second token)';

  return html`
    <section
      class="migrate-section"
      style=${isOpen ? '' : 'display:none'}
    >
      <h2>
        Review:
        <code style="font-weight:normal">${entry.body?.name ?? entry.id}</code>
        <span class="text-secondary" style="font-weight:400; font-size:0.85em; margin-left:8px;">
          (${entry.version} · _id ${entry.id} · ${entry.submissions}/${entry.required ?? 2})
        </span>
      </h2>

      ${status === 'loading'
        ? html`<p class="loading-message">Fetching live DocDB record…</p>`
        : null}

      ${status === 'load-error'
        ? html`<p class="error-banner">Failed to load current DocDB record: ${error}</p>`
        : null}

      ${currentRecord
        ? html`
            <div class="migrate-selected">
              <div><strong>name:</strong> ${currentRecord.name ?? '—'}</div>
              <div><strong>subject_id:</strong> ${currentRecord?.subject?.subject_id ?? '—'}</div>
              <div><strong>changed top-level sections:</strong>
                ${(() => {
                  const sections = originalRecord
                    ? topLevelChangedSections(originalRecord, proposed)
                    : [];
                  return sections.length ? sections.join(', ') : '—';
                })()}
              </div>
            </div>

            <${DiffView}
              entries=${liveDiff}
              title="Diff of proposed body vs current DocDB record"
            />

            <div class="migrate-submit-row">
              <button
                class=${`${token && !isConfirmed && !submitting ? 'btn-primary' : 'btn-secondary'} migrate-action-btn`}
                onClick=${token ? onApprove : onRequestToken}
                disabled=${submitting || isConfirmed}
              >${actionLabel}</button>
              <button class="btn-secondary" onClick=${onCopyUrl}>Copy review URL</button>
              <button class="btn-secondary" onClick=${onClose}>Close</button>
            </div>

            ${status === 'still-pending'
              ? html`
                  <div class="migrate-submit-banner migrate-pending">
                    <strong>Still 1/2.</strong> The QC portal recorded your
                    submission but a second distinct user is still required.
                    This usually means you are the same user as the first
                    submitter — ask a different QC-portal user to approve.
                    <pre class="migrate-submit-detail">${JSON.stringify(submitResult, null, 2)}</pre>
                  </div>`
              : null}

            ${isConfirmed
              ? html`
                  <div class="migrate-submit-banner migrate-success">
                    <strong>✓ Upsert applied and confirmed.</strong>
                    ${submitResult?.docdb_status
                      ? html` DocDB status: ${submitResult.docdb_status}.`
                      : null}
                    ${appliedDiff
                      ? html`<${DiffView} entries=${appliedDiff} title="Actual changes applied to DocDB" />`
                      : null}
                  </div>`
              : null}

            ${isMismatched
              ? html`
                  <div class="migrate-submit-banner migrate-failed">
                    <strong>⚠ Upsert reported success but the live record
                    does not match the submitted body.</strong> The verification
                    re-pull found a record but its contents differ from the
                    approved payload. Inspect manually before closing.
                    ${error ? html`<div>${error}</div>` : null}
                    ${appliedDiff
                      ? html`<${DiffView} entries=${appliedDiff} title="What actually changed in DocDB" />`
                      : null}
                  </div>`
              : null}

            ${status === 'failed'
              ? html`
                  <div class="migrate-submit-banner migrate-failed">
                    <strong>DocDB upsert failed.</strong>
                    ${submitResult?.docdb_status ? html` Status ${submitResult.docdb_status}.` : null}
                    Tokens are NOT consumed; another reviewer can retry.
                    <pre class="migrate-submit-detail">${JSON.stringify(submitResult, null, 2)}</pre>
                  </div>`
              : null}

            ${status === 'error'
              ? html`
                  <div class="migrate-submit-banner migrate-error">
                    <strong>Submission error.</strong> ${error}
                    ${submitResult
                      ? html`<pre class="migrate-submit-detail">${JSON.stringify(submitResult, null, 2)}</pre>`
                      : null}
                  </div>`
              : null}
          `
        : null}
    </section>
  `;
}

/** Drop fields that DocDB / pydantic models frequently rewrite (timestamps,
 * derived hashes). Keeps the verification step from spuriously reporting a
 * mismatch when the only diffs are server-rewritten metadata.
 */
function stripVolatile(record) {
  if (!record || typeof record !== 'object') return record;
  const out = { ...record };
  for (const k of ['last_modified', 'created', 'object_hash', '_id_hash']) {
    if (k in out) delete out[k];
  }
  // Also strip last_modified inside nested top-level objects.
  for (const [k, v] of Object.entries(out)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'last_modified' in v) {
      const inner = { ...v };
      delete inner.last_modified;
      out[k] = inner;
    }
  }
  // Re-canonicalize so deepEqual on the result is order-stable.
  return JSON.parse(canonicalJson(out));
}

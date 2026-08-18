/**
 * migrate/review-view.js — Second-actor /migrate/review page.
 *
 * Lists metadata proposals stored on the QC portal, lets a reviewer diff one
 * against the record it was based on, and approve it in a single click. The
 * approval sends back the `body_hash` that was displayed, so "approved" always
 * means "approved *this* payload"; the portal re-checks that hash, that the
 * reviewer is not the author, and that DocDB has not moved since the proposal
 * was made, then performs the upsert itself.
 *
 * If DocDB has moved, approval is refused and the reviewer is offered a
 * rebase: the author's changed sections are re-applied onto the current record
 * as a fresh proposal that supersedes the stale one.
 *
 * URL params:
 *   ?focus=<proposal_id>  Highlights / auto-opens a specific proposal.
 */

import { html } from 'htm/preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { getQcUser, loginToQcPortal, logoutQcPortal } from '../lib/qc-auth.js';
import {
  approveProposal,
  createProposal,
  deepEqual,
  diffJson,
  DiffView,
  fetchFullRecord,
  formatProposalTime,
  listProposals,
  QcLoginBar,
  rebaseOntoCurrent,
  rejectProposal,
  StatusPill,
  topLevelChangedSections,
  withdrawProposal,
} from './lib.js';

const REFRESH_INTERVAL_MS = 30000;

const FILTERS = [
  { key: 'open', label: 'Open', status: 'open' },
  { key: 'mine', label: 'Mine', status: 'all' },
  { key: 'closed', label: 'Applied / rejected', status: 'applied,rejected,withdrawn,superseded' },
  { key: 'all', label: 'All', status: 'all' },
];

export function MigrateReviewPage() {
  const [filter, setFilter] = useState('open');
  const [proposals, setProposals] = useState([]);
  const [listStatus, setListStatus] = useState('idle');
  const [listError, setListError] = useState('');

  const initialFocus = useMemo(
    () => new URLSearchParams(window.location.search).get('focus') ?? null,
    [],
  );
  const [openId, setOpenId] = useState(initialFocus);

  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading');

  // Per-proposal review state, keyed by proposal_id:
  //   { live, liveStatus, liveError, action, error, drift, result }
  const [details, setDetails] = useState({});

  useEffect(() => {
    const url = new URL(window.location.href);
    if (openId) url.searchParams.set('focus', openId);
    else url.searchParams.delete('focus');
    history.replaceState({}, '', url);
  }, [openId]);

  const refreshUser = useCallback(async () => {
    const me = await getQcUser();
    setUser(me?.user ?? null);
    setAuthStatus('ready');
  }, []);

  useEffect(() => { refreshUser(); }, [refreshUser]);

  const activeFilter = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];

  const refreshList = useCallback(async (signal) => {
    setListStatus('loading');
    setListError('');
    try {
      const items = await listProposals({ status: activeFilter.status, signal });
      if (signal?.aborted) return;
      setProposals(items);
      setListStatus('ready');
    } catch (err) {
      if (signal?.aborted) return;
      console.error('[migrate/review] list failed:', err);
      setListError(err.message || String(err));
      setListStatus('error');
    }
  }, [activeFilter.status]);

  useEffect(() => {
    const ctrl = new AbortController();
    refreshList(ctrl.signal);
    const id = setInterval(() => refreshList(ctrl.signal), REFRESH_INTERVAL_MS);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [refreshList]);

  const visible = useMemo(
    () => (filter === 'mine' ? proposals.filter((p) => p.author === user) : proposals),
    [filter, proposals, user],
  );

  const open = useMemo(
    () => proposals.find((p) => p.proposal_id === openId) ?? null,
    [proposals, openId],
  );

  // Pull the live DocDB record for whichever proposal is open, so drift is
  // visible before the reviewer clicks anything.
  useEffect(() => {
    if (!open) return undefined;
    const pid = open.proposal_id;
    if (details[pid]?.live || details[pid]?.liveStatus === 'loading') return undefined;

    const ctrl = new AbortController();
    patchDetail(pid, { liveStatus: 'loading', liveError: '' });
    (async () => {
      try {
        const live = await fetchFullRecord(open.version, open.record_id, ctrl.signal);
        if (ctrl.signal.aborted) return;
        patchDetail(pid, { live, liveStatus: 'ready' });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        patchDetail(pid, { liveStatus: 'error', liveError: err.message || String(err) });
      }
    })();
    return () => ctrl.abort();
  }, [open]);

  function patchDetail(pid, patch) {
    setDetails((d) => ({ ...d, [pid]: { ...(d[pid] ?? {}), ...patch } }));
  }

  function requireLogin() {
    if (user) return true;
    loginToQcPortal();
    return false;
  }

  async function handleApprove(proposal) {
    if (!requireLogin()) return;
    const pid = proposal.proposal_id;
    patchDetail(pid, { action: 'approving', error: '', drift: null });
    try {
      const result = await approveProposal(pid, proposal.body_hash);
      patchDetail(pid, { action: 'applied', result });
      refreshList();
    } catch (err) {
      console.error('[migrate/review] approve failed:', err);
      if (err.code === 'base_drift') {
        patchDetail(pid, {
          action: 'drift',
          drift: err.payload.current ?? null,
          live: err.payload.current ?? null,
          error: err.payload.detail || 'The DocDB record changed after this proposal was made.',
        });
        return;
      }
      if (err.code === 'not_authenticated') { loginToQcPortal(); return; }
      patchDetail(pid, { action: 'error', error: err.payload?.detail || err.message || String(err) });
      if (err.code === 'not_open' || err.code === 'hash_mismatch') refreshList();
    }
  }

  async function handleReject(proposal, reason) {
    if (!requireLogin()) return;
    const pid = proposal.proposal_id;
    patchDetail(pid, { action: 'rejecting', error: '' });
    try {
      await rejectProposal(pid, reason);
      patchDetail(pid, { action: 'rejected' });
      refreshList();
    } catch (err) {
      patchDetail(pid, { action: 'error', error: err.payload?.detail || err.message || String(err) });
    }
  }

  async function handleWithdraw(proposal) {
    if (!requireLogin()) return;
    const pid = proposal.proposal_id;
    patchDetail(pid, { action: 'withdrawing', error: '' });
    try {
      await withdrawProposal(pid);
      patchDetail(pid, { action: 'withdrawn' });
      refreshList();
    } catch (err) {
      patchDetail(pid, { action: 'error', error: err.payload?.detail || err.message || String(err) });
    }
  }

  async function handleRebase(proposal, live) {
    if (!requireLogin()) return;
    const pid = proposal.proposal_id;
    patchDetail(pid, { action: 'rebasing', error: '' });
    try {
      const body = rebaseOntoCurrent(proposal.base, proposal.body, live);
      const created = await createProposal({
        version: proposal.version,
        id: proposal.record_id,
        body,
        note: proposal.note
          ? `${proposal.note} (rebased from ${pid})`
          : `Rebased from ${pid}`,
        supersedes: pid,
      });
      patchDetail(pid, { action: 'rebased', result: { proposal: created } });
      setOpenId(created.proposal_id);
      refreshList();
    } catch (err) {
      patchDetail(pid, { action: 'error', error: err.payload?.detail || err.message || String(err) });
    }
  }

  return html`
    <div class="migrate-page">
      <h1>Review metadata proposals</h1>
      <p class="migrate-intro">
        Every change submitted from <a href="/migrate/submit">/migrate/submit</a>
        waits here until a second QC-portal user approves it. Open one to see
        exactly what it changes, then approve — the portal writes to DocDB for
        you, after re-checking that the record has not moved in the meantime.
        You cannot approve your own proposal.
      </p>

      <${QcLoginBar}
        user=${user}
        status=${authStatus}
        onLogin=${() => loginToQcPortal()}
        onLogout=${() => logoutQcPortal(refreshUser)}
      />

      <section class="migrate-section">
        <div class="migrate-controls-row">
          <div class="migrate-toggle" role="group" aria-label="Filter">
            ${FILTERS.map(
              (f) => html`
                <button
                  class=${`migrate-toggle-btn ${filter === f.key ? 'is-active' : ''}`}
                  onClick=${() => setFilter(f.key)}
                >${f.label}</button>`,
            )}
          </div>
          <button class="btn-secondary" onClick=${() => refreshList()}>
            ${listStatus === 'loading' ? 'Refreshing…' : 'Refresh'}
          </button>
          <a class="btn-secondary" href="/migrate/submit">Open submit page →</a>
        </div>
        ${listError
          ? html`<p class="error-banner" style="margin-top:8px">${listError}</p>`
          : null}
      </section>

      <section class="migrate-section">
        <h2>${activeFilter.label} (${visible.length})</h2>
        ${visible.length === 0
          ? html`<p class="migrate-empty">${listStatus === 'loading' ? 'Loading…' : 'Nothing here.'}</p>`
          : html`
              <div class="migrate-table-responsive">
                <table class="data-table migrate-table">
                  <thead>
                    <tr>
                      <th>Submitted</th>
                      <th>Author</th>
                      <th>DocDB</th>
                      <th>Asset</th>
                      <th>Changed sections</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${visible.map((p) => {
                      const isOpen = openId === p.proposal_id;
                      const sections = topLevelChangedSections(p.base, p.body).join(', ') || '—';
                      return html`
                        <tr
                          key=${p.proposal_id}
                          class=${isOpen ? 'migrate-row-selected' : ''}
                          onClick=${() => setOpenId(isOpen ? null : p.proposal_id)}
                        >
                          <td>${formatProposalTime(p.created_at)}</td>
                          <td>${p.author}</td>
                          <td>${p.version}</td>
                          <td>${p.record_name ?? p.record_id}</td>
                          <td>${sections}</td>
                          <td><${StatusPill} status=${p.status} /></td>
                          <td>
                            <button
                              class="btn-secondary"
                              onClick=${(e) => { e.stopPropagation(); setOpenId(isOpen ? null : p.proposal_id); }}
                            >${isOpen ? 'Close' : 'Review'}</button>
                          </td>
                        </tr>`;
                    })}
                  </tbody>
                </table>
              </div>`}
      </section>

      ${open
        ? html`
            <${ReviewDetail}
              key=${open.proposal_id}
              proposal=${open}
              detail=${details[open.proposal_id] ?? {}}
              user=${user}
              onApprove=${() => handleApprove(open)}
              onReject=${(reason) => handleReject(open, reason)}
              onWithdraw=${() => handleWithdraw(open)}
              onRebase=${(live) => handleRebase(open, live)}
              onClose=${() => setOpenId(null)}
            />`
        : null}
    </div>`;
}

/** Detail panel for one proposal. */
function ReviewDetail({ proposal, detail, user, onApprove, onReject, onWithdraw, onRebase, onClose }) {
  const { live, liveStatus, liveError, action, error, result } = detail;
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);

  const proposedDiff = useMemo(
    () => diffJson(proposal.base ?? null, proposal.body),
    [proposal],
  );
  // Drift is the same check the portal makes at approve time, surfaced early.
  const drifted = Boolean(live) && proposal.status === 'open' && !deepEqual(live, proposal.base);
  const driftDiff = useMemo(
    () => (drifted ? diffJson(proposal.base ?? null, live) : null),
    [drifted, proposal, live],
  );

  const busy = ['approving', 'rejecting', 'withdrawing', 'rebasing'].includes(action);
  const done = ['applied', 'rejected', 'withdrawn', 'rebased'].includes(action);
  const isAuthor = Boolean(user) && user === proposal.author;
  const closed = proposal.status !== 'open';

  const approveLabel = action === 'approving' ? 'Approving…'
    : action === 'applied' ? 'Applied ✓'
    : user ? 'Approve & apply'
    : 'Log in to approve';

  return html`
    <section class="migrate-section">
      <h2>
        Review:
        <code style="font-weight:normal">${proposal.record_name ?? proposal.record_id}</code>
        <span class="text-secondary" style="font-weight:400; font-size:0.85em; margin-left:8px;">
          (${proposal.version} · _id ${proposal.record_id} · by ${proposal.author} ·
          ${formatProposalTime(proposal.created_at)})
        </span>
      </h2>

      <div class="migrate-selected">
        <div><strong>status:</strong> <${StatusPill} status=${proposal.status} /></div>
        ${proposal.note ? html`<div><strong>note:</strong> ${proposal.note}</div>` : null}
        <div><strong>changed sections:</strong>
          ${topLevelChangedSections(proposal.base, proposal.body).join(', ') || '—'}</div>
        <div><strong>body hash:</strong> <code>${proposal.body_hash}</code></div>
        ${proposal.reviewer
          ? html`<div><strong>reviewed by:</strong> ${proposal.reviewer} (${formatProposalTime(proposal.reviewed_at)})</div>`
          : null}
        ${proposal.reason ? html`<div><strong>reason:</strong> ${proposal.reason}</div>` : null}
        ${proposal.superseded_by
          ? html`<div><strong>superseded by:</strong>
              <a href=${`/migrate/review?focus=${encodeURIComponent(proposal.superseded_by)}`}>${proposal.superseded_by}</a></div>`
          : null}
      </div>

      <${DiffView} entries=${proposedDiff} title="What this proposal changes" />

      ${liveStatus === 'loading'
        ? html`<p class="loading-message">Checking the live DocDB record…</p>`
        : null}
      ${liveStatus === 'error'
        ? html`<p class="warning-banner">Could not read the live DocDB record: ${liveError}</p>`
        : null}

      ${drifted
        ? html`
            <div class="migrate-submit-banner migrate-failed">
              <strong>⚠ The DocDB record changed after this proposal was made.</strong>
              Approving is blocked so the newer record is not clobbered. Rebase to
              re-apply the author's sections onto the current record as a new
              proposal — which then needs its own review.
              <${DiffView} entries=${driftDiff} title="What changed in DocDB since this proposal" />
              <div class="migrate-submit-row">
                <button class="btn-primary" disabled=${busy} onClick=${() => onRebase(live)}>
                  ${action === 'rebasing' ? 'Rebasing…' : 'Rebase onto current record'}
                </button>
              </div>
            </div>`
        : null}

      ${!closed
        ? html`
            <div class="migrate-submit-row">
              <button
                class="btn-primary migrate-action-btn"
                onClick=${onApprove}
                disabled=${busy || done || drifted || (isAuthor && Boolean(user))}
                title=${isAuthor ? 'You submitted this proposal — someone else has to approve it' : ''}
              >${approveLabel}</button>
              <button class="btn-secondary" disabled=${busy || done} onClick=${() => setRejecting((v) => !v)}>
                Reject…
              </button>
              ${isAuthor
                ? html`<button class="btn-secondary" disabled=${busy || done} onClick=${onWithdraw}>Withdraw</button>`
                : null}
              <button
                class="btn-secondary"
                onClick=${() => navigator.clipboard
                  .writeText(`${window.location.origin}/migrate/review?focus=${proposal.proposal_id}`)
                  .catch(() => {})}
              >Copy review URL</button>
              <button class="btn-secondary" onClick=${onClose}>Close</button>
            </div>

            ${isAuthor && user
              ? html`<p class="text-secondary" style="margin-top:8px">
                  You submitted this proposal — it needs a different QC-portal user to approve it.
                </p>`
              : null}

            ${rejecting
              ? html`
                  <div class="migrate-note-row">
                    <label for="migrate-reject-reason">Why are you rejecting this?</label>
                    <input
                      id="migrate-reject-reason"
                      type="text"
                      class="migrate-asset-input"
                      placeholder="e.g. the existing value is correct — the service pull is wrong"
                      value=${reason}
                      onInput=${(e) => setReason(e.currentTarget.value)}
                    />
                    <button class="btn-secondary" disabled=${busy} onClick=${() => onReject(reason)}>
                      ${action === 'rejecting' ? 'Rejecting…' : 'Confirm reject'}
                    </button>
                  </div>`
              : null}`
        : html`
            <div class="migrate-submit-row">
              <button class="btn-secondary" onClick=${onClose}>Close</button>
            </div>`}

      ${action === 'applied'
        ? html`
            <div class="migrate-submit-banner migrate-success">
              <strong>✓ Applied to DocDB.</strong>
              ${result?.proposal?.docdb_status ? html` DocDB status: ${result.proposal.docdb_status}.` : null}
            </div>`
        : null}

      ${action === 'rejected'
        ? html`<div class="migrate-submit-banner migrate-pending"><strong>Rejected.</strong></div>`
        : null}

      ${action === 'withdrawn'
        ? html`<div class="migrate-submit-banner migrate-pending"><strong>Withdrawn.</strong></div>`
        : null}

      ${action === 'rebased'
        ? html`
            <div class="migrate-submit-banner migrate-pending">
              <strong>Rebased.</strong> A new proposal has been opened against the
              current record and still needs review.
            </div>`
        : null}

      ${action === 'error' || (action === 'drift' && error)
        ? html`<div class="migrate-submit-banner migrate-error"><strong>Error.</strong> ${error}</div>`
        : null}
    </section>`;
}

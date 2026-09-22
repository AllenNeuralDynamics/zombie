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
import {
  accountDisplayName,
  getQcAccount,
  loginForQc,
  logoutQc,
} from '../lib/qc-spa-auth.js';
import {
  approveProposal,
  createProposal,
  deepEqual,
  diffJson,
  DiffView,
  fetchFullRecord,
  formatProposalTime,
  groupProposals,
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

  const [account, setAccount] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading');
  const user = account ? accountDisplayName(account) : null;

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
      setListError(error.message || String(error));
    });
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

  const groups = useMemo(() => groupProposals(visible), [visible]);
  const openGroup = useMemo(
    () => groups.find((group) => group.proposals.some((p) => p.proposal_id === openId)) ?? null,
    [groups, openId],
  );

  // Pull every live record in the open group, so a group approval still shows
  // which individual assets have drifted before any write is attempted.
  useEffect(() => {
    if (!openGroup) return undefined;
    const pending = openGroup.proposals.filter((proposal) => {
      const detail = details[proposal.proposal_id];
      return !detail?.live && !detail?.liveStatus;
    });
    if (!pending.length) return undefined;

    const ctrl = new AbortController();
    pending.forEach((proposal) => {
      patchDetail(proposal.proposal_id, { liveStatus: 'loading', liveError: '' });
    });
    (async () => {
      await Promise.all(pending.map(async (proposal) => {
        try {
          const live = await fetchFullRecord(proposal.version, proposal.record_id, ctrl.signal);
          if (ctrl.signal.aborted) return;
          patchDetail(proposal.proposal_id, { live, liveStatus: 'ready' });
        } catch (err) {
          if (ctrl.signal.aborted) return;
          patchDetail(proposal.proposal_id, { liveStatus: 'error', liveError: err.message || String(err) });
        }
      }));
    })();
    return () => ctrl.abort();
  }, [openGroup]);

  function patchDetail(pid, patch) {
    setDetails((d) => ({ ...d, [pid]: { ...(d[pid] ?? {}), ...patch } }));
  }

  function requireLogin() {
    if (user) return true;
    startLogin();
    return false;
  }

  function detailIsDrifted(proposal) {
    const live = details[proposal.proposal_id]?.live;
    return Boolean(live) && proposal.status === 'open' && !deepEqual(live, proposal.base);
  }

  function errorMessage(error) {
    return error.payload?.detail || error.message || String(error);
  }

  async function handleApprove(group) {
    if (!requireLogin()) return;
    const pending = group.proposals.filter((proposal) => (
      proposal.status === 'open'
      && proposal.author !== user
      && !detailIsDrifted(proposal)
    ));
    if (!pending.length) return;
    pending.forEach((proposal) => {
      patchDetail(proposal.proposal_id, { action: 'approving', error: '', drift: null });
    });
    const results = await Promise.allSettled(
      pending.map((proposal) => approveProposal(proposal.proposal_id, proposal.body_hash)),
    );
    let needsLogin = false;
    results.forEach((result, index) => {
      const proposal = pending[index];
      if (result.status === 'fulfilled') {
        patchDetail(proposal.proposal_id, { action: 'applied', result: result.value });
        return;
      }
      const err = result.reason;
      console.error('[migrate/review] approve failed:', err);
      if (err.code === 'base_drift') {
        patchDetail(proposal.proposal_id, {
          action: 'drift',
          drift: err.payload.current ?? null,
          live: err.payload.current ?? null,
          liveStatus: 'ready',
          error: err.payload.detail || 'The DocDB record changed after this proposal was made.',
        });
      } else {
        if (err.code === 'not_authenticated' || err.status === 401) needsLogin = true;
        patchDetail(proposal.proposal_id, { action: 'error', error: errorMessage(err) });
      }
    });
    if (needsLogin) startLogin();
    refreshList();
  }

  async function handleReject(group, reason) {
    if (!requireLogin()) return;
    const pending = group.proposals.filter((proposal) => proposal.status === 'open');
    pending.forEach((proposal) => patchDetail(proposal.proposal_id, { action: 'rejecting', error: '' }));
    const results = await Promise.allSettled(
      pending.map((proposal) => rejectProposal(proposal.proposal_id, reason)),
    );
    let needsLogin = false;
    results.forEach((result, index) => {
      const proposal = pending[index];
      if (result.status === 'fulfilled') patchDetail(proposal.proposal_id, { action: 'rejected' });
      else {
        const err = result.reason;
        if (err.code === 'not_authenticated' || err.status === 401) needsLogin = true;
        patchDetail(proposal.proposal_id, { action: 'error', error: errorMessage(err) });
      }
    });
    if (needsLogin) startLogin();
    refreshList();
  }

  async function handleWithdraw(group) {
    if (!requireLogin()) return;
    const pending = group.proposals.filter((proposal) => proposal.status === 'open' && proposal.author === user);
    pending.forEach((proposal) => patchDetail(proposal.proposal_id, { action: 'withdrawing', error: '' }));
    const results = await Promise.allSettled(
      pending.map((proposal) => withdrawProposal(proposal.proposal_id)),
    );
    let needsLogin = false;
    results.forEach((result, index) => {
      const proposal = pending[index];
      if (result.status === 'fulfilled') patchDetail(proposal.proposal_id, { action: 'withdrawn' });
      else {
        const err = result.reason;
        if (err.code === 'not_authenticated' || err.status === 401) needsLogin = true;
        patchDetail(proposal.proposal_id, { action: 'error', error: errorMessage(err) });
      }
    });
    if (needsLogin) startLogin();
    refreshList();
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
      if (err.code === 'not_authenticated' || err.status === 401) startLogin();
      patchDetail(pid, { action: 'error', error: errorMessage(err) });
    }
  }

  return html`
    <div class="migrate-page">
      <h1>Review metadata proposals</h1>
      <p class="migrate-intro">
        Every change submitted from <a href="/migrate/submit">/migrate/submit</a>
        waits here until a second QC-portal user approves it. Proposals with the
        same change are grouped so a subject-wide repair can be reviewed and
        approved together; each asset is still checked and written separately.
        You cannot approve your own proposal.
      </p>

      <${QcLoginBar}
        user=${user}
        status=${authStatus}
        onLogin=${startLogin}
        onLogout=${() => logoutQc()}
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
        <h2>${activeFilter.label} (${visible.length} proposals · ${groups.length} change groups)</h2>
        ${groups.length === 0
          ? html`<p class="migrate-empty">${listStatus === 'loading' ? 'Loading…' : 'Nothing here.'}</p>`
          : html`
              <div class="migrate-table-responsive">
                <table class="data-table migrate-table">
                  <thead>
                    <tr>
                      <th>Submitted</th>
                      <th>Assets</th>
                      <th>Author</th>
                      <th>DocDB</th>
                      <th>Changed sections</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${groups.map((group) => {
                      const first = group.proposals[0];
                      const isOpen = openGroup?.key === group.key;
                      const sections = [...new Set(group.proposals.flatMap((p) => topLevelChangedSections(p.base, p.body)))].join(', ') || '—';
                      const statuses = [...new Set(group.proposals.map((p) => p.status))];
                      const status = statuses.length === 1 ? statuses[0] : 'mixed';
                      const authors = [...new Set(group.proposals.map((p) => p.author))];
                      const firstAsset = first.record_name ?? first.record_id;
                      return html`
                        <tr
                          key=${group.key}
                          class=${isOpen ? 'migrate-row-selected' : ''}
                          onClick=${() => setOpenId(isOpen ? null : first.proposal_id)}
                        >
                          <td>${formatProposalTime(first.created_at)}</td>
                          <td>${group.proposals.length === 1 ? firstAsset : `${firstAsset} + ${group.proposals.length - 1} more`}</td>
                          <td>${authors.length === 1 ? authors[0] : `${authors.length} authors`}</td>
                          <td>${first.version}</td>
                          <td>${sections}</td>
                          <td><${StatusPill} status=${status} /></td>
                          <td>
                            <button
                              class="btn-secondary"
                              onClick=${(e) => { e.stopPropagation(); setOpenId(isOpen ? null : first.proposal_id); }}
                            >${isOpen ? 'Close' : 'Review'}</button>
                          </td>
                        </tr>`;
                    })}
                  </tbody>
                </table>
              </div>`}
      </section>

      ${openGroup
        ? html`
            <${ReviewGroupDetail}
              key=${openGroup.key}
              group=${openGroup}
              details=${details}
              user=${user}
              onApprove=${() => handleApprove(openGroup)}
              onReject=${(reason) => handleReject(openGroup, reason)}
              onWithdraw=${() => handleWithdraw(openGroup)}
              onRebase=${(proposal, live) => handleRebase(proposal, live)}
              onClose=${() => setOpenId(null)}
            />`
        : null}
    </div>`;
}

/** Detail panel for one or more proposals with the same proposed change. */
function ReviewGroupDetail({ group, details, user, onApprove, onReject, onWithdraw, onRebase, onClose }) {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const proposals = group.proposals;
  const first = proposals[0];
  const openProposals = proposals.filter((proposal) => proposal.status === 'open');
  const ownProposals = openProposals.filter((proposal) => proposal.author === user);
  const approvable = openProposals.filter((proposal) => (
    proposal.author !== user
    && !proposalIsDrifted(proposal, details[proposal.proposal_id])
  ));
  const busy = openProposals.some((proposal) => (
    ['approving', 'rejecting', 'withdrawing', 'rebasing'].includes(details[proposal.proposal_id]?.action)
  ));
  const checking = openProposals.some((proposal) => details[proposal.proposal_id]?.liveStatus === 'loading');
  const proposedDiff = useMemo(() => diffJson(first.base ?? null, first.body), [first]);
  const sections = [...new Set(proposals.flatMap((proposal) => topLevelChangedSections(proposal.base, proposal.body)))];
  const notes = [...new Set(proposals.map((proposal) => proposal.note).filter(Boolean))];
  const authors = [...new Set(proposals.map((proposal) => proposal.author))];
  const statusList = [...new Set(proposals.map((proposal) => proposal.status))];
  const status = statusList.length === 1 ? statusList[0] : 'mixed';

  return html`
    <section class="migrate-section">
      <h2>
        Review change across ${proposals.length} asset${proposals.length === 1 ? '' : 's'}
        <span class="text-secondary" style="font-weight:400; font-size:0.85em; margin-left:8px;">
          (${first.version} · ${authors.length === 1 ? `by ${authors[0]}` : `${authors.length} authors`})
        </span>
      </h2>

      <div class="migrate-selected">
        <div><strong>status:</strong> <${StatusPill} status=${status} /></div>
        <div><strong>changed sections:</strong> ${sections.join(', ') || '—'}</div>
        <div><strong>assets:</strong> ${proposals.length}</div>
        ${notes.length === 1 ? html`<div><strong>note:</strong> ${notes[0]}</div>` : null}
        ${notes.length > 1 ? html`<div><strong>notes:</strong> ${notes.length} different notes across this group</div>` : null}
      </div>

      <${DiffView} entries=${proposedDiff} title="Common change (shown for the first asset)" />

      <div class="migrate-table-responsive" style="max-height:420px; margin-top:16px">
        <table class="data-table migrate-table">
          <thead><tr><th>Asset</th><th>Author</th><th>Status</th><th>Live record</th><th></th></tr></thead>
          <tbody>
            ${proposals.map((proposal) => {
              const detail = details[proposal.proposal_id] ?? {};
              const drifted = proposalIsDrifted(proposal, detail);
              const action = detail.action;
              return html`
                <tr key=${proposal.proposal_id}>
                  <td>
                    <div>${proposal.record_name ?? proposal.record_id}</div>
                    <div class="migrate-id-cell">${proposal.record_id}</div>
                  </td>
                  <td>${proposal.author}</td>
                  <td><${StatusPill} status=${proposal.status} /></td>
                  <td>
                    ${detail.liveStatus === 'loading' ? 'checking…' : null}
                    ${detail.liveStatus === 'error' ? html`<span class="text-secondary">unavailable</span>` : null}
                    ${drifted ? html`<span style="color:var(--color-red)">changed since submission</span>` : null}
                    ${detail.liveStatus === 'ready' && !drifted ? 'unchanged' : null}
                  </td>
                  <td>
                    ${drifted && proposal.status === 'open'
                      ? html`<button
                          class="btn-secondary"
                          disabled=${busy || action === 'rebasing'}
                          onClick=${() => onRebase(proposal, detail.live)}
                        >${action === 'rebasing' ? 'Rebasing…' : 'Rebase'}</button>`
                      : null}
                    ${action === 'applied' ? html`<span class="text-secondary">Applied ✓</span>` : null}
                    ${action === 'rejected' ? html`<span class="text-secondary">Rejected</span>` : null}
                    ${action === 'withdrawn' ? html`<span class="text-secondary">Withdrawn</span>` : null}
                    ${detail.error ? html`<div class="migrate-id-cell" style="color:var(--color-red)">${detail.error}</div>` : null}
                  </td>
                </tr>`;
            })}
          </tbody>
        </table>
      </div>

      ${openProposals.length
        ? html`
            <div class="migrate-submit-row">
              <button
                class="btn-primary migrate-action-btn"
                onClick=${onApprove}
                disabled=${busy || checking || !approvable.length || !user}
              >${!user ? 'Log in to approve'
                : approvable.length === openProposals.length ? `Approve all ${approvable.length} & apply`
                : `Approve ${approvable.length} unchanged & apply`}</button>
              <button class="btn-secondary" disabled=${busy} onClick=${() => setRejecting((value) => !value)}>
                Reject all…
              </button>
              ${ownProposals.length
                ? html`<button class="btn-secondary" disabled=${busy} onClick=${onWithdraw}>
                    Withdraw my ${ownProposals.length}
                  </button>`
                : null}
              <button
                class="btn-secondary"
                onClick=${() => navigator.clipboard
                  .writeText(`${window.location.origin}/migrate/review?focus=${first.proposal_id}`)
                  .catch(() => {})}
              >Copy review URL</button>
              <button class="btn-secondary" onClick=${onClose}>Close</button>
            </div>
            ${ownProposals.length && user
              ? html`<p class="text-secondary" style="margin-top:8px">
                  Your ${ownProposals.length === 1 ? 'proposal is' : 'proposals are'} excluded from approval; a different QC-portal user must approve them.
                </p>`
              : null}
            ${checking
              ? html`<p class="loading-message">Checking the live DocDB records before approval…</p>`
              : null}
            ${rejecting
              ? html`
                  <div class="migrate-note-row">
                    <label for="migrate-reject-reason">Why are you rejecting these proposals?</label>
                    <input
                      id="migrate-reject-reason"
                      type="text"
                      class="migrate-asset-input"
                      placeholder="e.g. the existing values are correct"
                      value=${reason}
                      onInput=${(e) => setReason(e.currentTarget.value)}
                    />
                    <button class="btn-secondary" disabled=${busy} onClick=${() => onReject(reason)}>
                      ${busy ? 'Rejecting…' : `Reject ${openProposals.length}`}
                    </button>
                  </div>`
              : null}`
        : html`
            <div class="migrate-submit-row">
              <button class="btn-secondary" onClick=${onClose}>Close</button>
            </div>`}
    </section>`;
}

function proposalIsDrifted(proposal, detail) {
  return Boolean(detail?.live)
    && proposal.status === 'open'
    && !deepEqual(detail.live, proposal.base);
}

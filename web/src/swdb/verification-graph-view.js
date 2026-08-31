/**
 * swdb/verification-graph-view.js — the /swdb/verification-graph page shell.
 *
 * A knowledge graph of scientific statements where every statement is linked
 * to the evidence, code and lower-level statements behind it, and where the
 * record is always explicit about which kinds of verification it has passed.
 *
 * The shell is vanilla DOM: toolbar, graph container, detail drawer. Only the
 * graph itself is React (React Flow), lazy-imported through
 * `verification-graph/mount.js` so React stays out of the default bundle.
 *
 * Nodes are authored by an agent running on the client's own machine (see the
 * verification-graph skill), not from a panel on this page - this view is
 * read/verify/approve only.
 *
 * Selection round-trips through `?node=` so a statement is linkable.
 */

import { escHtml } from '../lib/utils.js';
import { getCurrentUser, loginWithOrcid, logout } from '../lib/auth.js';
import { createVerificationApi } from './verification-graph/api.js';
import {
  AXES,
  AXIS_MEANING,
  AXIS_STATUS_LABEL,
  STATUS_LABEL,
  filterSnapshot,
  indexSnapshot,
  statusCounts,
} from './verification-graph/model.js';

const JOB_POLL_MS = 3_000;

/**
 * Build the verification graph page.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator (unused today; the graph
 *   comes from the REST API, and the coordinator is here so the detail drawer
 *   can show a node's grounded data without a second bring-up).
 * @returns {HTMLElement}
 */
export function createVerificationGraphView(coord, metadata, { api = createVerificationApi() } = {}) {
  const root = document.createElement('div');
  root.className = 'vg-page';

  const state = {
    snapshot: null,
    filters: { verifiedOnly: false, status: '', query: '' },
    selectedId: new URLSearchParams(window.location.search).get('node'),
    user: null,
  };

  const toolbar = buildToolbar(state, () => render(), () => refreshDrawer());
  const graphEl = document.createElement('div');
  graphEl.className = 'vg-graph';
  graphEl.innerHTML = '<p class="vg-placeholder">Loading the graph…</p>';

  const drawer = document.createElement('aside');
  drawer.className = 'vg-drawer';

  const layout = document.createElement('div');
  layout.className = 'vg-layout';
  layout.append(graphEl, drawer);

  const jobsPanel = buildJobsPanel(api, state, {
    onSelectNode: (nodeId) => selectNode(nodeId),
    onGraphChange: () => refresh(),
  });

  root.append(toolbar.element, layout, jobsPanel.element);

  let mountGraph = null;

  function selectNode(nodeId) {
    state.selectedId = nodeId;
    setUrlParam('node', nodeId);
    render();
    if (nodeId) renderDrawer(drawer, nodeId, api, state, () => refresh());
    else drawer.innerHTML = '<p class="vg-placeholder">Select a node to see the evidence behind it.</p>';
  }

  function selectAxis(nodeId, axis) {
    selectNode(nodeId);
    drawer.dataset.axis = axis;
  }

  /** Re-render the open drawer's action buttons after the login state changes. */
  function refreshDrawer() {
    if (state.selectedId) renderDrawer(drawer, state.selectedId, api, state, () => refresh());
  }

  async function render() {
    if (!state.snapshot) return;
    toolbar.update(state.snapshot);
    const filtered = filterSnapshot(state.snapshot, state.filters);
    if (filtered.nodes.length === 0) {
      graphEl.innerHTML = state.snapshot.nodes?.length
        ? '<p class="vg-placeholder">Nothing matches these filters.</p>'
        : '<p class="vg-placeholder">The graph is empty. Author the first nodes with a local agent (see the verification-graph skill).</p>';
      return;
    }
    if (!mountGraph) {
      ({ mountVerificationGraph: mountGraph } = await import('./verification-graph/mount.js'));
      graphEl.innerHTML = '';
    }
    mountGraph(graphEl, {
      snapshot: filtered,
      selectedId: state.selectedId,
      onSelect: selectNode,
      onSelectAxis: selectAxis,
    });
  }

  async function refresh() {
    try {
      state.snapshot = await api.graph();
    } catch (error) {
      graphEl.innerHTML = `<p class="vg-error">Could not load the verification graph: ${escHtml(error.message)}</p>`;
      return;
    }
    await render();
    if (state.selectedId) renderDrawer(drawer, state.selectedId, api, state, () => refresh());
    else drawer.innerHTML = '<p class="vg-placeholder">Select a node to see the evidence behind it.</p>';
  }

  getCurrentUser().then((user) => {
    state.user = user;
    toolbar.updateUser(user);
    refreshDrawer();
  });

  refresh();
  return root;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function buildToolbar(state, onChange, onAuthChange) {
  const element = document.createElement('section');
  element.className = 'vg-toolbar';
  element.innerHTML = `
    <div class="vg-toolbar-controls">
      <input type="search" class="vg-search" placeholder="Search statements" aria-label="Search statements" />
      <select class="vg-status" aria-label="Filter by status">
        <option value="">All statuses</option>
        <option value="verified">Verified</option>
        <option value="proposed">Proposed</option>
        <option value="stale">Stale</option>
        <option value="failed">Failed</option>
      </select>
      <label class="vg-toggle"><input type="checkbox" class="vg-verified-only" /> Verified only</label>
      <div class="vg-toolbar-auth"></div>
    </div>
    <p class="vg-counts"></p>
  `;

  const search = element.querySelector('.vg-search');
  const status = element.querySelector('.vg-status');
  const verifiedOnly = element.querySelector('.vg-verified-only');
  const counts = element.querySelector('.vg-counts');
  const auth = element.querySelector('.vg-toolbar-auth');

  search.addEventListener('input', () => {
    state.filters.query = search.value;
    onChange();
  });
  status.addEventListener('change', () => {
    state.filters.status = status.value;
    onChange();
  });
  verifiedOnly.addEventListener('change', () => {
    state.filters.verifiedOnly = verifiedOnly.checked;
    status.disabled = verifiedOnly.checked;
    onChange();
  });

  function renderAuth(user) {
    if (!user) {
      auth.innerHTML = '<button type="button" class="vg-login">Log in with ORCID</button>';
      auth.querySelector('.vg-login').addEventListener('click', () => loginWithOrcid());
      return;
    }
    auth.innerHTML = `
      <span class="vg-toolbar-user">${escHtml(user.name || user.orcid)}</span>
      <button type="button" class="vg-logout">Log out</button>`;
    auth.querySelector('.vg-logout').addEventListener('click', () => {
      logout(() => {
        state.user = null;
        renderAuth(null);
        onAuthChange?.();
      });
    });
  }

  return {
    element,
    updateUser: renderAuth,
    update(snapshot) {
      const tally = statusCounts(snapshot);
      counts.textContent = Object.entries(tally)
        .filter(([, n]) => n > 0)
        .map(([key, n]) => `${n} ${STATUS_LABEL[key].toLowerCase()}`)
        .join(' · ') || 'No statements yet';
    },
  };
}

// ---------------------------------------------------------------------------
// Jobs panel
// ---------------------------------------------------------------------------

/** One line of plain-language result summary for a job row. */
function jobResultText(job) {
  if (job.state === 'failed') return job.error ?? 'failed';
  if (job.state === 'done' && job.result) {
    if (job.result.passed === true) return 'passed';
    if (job.result.passed === false) return `did not pass${job.result.note ? `: ${job.result.note}` : ''}`;
    return job.result.note ?? '';
  }
  return '';
}

function jobRowMarkup(job) {
  const nodeId = job.node_id ?? '';
  return `
    <tr class="vg-jobs-row vg-jobs-row--${escHtml(job.state)}">
      <td><button type="button" class="vg-jobs-node-link" data-node-id="${escHtml(nodeId)}">${escHtml(nodeId)}</button></td>
      <td>${escHtml(job.axis ?? '')}</td>
      <td><span class="vg-jobs-badge vg-jobs-badge--${escHtml(job.state)}">${escHtml(job.state)}</span></td>
      <td class="vg-jobs-result">${escHtml(jobResultText(job))}</td>
      <td>${escHtml(job.created ?? '')}</td>
      <td>${escHtml(job.finished ?? '')}</td>
    </tr>`;
}

/**
 * Build the bottom-of-page jobs panel: live status of every recent
 * verification run, plus bulk actions to queue many at once.
 *
 * The per-job detail here is deliberately shallow (state, pass/fail, one
 * error line) so a run of thousands is still scannable at a glance; the
 * "Node" link jumps to that node's drawer for the full log and run history,
 * which already exists there (see `wireRuns`).
 */
function buildJobsPanel(api, state, { onSelectNode, onGraphChange }) {
  const element = document.createElement('section');
  element.className = 'vg-jobs';
  element.innerHTML = `
    <header class="vg-jobs-header">
      <h2>Verification jobs</h2>
      <div class="vg-jobs-actions">
        <button type="button" class="vg-verify-all">Verify all</button>
        <button type="button" class="vg-verify-filtered">Verify filtered</button>
        <select class="vg-jobs-state" aria-label="Filter jobs by state">
          <option value="">All states</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
        </select>
        <span class="vg-jobs-status"></span>
      </div>
    </header>
    <div class="vg-jobs-table-wrap">
      <table class="vg-jobs-table">
        <thead>
          <tr><th>Node</th><th>Axis</th><th>State</th><th>Result</th><th>Queued</th><th>Finished</th></tr>
        </thead>
        <tbody><tr><td colspan="6" class="vg-placeholder">Loading…</td></tr></tbody>
      </table>
    </div>
  `;

  const statusEl = element.querySelector('.vg-jobs-status');
  const stateFilter = element.querySelector('.vg-jobs-state');
  const tbody = element.querySelector('tbody');
  const verifyAllBtn = element.querySelector('.vg-verify-all');
  const verifyFilteredBtn = element.querySelector('.vg-verify-filtered');

  // Only nodes whose jobs have actually finished can have a changed status -
  // remembering which job ids were already terminal on the last poll lets a
  // 3-second tick that changed nothing skip the graph/drawer refresh, instead
  // of yanking the user's pan/zoom and any open drawer state every tick.
  const seenTerminal = new Set();

  async function refreshJobs() {
    let jobs;
    try {
      jobs = await api.jobs({ state: stateFilter.value || undefined, limit: 100 });
    } catch (error) {
      tbody.innerHTML = `<tr><td colspan="6" class="vg-error">Could not load jobs: ${escHtml(error.message)}</td></tr>`;
      return;
    }
    tbody.innerHTML = jobs.length
      ? jobs.map(jobRowMarkup).join('')
      : '<tr><td colspan="6" class="vg-placeholder">No jobs yet.</td></tr>';
    tbody.querySelectorAll('.vg-jobs-node-link').forEach((button) => {
      button.addEventListener('click', () => onSelectNode?.(button.dataset.nodeId));
    });

    let newlyFinished = false;
    for (const job of jobs) {
      if (job.state !== 'done' && job.state !== 'failed') continue;
      if (seenTerminal.has(job.job_id)) continue;
      seenTerminal.add(job.job_id);
      newlyFinished = true;
    }
    // A job that just finished may have changed a node's status - keep the
    // graph's own badges honest, but only disturb the graph/drawer when that
    // is actually true, not on every idle poll.
    if (newlyFinished) onGraphChange?.();
  }

  async function runBatch(button, request, describeTarget) {
    if (!state.user) {
      statusEl.textContent = 'Log in with ORCID to run verifications.';
      return;
    }
    button.disabled = true;
    statusEl.textContent = `Queuing ${describeTarget}…`;
    try {
      const result = await api.verifyBatch(request);
      statusEl.textContent = `${result.queued.length} job(s) queued, ${result.skipped.length} skipped.`;
      await refreshJobs();
    } catch (error) {
      statusEl.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  stateFilter.addEventListener('change', refreshJobs);

  verifyAllBtn.addEventListener('click', () => runBatch(verifyAllBtn, {}, 'every eligible node'));

  verifyFilteredBtn.addEventListener('click', () => {
    const filtered = filterSnapshot(state.snapshot, state.filters);
    const nodeIds = filtered.nodes.filter((node) => node.kind === 'statement').map((node) => node.id);
    if (!nodeIds.length) {
      statusEl.textContent = 'No statements match the current filters.';
      return;
    }
    runBatch(verifyFilteredBtn, { nodeIds }, `${nodeIds.length} filtered node(s)`);
  });

  refreshJobs();
  const timer = window.setInterval(refreshJobs, JOB_POLL_MS);

  return { element, stop: () => window.clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

async function renderDrawer(drawer, nodeId, api, state, onMutate) {
  drawer.innerHTML = '<p class="vg-placeholder">Loading…</p>';
  let node;
  try {
    node = await api.node(nodeId);
  } catch (error) {
    drawer.innerHTML = `<p class="vg-error">${escHtml(error.message)}</p>`;
    return;
  }
  if (state.selectedId !== nodeId) return;

  const summary = indexSnapshot(state.snapshot).byId.get(nodeId);
  drawer.innerHTML = node.kind === 'statement'
    ? statementMarkup(node, summary)
    : nonStatementMarkup(node);

  if (drawer.dataset.axis) {
    showAxisMeaning(drawer, drawer.dataset.axis, node);
    delete drawer.dataset.axis;
  }

  drawer.querySelectorAll('[data-axis]').forEach((el) => {
    el.addEventListener('click', () => showAxisMeaning(drawer, el.dataset.axis, node));
  });

  wireCodeLinks(drawer, nodeId, api);
  wireRuns(drawer, nodeId, api);
  wireActions(drawer, nodeId, api, state, onMutate);
}

function statementMarkup(node, summary) {
  const effective = summary?.effective_status ?? node.status;
  const axes = AXES.map((axis) => {
    const entry = node.verification?.[axis] ?? {};
    const label = AXIS_STATUS_LABEL[entry.status] ?? 'not attempted';
    return `
      <li class="vg-axis vg-axis--${escHtml(entry.status ?? 'not_attempted')}">
        <button type="button" class="vg-axis-name" data-axis="${escHtml(axis)}">${escHtml(axis)}</button>
        <span class="vg-axis-status">${escHtml(label)}</span>
        ${entry.method ? `<span class="vg-axis-method">${escHtml(entry.method)}</span>` : ''}
        ${entry.note ? `<span class="vg-axis-note">${escHtml(entry.note)}</span>` : ''}
        ${entry.run?.ran_at ? `<span class="vg-axis-ran">ran ${escHtml(entry.run.ran_at)}</span>` : ''}
      </li>`;
  }).join('');

  return `
    <header class="vg-drawer-header">
      <span class="vg-badge vg-badge--${escHtml(effective ?? 'proposed')}">${escHtml(STATUS_LABEL[effective] ?? effective ?? '')}</span>
      <h2>${escHtml(node.label || node.id)}</h2>
      <p class="vg-triple"><code>${escHtml(node.subject)}</code> → <code>${escHtml(node.relation)}</code> → <code>${escHtml(node.object)}</code></p>
      ${node.status === 'verified' && effective !== 'verified'
        ? `<p class="vg-warn">Its own run passed, but a node it depends on is ${escHtml(effective)}, so it cannot present as verified.</p>`
        : ''}
    </header>
    ${Object.keys(node.value ?? {}).length
      ? `<section><h3>Value</h3><pre class="vg-json">${escHtml(JSON.stringify(node.value, null, 2))}</pre></section>`
      : ''}
    <section><h3>Verification</h3><ul class="vg-axes">${axes}</ul><div class="vg-axis-meaning"></div></section>
    ${node.depends_on?.length
      ? `<section><h3>Depends on</h3><ul class="vg-deps">${node.depends_on.map((id) => `<li><a href="?node=${encodeURIComponent(id)}">${escHtml(id)}</a></li>`).join('')}</ul></section>`
      : ''}
    ${node.data?.length
      ? `<section><h3>Data</h3><ul class="vg-data">${node.data.map((ref) => `<li><code>${escHtml(ref.table)}</code>${ref.asset_name ? ` · ${escHtml(ref.asset_name)}` : ''}${ref.version ? ` · ${escHtml(ref.version)}` : ''}</li>`).join('')}</ul></section>`
      : ''}
    <section class="vg-code"><h3>Code</h3><div class="vg-code-body"><p class="vg-placeholder">Loading…</p></div></section>
    <section class="vg-runs"><h3>Runs</h3><div class="vg-runs-body"><p class="vg-placeholder">Loading…</p></div></section>
    <section class="vg-actions"></section>
    ${provenanceMarkup(node)}
  `;
}

function nonStatementMarkup(node) {
  const rows = node.kind === 'entity'
    ? `<p class="vg-kind">${escHtml(node.entity_type)}</p>
       ${node.grounding
         ? `<section><h3>Grounding</h3><pre class="vg-json">${escHtml(JSON.stringify(node.grounding, null, 2))}</pre></section>`
         : ''}
       ${node.members?.length
         ? `<section><h3>Members</h3><ul class="vg-deps">${node.members.map((id) => `<li><a href="?node=${encodeURIComponent(id)}">${escHtml(id)}</a></li>`).join('')}</ul></section>`
         : ''}`
    : `<section><h3>Definition</h3><p class="vg-definition">${escHtml(node.definition ?? '')}</p></section>
       <section><h3>Signature</h3><pre class="vg-json">${escHtml(JSON.stringify(node.signature ?? {}, null, 2))}</pre></section>`;

  return `
    <header class="vg-drawer-header">
      <span class="vg-badge">${escHtml(node.kind)}</span>
      <h2>${escHtml(node.label || node.id)}</h2>
    </header>
    ${rows}
    <section class="vg-code"><h3>Code</h3><div class="vg-code-body"><p class="vg-placeholder">Loading…</p></div></section>
    <section class="vg-runs"><h3>Runs</h3><div class="vg-runs-body"><p class="vg-placeholder">Loading…</p></div></section>
    <section class="vg-actions"></section>
    ${provenanceMarkup(node)}
  `;
}

function provenanceMarkup(node) {
  const history = node.provenance?.history ?? [];
  if (!node.provenance) return '';
  return `
    <section><h3>Provenance</h3>
      <p class="vg-provenance">${escHtml(node.provenance.author)} · created ${escHtml(node.provenance.created ?? '')}</p>
      ${history.length
        ? `<ul class="vg-history">${history.map((event) => `<li>${escHtml(event.at)} · ${escHtml(event.action)}${event.detail ? ` — ${escHtml(event.detail)}` : ''}</li>`).join('')}</ul>`
        : ''}
    </section>`;
}

function showAxisMeaning(drawer, axis, node) {
  const target = drawer.querySelector('.vg-axis-meaning');
  if (!target) return;
  const entry = node.verification?.[axis] ?? {};
  const run = entry.run ?? {};
  target.innerHTML = `
    <h4>${escHtml(axis)}</h4>
    <p>${escHtml(AXIS_MEANING[axis] ?? '')}</p>
    <p class="vg-axis-detail">This node: <strong>${escHtml(AXIS_STATUS_LABEL[entry.status] ?? 'not attempted')}</strong>${
      run.ran_at ? `, last run ${escHtml(run.ran_at)}` : ''
    }${run.result_hash ? `, result hash <code>${escHtml(run.result_hash.slice(0, 12))}</code>` : ''}.</p>
  `;
}

async function wireCodeLinks(drawer, nodeId, api) {
  const body = drawer.querySelector('.vg-code-body');
  if (!body) return;
  let listing;
  try {
    listing = await api.codeListing(nodeId);
  } catch (error) {
    body.innerHTML = `<p class="vg-error">${escHtml(error.message)}</p>`;
    return;
  }
  if (!listing.files?.length) {
    body.innerHTML = '<p class="vg-placeholder">No code sidecar.</p>';
    return;
  }
  const gates = listing.gates ?? {};
  body.innerHTML = `
    <p class="vg-code-hash">code_hash <code>${escHtml((listing.code_hash ?? '').slice(0, 12))}</code>${
      gates.known_cases ? ` · ${gates.known_cases} known case(s)` : ''
    }${gates.ok === false ? ' · <span class="vg-warn-inline">layout incomplete</span>' : ''}</p>
    <ul class="vg-files">${listing.files
      .map((file) => `<li><button type="button" data-path="${escHtml(file.path)}">${escHtml(file.path)}</button> <span>${file.size} B</span></li>`)
      .join('')}</ul>
    <pre class="vg-source"></pre>`;

  const source = body.querySelector('.vg-source');
  body.querySelectorAll('[data-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      source.textContent = 'Loading…';
      try {
        source.textContent = await api.codeFile(nodeId, button.dataset.path);
      } catch (error) {
        source.textContent = error.message;
      }
    });
  });
}

async function wireRuns(drawer, nodeId, api) {
  const body = drawer.querySelector('.vg-runs-body');
  if (!body) return;
  let runs;
  try {
    runs = await api.runs(nodeId);
  } catch (error) {
    body.innerHTML = `<p class="vg-error">${escHtml(error.message)}</p>`;
    return;
  }
  body.innerHTML = runs.length
    ? `<ul class="vg-run-list">${runs
        .map((run, index) => `<li class="${run.passed ? 'is-pass' : 'is-fail'}">
            <span class="vg-run-axis">${escHtml(run.axis ?? '')}</span>
            <span class="vg-run-when">${escHtml(run.ran_at ?? '')}</span>
            <span class="vg-run-note">${escHtml(run.note ?? '')}</span>
            ${run.stamp
              ? `<button type="button" class="vg-run-log-btn" data-index="${index}">View full log</button>`
              : ''}
            <pre class="vg-run-log vg-source" hidden></pre>
          </li>`)
        .join('')}</ul>`
    : '<p class="vg-placeholder">Never run.</p>';

  body.querySelectorAll('.vg-run-log-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const run = runs[Number(button.dataset.index)];
      const pre = button.nextElementSibling;
      pre.hidden = false;
      pre.textContent = 'Loading…';
      button.disabled = true;
      try {
        pre.textContent = await api.runLog(nodeId, run.stamp);
      } catch (error) {
        pre.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  });
}

function wireActions(drawer, nodeId, api, state, onMutate) {
  const actions = drawer.querySelector('.vg-actions');
  if (!actions) return;
  if (!state.user) {
    actions.innerHTML = '<p class="vg-placeholder">Log in with ORCID to run verifications.</p>';
    return;
  }
  actions.innerHTML = `
    <button type="button" class="vg-run-btn">Re-run reproducibility</button>
    ${state.user.is_admin ? '<button type="button" class="vg-approve-btn">Approve</button>' : ''}
    <span class="vg-action-status"></span>`;

  const status = actions.querySelector('.vg-action-status');
  actions.querySelector('.vg-run-btn').addEventListener('click', async () => {
    status.textContent = 'Queued…';
    try {
      const job = await api.verify(nodeId, 'reproducible');
      status.textContent = `Job ${job.job_id} queued.`;
      pollJob(api, job.job_id, status, onMutate);
    } catch (error) {
      status.textContent = error.message;
    }
  });
  actions.querySelector('.vg-approve-btn')?.addEventListener('click', async () => {
    status.textContent = 'Approving…';
    try {
      await api.approve(nodeId);
      status.textContent = 'Approved.';
      onMutate();
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

function pollJob(api, jobId, statusEl, onMutate) {
  const timer = window.setInterval(async () => {
    let job;
    try {
      job = await api.job(jobId);
    } catch (_) {
      return;
    }
    if (job.state === 'queued' || job.state === 'running') {
      statusEl.textContent = `Job ${job.state}…`;
      return;
    }
    window.clearInterval(timer);
    statusEl.textContent = job.state === 'done'
      ? `${job.result?.passed ? 'Passed' : 'Failed'}: ${job.result?.note ?? ''}`
      : `Job failed: ${job.error ?? ''}`;
    onMutate();
  }, JOB_POLL_MS);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set or clear one query-string parameter without disturbing the others. */
function setUrlParam(key, value) {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set(key, value);
  else params.delete(key);
  window.history.replaceState({}, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
}


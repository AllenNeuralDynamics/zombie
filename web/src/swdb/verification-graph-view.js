/**
 * swdb/verification-graph-view.js — the /swdb/verification-graph page shell.
 *
 * A knowledge graph of scientific statements where every statement is linked
 * to the evidence, code and lower-level statements behind it, and where the
 * record is always explicit about which kinds of verification it has passed.
 *
 * The shell is vanilla DOM: toolbar, graph container, detail drawer, agent
 * panel. Only the graph itself is React (React Flow), lazy-imported through
 * `verification-graph/mount.js` so React stays out of the default bundle.
 *
 * Selection round-trips through `?node=` so a statement is linkable.
 */

import { escHtml } from '../lib/utils.js';
import { getCurrentUser, loginWithOrcid } from '../lib/auth.js';
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

const AGENT_POLL_MS = 3_000;

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
    agentJobId: null,
    agentTimer: null,
  };

  const toolbar = buildToolbar(state, () => render());
  const graphEl = document.createElement('div');
  graphEl.className = 'vg-graph';
  graphEl.innerHTML = '<p class="vg-placeholder">Loading the graph…</p>';

  const drawer = document.createElement('aside');
  drawer.className = 'vg-drawer';

  const agentPanel = buildAgentPanel(state, api, () => refresh());

  const layout = document.createElement('div');
  layout.className = 'vg-layout';
  layout.append(graphEl, drawer);

  root.append(toolbar.element, layout, agentPanel.element);

  let mountGraph = null;

  function selectNode(nodeId) {
    state.selectedId = nodeId;
    const params = new URLSearchParams(window.location.search);
    if (nodeId) params.set('node', nodeId);
    else params.delete('node');
    window.history.replaceState({}, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
    render();
    if (nodeId) renderDrawer(drawer, nodeId, api, state, () => refresh());
    else drawer.innerHTML = '<p class="vg-placeholder">Select a node to see the evidence behind it.</p>';
  }

  function selectAxis(nodeId, axis) {
    selectNode(nodeId);
    drawer.dataset.axis = axis;
  }

  async function render() {
    if (!state.snapshot) return;
    toolbar.update(state.snapshot);
    const filtered = filterSnapshot(state.snapshot, state.filters);
    if (filtered.nodes.length === 0) {
      graphEl.innerHTML = state.snapshot.nodes?.length
        ? '<p class="vg-placeholder">Nothing matches these filters.</p>'
        : '<p class="vg-placeholder">The graph is empty. Ask the agent below for a claim to author the first nodes.</p>';
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
    agentPanel.update(user);
  });

  refresh();
  return root;
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function buildToolbar(state, onChange) {
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
    </div>
    <p class="vg-counts"></p>
  `;

  const search = element.querySelector('.vg-search');
  const status = element.querySelector('.vg-status');
  const verifiedOnly = element.querySelector('.vg-verified-only');
  const counts = element.querySelector('.vg-counts');

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

  return {
    element,
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
        .map((run) => `<li class="${run.passed ? 'is-pass' : 'is-fail'}">
            <span class="vg-run-axis">${escHtml(run.axis ?? '')}</span>
            <span class="vg-run-when">${escHtml(run.ran_at ?? '')}</span>
            <span class="vg-run-note">${escHtml(run.note ?? '')}</span>
            <code class="vg-run-log">${escHtml(run.log ?? '')}</code>
          </li>`)
        .join('')}</ul>`
    : '<p class="vg-placeholder">Never run.</p>';
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
  }, AGENT_POLL_MS);
}

// ---------------------------------------------------------------------------
// Agent panel
// ---------------------------------------------------------------------------

function buildAgentPanel(state, api, onMutate) {
  const element = document.createElement('section');
  element.className = 'vg-agent';
  element.innerHTML = `
    <h2>Ask for a new statement</h2>
    <div class="vg-agent-body"></div>
  `;
  const body = element.querySelector('.vg-agent-body');

  function renderLoggedOut() {
    body.innerHTML = '<p class="vg-placeholder">Log in with ORCID to ask the agent to author nodes.</p><button type="button" class="vg-login">Log in</button>';
    body.querySelector('.vg-login').addEventListener('click', () => loginWithOrcid());
  }

  function renderLoggedIn() {
    body.innerHTML = `
      <textarea class="vg-agent-input" rows="3" placeholder="e.g. Verify that 30% of CA3 units respond to vis1"></textarea>
      <div class="vg-agent-actions">
        <button type="button" class="vg-agent-send">Author nodes</button>
        <button type="button" class="vg-agent-stop" hidden>Stop</button>
      </div>
      <div class="vg-agent-steer" hidden>
        <input type="text" class="vg-agent-steer-input" placeholder="Steer the running session…" aria-label="Steer the running session" />
        <button type="button" class="vg-agent-steer-send">Send</button>
      </div>
      <p class="vg-agent-status"></p>
      <pre class="vg-agent-transcript"></pre>`;

    const input = body.querySelector('.vg-agent-input');
    const status = body.querySelector('.vg-agent-status');
    const transcript = body.querySelector('.vg-agent-transcript');
    const send = body.querySelector('.vg-agent-send');
    const stop = body.querySelector('.vg-agent-stop');
    const steer = body.querySelector('.vg-agent-steer');
    const steerInput = body.querySelector('.vg-agent-steer-input');

    // The stop and steer controls only exist while a session is actually
    // running; the backend rejects both once it has finished.
    function setRunning(running) {
      send.disabled = running;
      stop.hidden = !running;
      steer.hidden = !running;
      if (!running) steerInput.value = '';
    }

    send.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) return;
      status.textContent = 'Queueing…';
      try {
        const job = await api.createAgentJob(text);
        state.agentJobId = job.job_id;
        status.textContent = `Job ${job.job_id} queued.`;
        setRunning(true);
        pollAgentJob(api, state, status, transcript, onMutate, setRunning);
      } catch (error) {
        status.textContent = error.message;
      }
    });

    stop.addEventListener('click', async () => {
      if (!state.agentJobId) return;
      stop.disabled = true;
      try {
        await api.cancelJob(state.agentJobId);
        status.textContent = 'Stopping… anything already written is still kept.';
      } catch (error) {
        status.textContent = error.message;
      } finally {
        stop.disabled = false;
      }
    });

    async function sendSteer() {
      const text = steerInput.value.trim();
      if (!text || !state.agentJobId) return;
      steerInput.value = '';
      try {
        await api.steerJob(state.agentJobId, text);
        status.textContent = 'Sent — the session picks it up at its next turn.';
      } catch (error) {
        status.textContent = error.message;
      }
    }

    body.querySelector('.vg-agent-steer-send').addEventListener('click', sendSteer);
    steerInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') sendSteer();
    });

    setRunning(false);
  }

  return {
    element,
    update(user) {
      if (user) renderLoggedIn();
      else renderLoggedOut();
    },
  };
}

function pollAgentJob(api, state, statusEl, transcriptEl, onMutate, setRunning) {
  window.clearInterval(state.agentTimer);
  state.agentTimer = window.setInterval(async () => {
    let job;
    try {
      job = await api.job(state.agentJobId);
    } catch (_) {
      return;
    }
    // While the session runs the server reads the transcript off disk, so this
    // shows the work as it happens rather than only at the end.
    transcriptEl.textContent = job.result?.transcript ?? job.transcript ?? '';
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    if (job.state === 'queued' || job.state === 'running') {
      statusEl.textContent = job.cancelled ? 'Stopping…' : `Agent ${job.state}…`;
      return;
    }
    window.clearInterval(state.agentTimer);
    setRunning?.(false);
    if (job.state === 'failed') {
      statusEl.textContent = `Job failed: ${job.error ?? ''}`;
      return;
    }
    const accepted = job.result?.accepted ?? [];
    const rejected = job.result?.rejected ?? [];
    const stopped = job.result?.cancelled ? 'Stopped. ' : '';
    statusEl.textContent = `${stopped}${accepted.length} node(s) proposed${rejected.length ? `, ${rejected.length} rejected` : ''}.`;
    onMutate();
  }, AGENT_POLL_MS);
}

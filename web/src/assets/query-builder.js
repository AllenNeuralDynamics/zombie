/**
 * query-builder.js — MongoDB query builder panel for the assets page.
 *
 * Layout:
 *   LEFT 2/3  — form controls (project, subject, modalities, data level,
 *               acquisition type, date range) + Run/Clear buttons at bottom.
 *   RIGHT 1/3 — top: editable JSON textarea (the MongoDB query)
 *               bottom: LLM chat input + Send button.
 *
 * Field mapping follows biodata-query conventions:
 *   data_description.project_name, subject.subject_id,
 *   data_description.modalities.abbreviation, data_description.data_level,
 *   acquisition.acquisition_type, acquisition.acquisition_start_time
 */

import { escHtml, uniqueValues } from '../lib/utils.js';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';

const PORTAL_BASE = CONTRIBUTIONS_API_BASE;

// MongoDB field paths (biodata-query FIELD_TO_COLUMN mapping)
const FIELD_MAP = {
  project_name:     'data_description.project_name',
  subject_id:       'subject.subject_id',
  modalities:       'data_description.modalities.abbreviation',
  data_level:       'data_description.data_level',
  acquisition_type: 'acquisition.acquisition_type',
};

const COOKIE_NAME = 'query_builder_collapsed';

function _readCookie(name) {
  const m = ('; ' + document.cookie).split(`; ${name}=`);
  if (m.length < 2) return null;
  return decodeURIComponent(m.pop().split(';')[0]);
}

function _writeCookie(name, value) {
  const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
}

/**
 * Build the query builder collapsible section.
 *
 * @param {object[]} allRows - All rows from asset_basics (already loaded).
 * @param {(names: string[] | null) => void} onFilter
 * @returns {HTMLElement}
 */
export function buildQueryBuilder(allRows, onFilter) {
  let collapsed = _readCookie(COOKIE_NAME) !== '0'; // default collapsed

  const section = document.createElement('div');
  section.className = 'query-builder';

  // ── Toggle button ─────────────────────────────────────────────────────────
  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'platform-qc-toggle';
  collapseBtn.setAttribute('aria-expanded', String(!collapsed));

  const arrow = document.createElement('span');
  arrow.className = 'platform-qc-toggle-arrow';
  arrow.textContent = collapsed ? '▶' : '▼';
  collapseBtn.appendChild(arrow);
  collapseBtn.appendChild(document.createTextNode(' Query builder'));
  section.appendChild(collapseBtn);

  // ── Body ──────────────────────────────────────────────────────────────────
  const body = document.createElement('div');
  body.className = 'qb-body';
  body.hidden = collapsed;
  section.appendChild(body);

  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    body.hidden = collapsed;
    arrow.textContent = collapsed ? '▶' : '▼';
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    _writeCookie(COOKIE_NAME, collapsed ? '1' : '0');
  });

  // ── Unique values for selectors ───────────────────────────────────────────
  const projects   = uniqueValues(allRows, 'project_name');
  const modalities = uniqueValues(allRows, 'modalities', { split: ',' });
  const dataLevels = uniqueValues(allRows, 'data_level');
  const acqTypes   = uniqueValues(allRows, 'acquisition_type');

  // ── LEFT panel: form controls + run/clear ─────────────────────────────────
  const left = document.createElement('div');
  left.className = 'qb-left';

  const controls = document.createElement('div');
  controls.className = 'qb-controls';
  controls.innerHTML = `
    <div class="qb-field">
      <label class="qb-label">Project</label>
      <select class="qb-select" data-field="project_name" multiple size="4">
        ${projects.map((p) => `<option value="${escHtml(p)}">${escHtml(p)}</option>`).join('')}
      </select>
    </div>
    <div class="qb-field">
      <label class="qb-label">Subject ID</label>
      <input class="qb-input" type="text" data-field="subject_id" placeholder="e.g. 730945" />
    </div>
    <div class="qb-field">
      <label class="qb-label">Modalities</label>
      <div class="qb-checkbox-group" data-field="modalities">
        ${modalities.map((m) => `<label class="qb-cb-label"><input type="checkbox" value="${escHtml(m)}" />${escHtml(m)}</label>`).join('')}
      </div>
    </div>
    <div class="qb-field qb-field-row">
      <div class="qb-field-col">
        <label class="qb-label">Data Level</label>
        <select class="qb-select" data-field="data_level">
          <option value="">— any —</option>
          ${dataLevels.map((d) => `<option value="${escHtml(d)}">${escHtml(d)}</option>`).join('')}
        </select>
      </div>
      <div class="qb-field-col">
        <label class="qb-label">Acquisition Type</label>
        <select class="qb-select" data-field="acquisition_type">
          <option value="">— any —</option>
          ${acqTypes.map((t) => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="qb-field">
      <label class="qb-label">Acquisition Date Range</label>
      <div class="qb-date-row">
        <input class="qb-date" type="date" data-field="date_start" />
        <span class="qb-date-sep">→</span>
        <input class="qb-date" type="date" data-field="date_end" />
      </div>
    </div>
  `;
  left.appendChild(controls);

  // Run / Clear at the bottom of the left panel
  const leftActions = document.createElement('div');
  leftActions.className = 'qb-left-actions';

  const runBtn = document.createElement('button');
  runBtn.className = 'qb-run-btn';
  runBtn.textContent = 'Run Query';

  const clearBtn = document.createElement('button');
  clearBtn.className = 'qb-clear-btn';
  clearBtn.textContent = 'Clear';

  const statusEl = document.createElement('span');
  statusEl.className = 'qb-status';

  leftActions.appendChild(runBtn);
  leftActions.appendChild(clearBtn);
  leftActions.appendChild(statusEl);
  left.appendChild(leftActions);

  body.appendChild(left);

  // ── RIGHT panel: JSON editor + chat input ────────────────────────────────
  const right = document.createElement('div');
  right.className = 'qb-right';

  const jsonLabel = document.createElement('div');
  jsonLabel.className = 'qb-label';
  jsonLabel.textContent = 'MongoDB Query';
  right.appendChild(jsonLabel);

  const textarea = document.createElement('textarea');
  textarea.className = 'qb-json';
  textarea.spellcheck = false;
  textarea.value = '{}';
  right.appendChild(textarea);

  const chatLabel = document.createElement('div');
  chatLabel.className = 'qb-label';
  chatLabel.textContent = 'Ask an LLM to build or refine query';
  right.appendChild(chatLabel);

  const chatInputRow = document.createElement('div');
  chatInputRow.className = 'qb-chat-input-row';

  const chatInput = document.createElement('textarea');
  chatInput.className = 'qb-chat-input';
  chatInput.placeholder = 'e.g. "only raw ecephys from 2024"';
  chatInput.rows = 2;

  const sendBtn = document.createElement('button');
  sendBtn.className = 'qb-send-btn';
  sendBtn.textContent = 'Send';

  chatInputRow.appendChild(chatInput);
  chatInputRow.appendChild(sendBtn);
  right.appendChild(chatInputRow);

  body.appendChild(right);

  // ── Sync controls → JSON ──────────────────────────────────────────────────
  let jsonEditedManually = false;

  function buildQueryFromControls() {
    const query = {};

    const projectSel = controls.querySelector('[data-field="project_name"]');
    const selectedProjects = Array.from(projectSel.selectedOptions).map((o) => o.value);
    if (selectedProjects.length === 1) {
      query[FIELD_MAP.project_name] = selectedProjects[0];
    } else if (selectedProjects.length > 1) {
      query[FIELD_MAP.project_name] = { $in: selectedProjects };
    }

    const subjectVal = controls.querySelector('[data-field="subject_id"]').value.trim();
    if (subjectVal) query[FIELD_MAP.subject_id] = subjectVal;

    const modalityChecked = Array.from(
      controls.querySelectorAll('[data-field="modalities"] input:checked')
    ).map((cb) => cb.value);
    if (modalityChecked.length === 1) {
      query[FIELD_MAP.modalities] = modalityChecked[0];
    } else if (modalityChecked.length > 1) {
      query[FIELD_MAP.modalities] = { $in: modalityChecked };
    }

    const levelVal = controls.querySelector('[data-field="data_level"]').value;
    if (levelVal) query[FIELD_MAP.data_level] = levelVal;

    const acqTypeVal = controls.querySelector('[data-field="acquisition_type"]').value;
    if (acqTypeVal) query[FIELD_MAP.acquisition_type] = acqTypeVal;

    const dateStart = controls.querySelector('[data-field="date_start"]').value;
    const dateEnd   = controls.querySelector('[data-field="date_end"]').value;
    if (dateStart || dateEnd) {
      const df = {};
      if (dateStart) df.$gte = `${dateStart}T00:00:00`;
      if (dateEnd)   df.$lte = `${dateEnd}T23:59:59`;
      query['acquisition.acquisition_start_time'] = df;
    }

    return query;
  }

  function syncJsonFromControls() {
    if (jsonEditedManually) return;
    textarea.value = JSON.stringify(buildQueryFromControls(), null, 2);
  }

  controls.addEventListener('input', syncJsonFromControls);
  controls.addEventListener('change', syncJsonFromControls);
  textarea.addEventListener('input', () => { jsonEditedManually = true; });

  // ── Run query ─────────────────────────────────────────────────────────────
  let runAbort = null;

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'qb-status' + (type ? ` qb-status-${type}` : '');
  }

  async function runQuery() {
    let filter;
    try {
      filter = JSON.parse(textarea.value);
    } catch (e) {
      setStatus(`Invalid JSON: ${e.message}`, 'error');
      return;
    }
    if (Object.keys(filter).length === 0) {
      setStatus('Query is empty — add filters first.', 'error');
      return;
    }

    if (runAbort) runAbort.abort();
    runAbort = new AbortController();
    runBtn.disabled = true;
    setStatus('Running…', '');

    try {
      const resp = await fetch(`${PORTAL_BASE}/retrieve-records?names_only=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filter),
        signal: runAbort.signal,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
      }
      const data = await resp.json();
      const names = Array.isArray(data) ? data : (data.asset_names ?? []);
      setStatus(`${names.length.toLocaleString()} results`, 'ok');
      onFilter(names);
    } catch (err) {
      if (err.name === 'AbortError') return;
      setStatus(`Error: ${err.message}`, 'error');
    } finally {
      runBtn.disabled = false;
    }
  }

  function clearQuery() {
    controls.querySelectorAll('select').forEach((s) =>
      Array.from(s.options).forEach((o) => { o.selected = false; })
    );
    controls.querySelectorAll('input[type="text"]').forEach((i) => { i.value = ''; });
    controls.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
    controls.querySelectorAll('input[type="date"]').forEach((d) => { d.value = ''; });
    jsonEditedManually = false;
    textarea.value = '{}';
    setStatus('', '');
    onFilter(null);
  }

  runBtn.addEventListener('click', runQuery);
  clearBtn.addEventListener('click', clearQuery);

  // ── LLM chat ─────────────────────────────────────────────────────────────
  let chatAbort = null;

  async function sendChat() {
    const message = chatInput.value.trim();
    if (!message) return;

    let currentQuery;
    try {
      currentQuery = JSON.parse(textarea.value);
    } catch (e) {
      setStatus(`Fix JSON first: ${e.message}`, 'error');
      return;
    }

    chatInput.value = '';
    sendBtn.disabled = true;
    setStatus('Thinking…', '');

    if (chatAbort) chatAbort.abort();
    chatAbort = new AbortController();

    const params = new URLSearchParams({
      message,
      query: JSON.stringify(currentQuery),
    });

    try {
      const resp = await fetch(`${PORTAL_BASE}/upgrade-query?${params}`, {
        signal: chatAbort.signal,
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t.slice(0, 300)}`);
      }
      const data = await resp.json();
      if (data.query) {
        textarea.value = JSON.stringify(data.query, null, 2);
        jsonEditedManually = true;
        setStatus('Query updated.', 'ok');
      } else {
        throw new Error(data.error ?? 'Unexpected response from server.');
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      setStatus(`Error: ${err.message}`, 'error');
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  return section;
}

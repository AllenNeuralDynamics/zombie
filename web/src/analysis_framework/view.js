/**
 * analysis_framework/view.js — Dashboard for the AIND Analysis Framework.
 *
 * Replicates (and fixes) the Panel app at
 * https://github.com/AllenNeuralDynamics/aind-analysis-framework-viz.
 *
 * Flow:
 *   1. Pick a project (DocDB collection in the `analysis` database).
 *   2. Load recent records via the /analysis/search proxy, flatten each nested
 *      record into dot-path columns, and show them in a filterable table.
 *   3. A settings gear toggles which columns are visible.
 *   4. Selecting rows lists every PNG under that record's S3 prefix
 *      (via the /s3-list proxy) and renders them inline.
 *   5. Project, limit, filter, visible columns and selection all sync to the URL.
 *
 * The original app hard-coded a single asset filename per project
 * (e.g. `result.png`), which does not exist for most records — that is why it
 * appeared non-functional. We instead enumerate the S3 prefix and show all
 * images, which works uniformly across projects.
 *
 * No DuckDB is used; data comes entirely from the DocDB + S3 proxies.
 *
 * @module
 */

import { escHtml } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------

/**
 * Per-project config.
 *  - label:          display name in the selector
 *  - s3Column:       flattened column holding the record's S3 base location
 *  - sort:           DocDB sort spec used to fetch the most recent records
 *  - defaultColumns: columns shown before the user touches the gear
 */
const PROJECTS = {
  'dynamic-foraging-model-fitting': {
    label: 'Dynamic Foraging Model Fitting',
    s3Column: 's3_location',
    sort: { session_date: -1 },
    defaultColumns: [
      'subject_id', 'session_date', 'status', 'nwb_name',
      'analysis_results.n_trials', 'analysis_results.AIC', 'analysis_results.LPT_AIC',
    ],
  },
  'dynamic-foraging-nm': {
    label: 'Dynamic Foraging NM',
    s3Column: 'location',
    sort: { 'processing.data_processes.end_date_time': -1 },
    defaultColumns: [
      'name',
      'processing.data_processes.name',
      'processing.data_processes.code.parameters.plot_types',
      'processing.data_processes.code.parameters.channels',
      'processing.data_processes.end_date_time',
    ],
  },
  'dynamic-foraging-lifetime': {
    label: 'Dynamic Foraging Lifetime',
    s3Column: 'location',
    sort: { 'processing.data_processes.end_date_time': -1 },
    defaultColumns: [
      'name',
      'processing.data_processes.name',
      'processing.data_processes.code.parameters.analysis_name',
      'processing.data_processes.code.parameters.analysis_tag',
      'processing.data_processes.end_date_time',
    ],
  },
};

const ID_COLUMN = '_id';
const DEFAULT_LIMIT = 500;

// ---------------------------------------------------------------------------
// Record flattening
// ---------------------------------------------------------------------------

/**
 * Flatten a nested DocDB record into a flat { dotPath: scalar } object.
 *
 * Mirrors the Python loader: single-element lists of dicts are unwrapped so
 * `processing.data_processes` (a 1-element list) flattens as an object. Longer
 * lists and arbitrary objects are JSON-encoded so they remain filterable.
 */
function flattenRecord(obj, prefix = '', out = {}, depth = 0) {
  if (depth > 8) {
    out[prefix] = JSON.stringify(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 1 && obj[0] && typeof obj[0] === 'object') {
      return flattenRecord(obj[0], prefix, out, depth + 1);
    }
    out[prefix] = obj.length === 0 ? '' : JSON.stringify(obj);
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      flattenRecord(value, path, out, depth + 1);
    }
    return out;
  }
  // Scalar (or null)
  out[prefix] = obj;
  return out;
}

/** Human-readable cell value. */
function formatCell(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toPrecision(6).replace(/\.?0+$/, '');
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// URL state
// ---------------------------------------------------------------------------

function readUrlState() {
  const p = new URLSearchParams(window.location.search);
  const parseList = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  return {
    project: p.get('project') || '',
    limit: Math.max(1, parseInt(p.get('limit'), 10) || DEFAULT_LIMIT),
    q: p.get('q') || '',
    cols: parseList(p.get('cols')),
    sel: parseList(p.get('sel')),
  };
}

function writeUrlState(state) {
  const p = new URLSearchParams();
  if (state.project) p.set('project', state.project);
  if (state.limit && state.limit !== DEFAULT_LIMIT) p.set('limit', String(state.limit));
  if (state.q) p.set('q', state.q);
  if (state.cols.length) p.set('cols', state.cols.join(','));
  if (state.sel.size) p.set('sel', [...state.sel].join(','));
  const qs = p.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  history.replaceState({}, '', url);
}

// ---------------------------------------------------------------------------
// View factory
// ---------------------------------------------------------------------------

/**
 * Build the analysis-framework dashboard.
 *
 * @param {object} [_coord] Unused (no DuckDB); kept for entry-point symmetry.
 * @returns {HTMLElement} root element to mount into #app
 */
export function createAnalysisFrameworkView(_coord) {
  const url = readUrlState();

  // ---- mutable view state ----
  const state = {
    project: PROJECTS[url.project] ? url.project : '',
    limit: url.limit,
    q: url.q,
    rows: [],                    // flattened records
    allColumns: [],             // union of columns across loaded rows
    visibleCols: url.cols,      // ordered list; empty => project defaults
    selected: new Set(url.sel), // selected record ids
    loading: false,
    error: '',
    loadedProject: '',          // which project `rows` belongs to
  };

  const imageCache = new Map(); // s3 location -> Promise<images[]>

  // ---- DOM scaffold ----
  const root = document.createElement('div');
  root.className = 'af-page';
  root.innerHTML = `
    <div class="af-controls">
      <label class="af-field">
        <span>Project</span>
        <select id="af-project">
          <option value="">— Select a project —</option>
          ${Object.entries(PROJECTS)
            .map(([k, v]) => `<option value="${k}">${escHtml(v.label)}</option>`)
            .join('')}
        </select>
      </label>
      <label class="af-field af-field-limit">
        <span>Max records</span>
        <input id="af-limit" type="number" min="1" max="20000" step="100" />
      </label>
      <label class="af-field af-field-filter">
        <span>Filter</span>
        <input id="af-filter" type="text" placeholder="substring across visible columns…" />
      </label>
      <div class="af-gear-wrap">
        <button id="af-gear" class="af-gear-btn" title="Choose visible columns" aria-label="Column settings">⚙</button>
        <div id="af-gear-menu" class="af-gear-menu" hidden></div>
      </div>
    </div>
    <div id="af-status" class="af-status"></div>
    <div id="af-table-wrap" class="af-table-wrap"></div>
    <div class="af-assets">
      <h2 class="af-assets-title">Selected record assets</h2>
      <div id="af-assets-body" class="af-assets-body"></div>
    </div>
  `;

  const els = {
    project: root.querySelector('#af-project'),
    limit: root.querySelector('#af-limit'),
    filter: root.querySelector('#af-filter'),
    gear: root.querySelector('#af-gear'),
    gearMenu: root.querySelector('#af-gear-menu'),
    status: root.querySelector('#af-status'),
    tableWrap: root.querySelector('#af-table-wrap'),
    assetsBody: root.querySelector('#af-assets-body'),
  };

  els.project.value = state.project;
  els.limit.value = state.limit;
  els.filter.value = state.q;

  // ---- helpers ----

  function syncUrl() {
    writeUrlState({
      project: state.project,
      limit: state.limit,
      q: state.q,
      cols: state.visibleCols,
      sel: state.selected,
    });
  }

  function effectiveColumns() {
    const cfg = PROJECTS[state.loadedProject];
    const avail = new Set(state.allColumns);
    if (state.visibleCols.length) {
      const chosen = state.visibleCols.filter((c) => avail.has(c));
      if (chosen.length) return chosen;
    }
    if (cfg) {
      const defaults = cfg.defaultColumns.filter((c) => avail.has(c));
      if (defaults.length) return defaults;
    }
    return state.allColumns.slice(0, 8);
  }

  function filteredRows() {
    const q = state.q.trim().toLowerCase();
    if (!q) return state.rows;
    const cols = effectiveColumns();
    return state.rows.filter((row) =>
      cols.some((c) => String(row[c] ?? '').toLowerCase().includes(q))
    );
  }

  function setStatus(msg, isError = false) {
    els.status.textContent = msg;
    els.status.classList.toggle('af-status-error', isError);
  }

  // ---- data loading ----

  async function loadData() {
    if (!state.project) {
      state.rows = [];
      state.allColumns = [];
      state.loadedProject = '';
      renderTable();
      renderAssets();
      setStatus('Select a project to load records.');
      return;
    }
    const cfg = PROJECTS[state.project];
    state.loading = true;
    state.error = '';
    setStatus(`Loading ${cfg.label}…`);
    renderTable();

    const requestedProject = state.project;
    try {
      const resp = await fetch('/analysis/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: requestedProject,
          filter: {},
          limit: state.limit,
          sort: cfg.sort,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const records = await resp.json();
      if (records && records.error) throw new Error(records.error);
      // Ignore stale responses if the user switched projects mid-flight.
      if (state.project !== requestedProject) return;

      const rows = (Array.isArray(records) ? records : []).map((r) => flattenRecord(r));
      const colSet = new Set();
      for (const row of rows) for (const key of Object.keys(row)) colSet.add(key);

      state.rows = rows;
      state.allColumns = [...colSet].sort();
      state.loadedProject = requestedProject;
      state.loading = false;
      // Drop selections that no longer exist in the loaded set.
      const ids = new Set(rows.map((r) => String(r[ID_COLUMN])));
      state.selected = new Set([...state.selected].filter((id) => ids.has(id)));

      setStatus(`Loaded ${rows.length} record${rows.length === 1 ? '' : 's'}.`);
      renderGearMenu();
      renderTable();
      renderAssets();
      syncUrl();
    } catch (err) {
      if (state.project !== requestedProject) return;
      state.loading = false;
      state.rows = [];
      state.allColumns = [];
      state.loadedProject = '';
      setStatus(`Failed to load: ${err.message}`, true);
      renderTable();
    }
  }

  // ---- rendering: gear menu ----

  function renderGearMenu() {
    if (!state.allColumns.length) {
      els.gearMenu.innerHTML = '<p class="af-gear-empty">Load data to choose columns.</p>';
      return;
    }
    const active = new Set(effectiveColumns());
    els.gearMenu.innerHTML = `
      <div class="af-gear-head">
        <strong>Visible columns</strong>
        <button id="af-gear-reset" class="af-linkbtn" type="button">Reset</button>
      </div>
      <div class="af-gear-list">
        ${state.allColumns
          .map(
            (c) => `<label class="af-gear-item">
              <input type="checkbox" value="${escHtml(c)}" ${active.has(c) ? 'checked' : ''} />
              <span>${escHtml(c)}</span>
            </label>`
          )
          .join('')}
      </div>
    `;
    els.gearMenu.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        // Materialise current effective columns, then add/remove this one,
        // preserving column order by the sorted allColumns index.
        const chosen = new Set(effectiveColumns());
        if (cb.checked) chosen.add(cb.value);
        else chosen.delete(cb.value);
        state.visibleCols = state.allColumns.filter((c) => chosen.has(c));
        syncUrl();
        renderTable();
      });
    });
    els.gearMenu.querySelector('#af-gear-reset').addEventListener('click', () => {
      state.visibleCols = [];
      syncUrl();
      renderGearMenu();
      renderTable();
    });
  }

  // ---- rendering: table ----

  function renderTable() {
    if (state.loading) {
      els.tableWrap.innerHTML = '<p class="af-empty">Loading…</p>';
      return;
    }
    if (!state.loadedProject) {
      els.tableWrap.innerHTML = '<p class="af-empty">No data. Select a project above.</p>';
      return;
    }
    const cols = effectiveColumns();
    const rows = filteredRows();
    if (!rows.length) {
      els.tableWrap.innerHTML = '<p class="af-empty">No records match the current filter.</p>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'af-table';
    const thead = document.createElement('thead');
    thead.innerHTML = `<tr><th class="af-th-sel"></th>${cols
      .map((c) => `<th title="${escHtml(c)}">${escHtml(c)}</th>`)
      .join('')}</tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const id = String(row[ID_COLUMN]);
      const tr = document.createElement('tr');
      tr.dataset.id = id;
      if (state.selected.has(id)) tr.classList.add('af-row-selected');
      const check = state.selected.has(id) ? 'checked' : '';
      tr.innerHTML =
        `<td class="af-td-sel"><input type="checkbox" ${check} /></td>` +
        cols.map((c) => `<td title="${escHtml(formatCell(row[c]))}">${escHtml(formatCell(row[c]))}</td>`).join('');
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    table.appendChild(tbody);

    // Row / checkbox selection (event-delegated).
    tbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const id = tr.dataset.id;
      const isCheckbox = e.target.matches('input[type=checkbox]');
      // A plain click on a non-checkbox cell toggles too, for convenience.
      const nowSelected = isCheckbox ? e.target.checked : !state.selected.has(id);
      if (nowSelected) state.selected.add(id);
      else state.selected.delete(id);
      tr.classList.toggle('af-row-selected', nowSelected);
      const cb = tr.querySelector('input[type=checkbox]');
      if (cb) cb.checked = nowSelected;
      syncUrl();
      renderAssets();
    });

    els.tableWrap.innerHTML = '';
    const count = document.createElement('div');
    count.className = 'af-count';
    count.textContent = `Showing ${rows.length} of ${state.rows.length} records`;
    els.tableWrap.appendChild(count);
    els.tableWrap.appendChild(table);
  }

  // ---- rendering: assets ----

  function fetchImages(s3loc) {
    if (imageCache.has(s3loc)) return imageCache.get(s3loc);
    const promise = fetch(`/s3-list?loc=${encodeURIComponent(s3loc)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data && data.error) throw new Error(data.error);
        return data.images || [];
      });
    imageCache.set(s3loc, promise);
    return promise;
  }

  function renderAssets() {
    const cfg = PROJECTS[state.loadedProject];
    if (!cfg || !state.selected.size) {
      els.assetsBody.innerHTML =
        '<p class="af-empty">Select one or more records to view their figures.</p>';
      return;
    }
    const byId = new Map(state.rows.map((r) => [String(r[ID_COLUMN]), r]));
    els.assetsBody.innerHTML = '';

    for (const id of state.selected) {
      const row = byId.get(id);
      const card = document.createElement('div');
      card.className = 'af-asset-card';
      const s3loc = row ? row[cfg.s3Column] : null;
      card.innerHTML = `
        <div class="af-asset-head">
          <code>${escHtml(id)}</code>
          ${s3loc ? `<span class="af-asset-loc">${escHtml(String(s3loc))}</span>` : ''}
        </div>
        <div class="af-asset-imgs"><span class="af-empty">Loading figures…</span></div>
      `;
      els.assetsBody.appendChild(card);
      const imgWrap = card.querySelector('.af-asset-imgs');

      if (!s3loc) {
        imgWrap.innerHTML = '<span class="af-empty">No S3 location for this record.</span>';
        continue;
      }
      fetchImages(String(s3loc))
        .then((images) => {
          if (!images.length) {
            imgWrap.innerHTML = '<span class="af-empty">No images found under this prefix.</span>';
            return;
          }
          imgWrap.innerHTML = images
            .map(
              (img) => `<figure class="af-fig">
                <a href="${escHtml(img.url)}" target="_blank" rel="noopener">
                  <img loading="lazy" src="${escHtml(img.url)}" alt="${escHtml(img.name)}" />
                </a>
                <figcaption>${escHtml(img.name)}</figcaption>
              </figure>`
            )
            .join('');
        })
        .catch((err) => {
          imgWrap.innerHTML = `<span class="af-empty af-status-error">Failed to list images: ${escHtml(
            err.message
          )}</span>`;
        });
    }
  }

  // ---- wire controls ----

  els.project.addEventListener('change', () => {
    state.project = els.project.value;
    state.visibleCols = []; // reset column choice per project
    state.selected = new Set();
    syncUrl();
    loadData();
  });

  let limitTimer = null;
  els.limit.addEventListener('input', () => {
    clearTimeout(limitTimer);
    limitTimer = setTimeout(() => {
      const v = Math.max(1, parseInt(els.limit.value, 10) || DEFAULT_LIMIT);
      state.limit = v;
      syncUrl();
      if (state.project) loadData();
    }, 500);
  });

  els.filter.addEventListener('input', () => {
    state.q = els.filter.value;
    syncUrl();
    renderTable();
  });

  els.gear.addEventListener('click', (e) => {
    e.stopPropagation();
    els.gearMenu.hidden = !els.gearMenu.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!els.gearMenu.hidden && !els.gearMenu.contains(e.target) && e.target !== els.gear) {
      els.gearMenu.hidden = true;
    }
  });

  // ---- initial render ----
  renderGearMenu();
  renderTable();
  renderAssets();
  if (state.project) loadData();
  else setStatus('Select a project to load records.');

  return root;
}

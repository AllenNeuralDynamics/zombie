/**
 * analysis_framework/view.js — Dashboard for the AIND Analysis Framework.
 *
 * Replicates (and fixes) the Panel app at
 * https://github.com/AllenNeuralDynamics/aind-analysis-framework-viz.
 *
 * Flow:
 *   1. Pick a project (DocDB collection in the `analysis` database).
 *   2. Load records via the /analysis/search proxy, flatten each nested record
 *      into dot-path columns, and show them in the shared sortable/filterable
 *      `assets-table` (buildTableHead + buildPagingBar + filterRows/sortRows).
 *   3. A settings gear toggles which columns are visible.
 *   4. Selecting rows lists every PNG under that record's S3 prefix
 *      (via the /s3-list proxy) and renders them inline.
 *   5. Project, limit, page, sort, per-column filters, visible columns and
 *      selection all sync to the URL.
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

import { escHtml, filterRows, sortRows } from '../lib/utils.js';
import { buildTableHead, buildPagingBar } from '../lib/paginated-table.js';

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
/** Rows shown per page in the table. */
const PAGE_SIZE = 25;
/** 0 means "no cap" — load every matching record. */
const DEFAULT_LIMIT = 0;

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
  let filters = {};
  try {
    if (p.get('filters')) filters = JSON.parse(p.get('filters'));
  } catch { filters = {}; }
  const [sortCol = '', sortDir = 'asc'] = (p.get('sort') || '').split(':');
  return {
    project: p.get('project') || '',
    limit: Math.max(0, parseInt(p.get('limit'), 10) || DEFAULT_LIMIT),
    page: Math.max(0, (parseInt(p.get('page'), 10) || 1) - 1),
    cols: parseList(p.get('cols')),
    sel: parseList(p.get('sel')),
    filters: filters && typeof filters === 'object' ? filters : {},
    sortCol,
    sortDir: sortDir === 'desc' ? 'desc' : 'asc',
  };
}

function writeUrlState(state) {
  const p = new URLSearchParams();
  if (state.project) p.set('project', state.project);
  if (state.limit && state.limit !== DEFAULT_LIMIT) p.set('limit', String(state.limit));
  if (state.page) p.set('page', String(state.page + 1));
  if (state.sortCol) p.set('sort', `${state.sortCol}:${state.sortDir}`);
  const activeFilters = Object.fromEntries(
    Object.entries(state.filters).filter(([, v]) => v !== '' && v != null)
  );
  if (Object.keys(activeFilters).length) p.set('filters', JSON.stringify(activeFilters));
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
    page: url.page,             // 0-based current table page
    rows: [],                    // flattened records
    allColumns: [],             // union of columns across loaded rows
    visibleCols: url.cols,      // ordered list; empty => project defaults
    selected: new Set(url.sel), // selected record ids
    filters: url.filters,       // per-column text filters { col: substring }
    sortCol: url.sortCol,
    sortDir: url.sortDir,
    loading: false,
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
        <input id="af-limit" type="number" min="0" step="100" placeholder="all" />
      </label>
      <div class="af-gear-wrap">
        <button id="af-gear" class="af-gear-btn" title="Choose visible columns" aria-label="Column settings">⚙</button>
        <div id="af-gear-menu" class="af-gear-menu" hidden></div>
      </div>
    </div>
    <div id="af-status" class="af-status"></div>
    <div id="af-table-wrap" class="af-table-wrap"></div>
    <div class="af-assets">
      <div class="af-assets-head">
        <h2 class="af-assets-title">Selected record assets</h2>
        <button id="af-clear" class="af-clear-btn" type="button" hidden>Clear selection</button>
      </div>
      <div id="af-assets-body" class="af-assets-body"></div>
    </div>
    <div id="af-lightbox" class="af-lightbox" hidden>
      <button class="af-lightbox-close" aria-label="Close">✕</button>
      <img class="af-lightbox-img" alt="" />
    </div>
  `;

  const els = {
    project: root.querySelector('#af-project'),
    limit: root.querySelector('#af-limit'),
    gear: root.querySelector('#af-gear'),
    gearMenu: root.querySelector('#af-gear-menu'),
    status: root.querySelector('#af-status'),
    tableWrap: root.querySelector('#af-table-wrap'),
    assetsBody: root.querySelector('#af-assets-body'),
    clear: root.querySelector('#af-clear'),
    lightbox: root.querySelector('#af-lightbox'),
    lightboxImg: root.querySelector('#af-lightbox .af-lightbox-img'),
  };

  els.project.value = state.project;
  els.limit.value = state.limit ? String(state.limit) : '';

  // Persistent table scaffold (built once, reused across refreshes so that
  // typing in a per-column filter never rebuilds the header and loses focus).
  let tableEls = null;
  let currentColumns = [];

  // ---- helpers ----

  function syncUrl() {
    writeUrlState({
      project: state.project,
      limit: state.limit,
      page: state.page,
      cols: state.visibleCols,
      sel: state.selected,
      filters: state.filters,
      sortCol: state.sortCol,
      sortDir: state.sortDir,
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

  function visibleRows() {
    const filtered = filterRows(state.rows, state.filters);
    if (!state.sortCol) return filtered;
    // filterRows may return the original array reference; copy before sorting.
    return sortRows(filtered.slice(), state.sortCol, state.sortDir);
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
      // Drop selections / filters that no longer apply to the loaded set.
      const ids = new Set(rows.map((r) => String(r[ID_COLUMN])));
      state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
      for (const col of Object.keys(state.filters)) {
        if (!colSet.has(col)) delete state.filters[col];
      }
      if (state.sortCol && !colSet.has(state.sortCol)) state.sortCol = '';

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

  // ---- rendering: gear menu (column visibility) ----

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

  // ---- rendering: table (shared assets-table helpers) ----

  function onRowClick(e) {
    const tr = e.target.closest('tr');
    if (!tr || !tr.dataset.id) return;
    const id = tr.dataset.id;
    const nowSelected = !state.selected.has(id);
    if (nowSelected) state.selected.add(id);
    else state.selected.delete(id);
    tr.classList.toggle('af-row-selected', nowSelected);
    syncUrl();
    renderAssets();
  }

  function ensureTableScaffold() {
    if (tableEls) return tableEls;
    const count = document.createElement('div');
    count.className = 'af-count';
    const container = document.createElement('div');
    container.className = 'table-responsive';
    const table = document.createElement('table');
    table.className = 'assets-table af-table';
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    tbody.addEventListener('click', onRowClick);
    table.append(thead, tbody);
    container.appendChild(table);
    const paging = document.createElement('div');
    tableEls = { count, container, table, thead, tbody, paging };
    return tableEls;
  }

  /** Rebuild the header (fresh element → no stacked listeners). */
  function renderHeader() {
    const fresh = document.createElement('thead');
    // Pass [] for the rows arg so header filters are always text inputs; with
    // dotted/high-cardinality columns a value-select dropdown is unhelpful and
    // scanning every row per column would be costly on large collections.
    fresh.innerHTML = buildTableHead(
      currentColumns, {}, state.sortCol, state.sortDir, state.filters, []
    );
    fresh.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      const th = e.target.closest('th.sortable');
      if (!th) return;
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'asc';
      }
      state.page = 0;
      syncUrl();
      renderHeader();
      refreshBody();
    });
    const onFilter = (e) => {
      const el = e.target.closest('.col-filter');
      if (!el) return;
      state.filters[el.dataset.col] = el.value;
      state.page = 0;
      syncUrl();
      refreshBody(); // body/paging only — header stays, filter keeps focus
    };
    fresh.addEventListener('input', onFilter);
    fresh.addEventListener('change', onFilter);
    tableEls.table.replaceChild(fresh, tableEls.thead);
    tableEls.thead = fresh;
  }

  /** Refresh tbody rows, count and paging for the current page. */
  function refreshBody() {
    const rows = visibleRows();
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (state.page > pageCount - 1) state.page = pageCount - 1;
    const start = state.page * PAGE_SIZE;
    const pageRows = rows.slice(start, start + PAGE_SIZE);

    tableEls.tbody.innerHTML = pageRows
      .map((row) => {
        const id = String(row[ID_COLUMN]);
        const sel = state.selected.has(id) ? ' class="af-row-selected"' : '';
        const cells = currentColumns
          .map((c) => {
            const text = formatCell(row[c]);
            return `<td title="${escHtml(text)}">${escHtml(text)}</td>`;
          })
          .join('');
        return `<tr data-id="${escHtml(id)}"${sel}>${cells}</tr>`;
      })
      .join('');

    const totalNote =
      rows.length === state.rows.length
        ? `${state.rows.length} records`
        : `${rows.length} of ${state.rows.length} records`;
    tableEls.count.textContent = rows.length
      ? `Showing ${start + 1}–${start + pageRows.length} of ${totalNote}`
      : 'No records match the current filters.';

    tableEls.paging.innerHTML = buildPagingBar(state.page, PAGE_SIZE, rows.length, 'af-prev', 'af-next');
    tableEls.paging.querySelector('#af-prev')?.addEventListener('click', () => {
      if (state.page > 0) { state.page--; syncUrl(); refreshBody(); }
    });
    tableEls.paging.querySelector('#af-next')?.addEventListener('click', () => {
      if (state.page < pageCount - 1) { state.page++; syncUrl(); refreshBody(); }
    });
  }

  function renderTable() {
    if (state.loading) {
      els.tableWrap.innerHTML = '<p class="af-empty">Loading…</p>';
      tableEls = null;
      return;
    }
    if (!state.loadedProject) {
      els.tableWrap.innerHTML = '<p class="af-empty">No data. Select a project above.</p>';
      tableEls = null;
      return;
    }
    currentColumns = effectiveColumns();
    ensureTableScaffold();
    els.tableWrap.innerHTML = '';
    els.tableWrap.append(tableEls.count, tableEls.container, tableEls.paging);
    renderHeader();
    refreshBody();
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

  function clearSelection() {
    if (!state.selected.size) return;
    state.selected.clear();
    // Drop row highlights without a full re-render.
    tableEls?.tbody
      .querySelectorAll('tr.af-row-selected')
      .forEach((tr) => tr.classList.remove('af-row-selected'));
    syncUrl();
    renderAssets();
  }

  function renderAssets() {
    const cfg = PROJECTS[state.loadedProject];
    els.clear.hidden = !state.selected.size;
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
                <img class="af-fig-img" loading="lazy" src="${escHtml(img.url)}"
                     alt="${escHtml(img.name)}" title="Click to view fullscreen" />
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
    state.filters = {};
    state.sortCol = '';
    state.page = 0;
    syncUrl();
    loadData();
  });

  let limitTimer = null;
  els.limit.addEventListener('input', () => {
    clearTimeout(limitTimer);
    limitTimer = setTimeout(() => {
      state.limit = Math.max(0, parseInt(els.limit.value, 10) || 0);
      state.page = 0;
      syncUrl();
      if (state.project) loadData();
    }, 500);
  });

  els.clear.addEventListener('click', clearSelection);

  // ---- fullscreen image lightbox ----
  function openLightbox(src, alt) {
    els.lightboxImg.src = src;
    els.lightboxImg.alt = alt || '';
    els.lightbox.hidden = false;
  }
  function closeLightbox() {
    els.lightbox.hidden = true;
    els.lightboxImg.src = '';
  }
  els.assetsBody.addEventListener('click', (e) => {
    const img = e.target.closest('.af-fig-img');
    if (img) openLightbox(img.src, img.alt);
  });
  els.lightbox.addEventListener('click', closeLightbox); // click anywhere (incl. ✕) closes
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.lightbox.hidden) closeLightbox();
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

/**
 * sessions/view.js — Behavioral Sessions page.
 *
 * Queries the `asset_basics` DuckDB table, filters to assets that include
 * "behavior" in modalities, and renders:
 *   - Left: multi-select filters for project, instrument_id, and fiscal quarter
 *   - Right: summary stats (sessions by experimenter, by project, totals)
 *   - Bottom: sortable, filterable, paginated table
 */

import { registerAcornTable } from '../lib/metadata.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format an ISO datetime string to "YYYY-MM-DD" (UTC).
 */
export function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  } catch {
    return String(iso);
  }
}

/**
 * Determine the fiscal quarter label for a date string.
 * Fiscal year quarters: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec.
 *
 * @param {string|null} iso
 * @returns {string} e.g. "2025-Q1"
 */
export function getQuarterLabel(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const year = d.getUTCFullYear();
    const q = Math.floor(d.getUTCMonth() / 3) + 1;
    return `${year}-Q${q}`;
  } catch {
    return '';
  }
}

/**
 * Split a comma-separated experimenter field into an array of trimmed names.
 *
 * @param {string|null} val
 * @returns {string[]}
 */
/**
 * Normalize a single experimenter name:
 *  1. Replace non-alphanumeric/non-space chars (dots, underscores, etc.) with a space
 *  2. Collapse multiple spaces and strip leading/trailing whitespace
 *  3. Lowercase everything
 *  4. Re-capitalize the first letter of each word (title case)
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')   // special chars → space
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase()); // title case
}

export function parseExperimenters(val) {
  if (!val) return [];
  const seen = new Set();
  const result = [];
  for (const part of String(val).split(',')) {
    const normalized = normalizeName(part);
    if (normalized && !seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Collect all unique quarter labels from rows, sorted descending.
 *
 * @param {object[]} rows
 * @returns {string[]}
 */
export function collectQuarters(rows) {
  const seen = new Set();
  for (const row of rows) {
    const q = getQuarterLabel(row.acquisition_start_time);
    if (q) seen.add(q);
  }
  return Array.from(seen).sort().reverse();
}

/**
 * Collect unique non-null, non-empty values for a column, sorted.
 *
 * @param {object[]} rows
 * @param {string} col
 * @returns {string[]}
 */
export function uniqueValues(rows, col) {
  const seen = new Set();
  for (const row of rows) {
    const v = row[col];
    if (v != null && String(v).trim() !== '') seen.add(String(v).trim());
  }
  return Array.from(seen).sort();
}

/**
 * Apply the active filters to the full row set.
 *
 * @param {object[]} rows
 * @param {Set<string>} selectedProjects - empty = all
 * @param {Set<string>} selectedInstruments - empty = all
 * @param {Set<string>} selectedQuarters - empty = all
 * @returns {object[]}
 */
export function applyFilters(rows, selectedProjects, selectedInstruments, selectedQuarters) {
  return rows.filter((row) => {
    if (selectedProjects.size > 0 && !selectedProjects.has(String(row.project_name ?? ''))) return false;
    if (selectedInstruments.size > 0 && !selectedInstruments.has(String(row.instrument_id ?? ''))) return false;
    if (selectedQuarters.size > 0) {
      const q = getQuarterLabel(row.acquisition_start_time);
      if (!selectedQuarters.has(q)) return false;
    }
    return true;
  });
}

/**
 * Build experimenter → count map from filtered rows.
 *
 * @param {object[]} rows
 * @returns {Array<{experimenter: string, count: number}>} sorted desc by count
 */
export function countByExperimenter(rows) {
  // Use lowercase as the merge key, store display name (title-cased) separately
  const counts = new Map();   // lowercase key → count
  const display = new Map();  // lowercase key → display name
  for (const row of rows) {
    for (const name of parseExperimenters(row.experimenters)) {
      const key = name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!display.has(key)) display.set(key, name);
    }
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ experimenter: display.get(key), count }))
    .sort((a, b) => a.experimenter.localeCompare(b.experimenter));
}

/**
 * Build project → count map from filtered rows.
 *
 * @param {object[]} rows
 * @returns {Array<{project: string, count: number}>} sorted desc by count
 */
export function countByProject(rows) {
  const counts = new Map();
  for (const row of rows) {
    const p = String(row.project_name ?? 'Unknown');
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([project, count]) => ({ project, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Sort rows by column in place.
 */
export function sortRows(rows, col, dir) {
  rows.sort((a, b) => {
    const av = a[col] ?? '';
    const bv = b[col] ?? '';
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

const DISPLAY_COLUMNS = [
  'subject_id',
  'acquisition_start_time',
  'project_name',
  'instrument_id',
  'experimenters',
  'modalities',
  'genotype',
];

const COLUMN_LABELS = {
  subject_id: 'Subject',
  acquisition_start_time: 'Date (UTC)',
  project_name: 'Project',
  instrument_id: 'Instrument',
  experimenters: 'Experimenter(s)',
  modalities: 'Modalities',
  genotype: 'Genotype',
};

const PAGE_SIZE = 100;
const SELECT_THRESHOLD = 50;

/**
 * Render one table row.
 *
 * @param {object} row
 * @returns {string}
 */
export function renderSessionRow(row) {
  const cells = [
    `<td>${escHtml(row.subject_id ?? '')}</td>`,
    `<td>${escHtml(formatDate(row.acquisition_start_time ?? null))}</td>`,
    `<td>${escHtml(row.project_name ?? '')}</td>`,
    `<td>${escHtml(row.instrument_id ?? '')}</td>`,
    `<td>${escHtml(row.experimenters ?? '')}</td>`,
    `<td>${escHtml(row.modalities ?? '')}</td>`,
    `<td>${escHtml(row.genotype ?? '')}</td>`,
  ];
  return `<tr>${cells.join('')}</tr>`;
}

// ---------------------------------------------------------------------------
// View factory
// ---------------------------------------------------------------------------

/**
 * Create the Sessions view element.
 *
 * @param {import('@uwdata/vgplot').Coordinator} coord
 * @param {{ acorns: object[] }} metadata
 * @returns {HTMLElement}
 */
export function createSessionsView(coord, metadata) {
  const container = document.createElement('div');
  container.className = 'sessions-view';

  const loadingEl = document.createElement('p');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading behavioral sessions…';
  container.appendChild(loadingEl);

  const acorn = metadata?.acorns?.find((a) => a.name === 'asset_basics');

  const registerPromise = acorn
    ? registerAcornTable(coord, acorn)
    : Promise.reject(new Error('asset_basics table not found in metadata'));

  registerPromise
    .then(() =>
      coord.query(
        `SELECT subject_id, acquisition_start_time, project_name, instrument_id,
                experimenters, modalities, genotype, name, location
         FROM asset_basics
         WHERE lower(modalities) LIKE '%behavior%'
         ORDER BY acquisition_start_time DESC NULLS LAST`,
        { type: 'json' },
      ),
    )
    .then((result) => {
      loadingEl.remove();
      const rows = Array.isArray(result) ? result
        : Array.isArray(result?.data) ? result.data
        : Array.from(result ?? []);
      buildPage(rows);
    })
    .catch((err) => {
      loadingEl.textContent = `Failed to load sessions: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    });

  // -------------------------------------------------------------------------
  // Page builder
  // -------------------------------------------------------------------------

  function buildPage(allRows) {
    // -- URL state helpers ---------------------------------------------------
    function readUrlState() {
      const p = new URLSearchParams(window.location.search);
      const split = (key) => {
        const v = p.get(key);
        return v ? v.split('|').map(decodeURIComponent).filter(Boolean) : [];
      };
      return {
        projects:    split('projects'),
        instruments: split('instruments'),
        quarter:     p.get('quarter') ?? null,
        sort:        p.get('sort') ?? 'acquisition_start_time',
        dir:         p.get('dir') === 'asc' ? 'asc' : 'desc',
        page:        Math.max(0, parseInt(p.get('page') ?? '0', 10) || 0),
      };
    }

    function writeUrlState() {
      const p = new URLSearchParams();
      const encode = (set) =>
        Array.from(set).map(encodeURIComponent).join('|');
      if (selectedProjects.size)    p.set('projects',    encode(selectedProjects));
      if (selectedInstruments.size) p.set('instruments', encode(selectedInstruments));
      if (selectedQuarter)          p.set('quarter',     encodeURIComponent(selectedQuarter));
      if (sortCol !== 'acquisition_start_time') p.set('sort', sortCol);
      if (sortDir !== 'desc')                   p.set('dir',  sortDir);
      if (page > 0)                             p.set('page', String(page));
      const qs = p.toString();
      history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
    }

    // -- Filter state (restored from URL) ------------------------------------
    const initial = readUrlState();
    const selectedProjects    = new Set(initial.projects);
    const selectedInstruments = new Set(initial.instruments);
    // Quarters ascending (oldest first) for carousel navigation
    const allQuarters = collectQuarters(allRows).slice().reverse();

    // Last complete quarter: back up one quarter from today
    function lastCompleteQuarter() {
      const now = new Date();
      let year = now.getUTCFullYear();
      let q = Math.floor(now.getUTCMonth() / 3) + 1 - 1; // previous quarter
      if (q === 0) { q = 4; year -= 1; }
      return `${year}-Q${q}`;
    }

    // Default to last complete quarter; fall back to newest available
    const defaultQuarter = allQuarters.includes(lastCompleteQuarter())
      ? lastCompleteQuarter()
      : (allQuarters[allQuarters.length - 1] ?? null);
    let selectedQuarter = (initial.quarter && allQuarters.includes(initial.quarter))
      ? initial.quarter
      : defaultQuarter;

    // Unique option lists from all rows
    const allProjects = uniqueValues(allRows, 'project_name');
    const allInstruments = uniqueValues(allRows, 'instrument_id');

    // -- Layout --------------------------------------------------------------
    const layout = document.createElement('div');
    layout.className = 'sessions-layout';

    // Left panel — filters
    const filterPanel = document.createElement('div');
    filterPanel.className = 'sessions-filter-panel';

    // Right panel — summary stats
    const statsPanel = document.createElement('div');
    statsPanel.className = 'sessions-stats-panel';

    // Table area below
    const tableArea = document.createElement('div');
    tableArea.className = 'sessions-table-area';

    layout.appendChild(filterPanel);
    layout.appendChild(statsPanel);
    container.appendChild(layout);
    container.appendChild(tableArea);

    // -- Filter panel --------------------------------------------------------
    filterPanel.innerHTML = `<h3 class="sessions-panel-title">Filters</h3>`;

    function buildMultiSelect(title, options, selectedSet, onChange) {
      const wrapper = document.createElement('div');
      wrapper.className = 'sessions-filter-group';

      const label = document.createElement('label');
      label.className = 'sessions-filter-label';
      label.textContent = title;
      wrapper.appendChild(label);

      const select = document.createElement('select');
      select.multiple = true;
      select.size = Math.min(options.length, 8);
      select.className = 'sessions-multiselect';

      for (const opt of options) {
        const el = document.createElement('option');
        el.value = opt;
        el.textContent = opt;
        select.appendChild(el);
      }

      select.addEventListener('change', () => {
        selectedSet.clear();
        for (const opt of select.selectedOptions) {
          selectedSet.add(opt.value);
        }
        onChange();
      });

      const hint = document.createElement('span');
      hint.className = 'sessions-filter-hint';
      hint.textContent = 'Cmd/Ctrl+click to multi-select';
      wrapper.appendChild(select);
      wrapper.appendChild(hint);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'sessions-filter-clear';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => {
        for (const opt of select.options) opt.selected = false;
        selectedSet.clear();
        onChange();
      });
      wrapper.appendChild(clearBtn);

      return { wrapper, select };
    }

    const projectGroup    = buildMultiSelect('Project',       allProjects,    selectedProjects,    onFilterChange);
    const instrumentGroup = buildMultiSelect('Instrument ID', allInstruments, selectedInstruments, onFilterChange);
    // Restore multi-select DOM selections from URL state
    function restoreMultiSelect(selectEl, selectedSet) {
      for (const opt of selectEl.options) {
        opt.selected = selectedSet.has(opt.value);
      }
    }
    restoreMultiSelect(projectGroup.select,    selectedProjects);
    restoreMultiSelect(instrumentGroup.select, selectedInstruments);

    // Quarter carousel
    function buildQuarterCarousel() {
      const wrapper = document.createElement('div');
      wrapper.className = 'sessions-filter-group';

      const labelEl = document.createElement('label');
      labelEl.className = 'sessions-filter-label';
      labelEl.textContent = 'Quarter';
      wrapper.appendChild(labelEl);

      const carousel = document.createElement('div');
      carousel.className = 'sessions-quarter-carousel';

      const prevBtn = document.createElement('button');
      prevBtn.className = 'sessions-carousel-btn';
      prevBtn.textContent = '<';
      prevBtn.setAttribute('aria-label', 'Previous (older) quarter');

      const display = document.createElement('span');
      display.className = 'sessions-carousel-label';

      const nextBtn = document.createElement('button');
      nextBtn.className = 'sessions-carousel-btn';
      nextBtn.textContent = '>';
      nextBtn.setAttribute('aria-label', 'Next (newer) quarter');

      carousel.appendChild(prevBtn);
      carousel.appendChild(display);
      carousel.appendChild(nextBtn);
      wrapper.appendChild(carousel);

      function currentIdx() {
        return selectedQuarter ? allQuarters.indexOf(selectedQuarter) : allQuarters.length - 1;
      }

      function updateCarousel() {
        const idx = currentIdx();
        display.textContent = allQuarters[idx]?.replace('-Q', ' Q') ?? '';
        prevBtn.disabled = idx <= 0;
        nextBtn.disabled = idx >= allQuarters.length - 1;
      }

      prevBtn.addEventListener('click', () => {
        const idx = currentIdx();
        if (idx > 0) selectedQuarter = allQuarters[idx - 1];
        updateCarousel();
        onFilterChange();
      });

      nextBtn.addEventListener('click', () => {
        const idx = currentIdx();
        if (idx < allQuarters.length - 1) selectedQuarter = allQuarters[idx + 1];
        updateCarousel();
        onFilterChange();
      });

      updateCarousel();
      return wrapper;
    }

    filterPanel.appendChild(projectGroup.wrapper);
    filterPanel.appendChild(instrumentGroup.wrapper);
    filterPanel.appendChild(buildQuarterCarousel());

    // -- Stats panel ---------------------------------------------------------
    statsPanel.innerHTML = `<h3 class="sessions-panel-title">Summary</h3>`;

    const statsWarningEl = document.createElement('div');
    statsWarningEl.className = 'sessions-stat-warning';
    statsPanel.appendChild(statsWarningEl);

    const statsTotalEl = document.createElement('div');
    statsTotalEl.className = 'sessions-stat-block';
    statsPanel.appendChild(statsTotalEl);

    const statsExperimenterEl = document.createElement('div');
    statsExperimenterEl.className = 'sessions-stat-block';
    statsPanel.appendChild(statsExperimenterEl);

    const statsProjectEl = document.createElement('div');
    statsProjectEl.className = 'sessions-stat-block';
    statsPanel.appendChild(statsProjectEl);

    // -- Table ---------------------------------------------------------------
    let sortCol = initial.sort;
    let sortDir = initial.dir;
    let columnFilters = Object.fromEntries(DISPLAY_COLUMNS.map((c) => [c, '']));
    let page = initial.page;

    const uniques = {};
    for (const col of DISPLAY_COLUMNS) {
      uniques[col] = uniqueValues(allRows, col);
    }

    const headerRowHtml = DISPLAY_COLUMNS.map((col) => {
      const label = COLUMN_LABELS[col] ?? col;
      let filterEl;
      if (uniques[col].length > 0 && uniques[col].length <= SELECT_THRESHOLD) {
        const options = uniques[col]
          .map((v) => `<option value="${escHtml(v)}">${escHtml(v)}</option>`)
          .join('');
        filterEl = `<select class="col-filter" data-col="${col}"><option value="">— all —</option>${options}</select>`;
      } else {
        filterEl = `<input class="col-filter" type="text" data-col="${col}" placeholder="filter…" />`;
      }
      return `<th class="sortable" data-col="${col}"><span class="col-label">${label}</span>${filterEl}</th>`;
    }).join('');

    const table = document.createElement('table');
    table.className = 'assets-table';
    table.innerHTML = `<thead><tr>${headerRowHtml}</tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    const pagingBar = document.createElement('div');
    pagingBar.className = 'assets-paging';

    tableArea.appendChild(table);
    tableArea.appendChild(pagingBar);

    // -- Event wiring --------------------------------------------------------

    table.querySelector('thead').addEventListener('click', (e) => {
      const th = e.target.closest('th.sortable');
      if (!th) return;
      if (e.target.classList.contains('col-filter')) return;
      const col = th.dataset.col;
      if (!col) return;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = 'asc';
      }
      page = 0;
      refresh();
    });

    table.querySelector('thead').addEventListener('input', (e) => {
      const el = e.target;
      if (!el.classList.contains('col-filter')) return;
      columnFilters[el.dataset.col] = el.value;
      page = 0;
      refresh();
    });

    table.querySelector('thead').addEventListener('change', (e) => {
      const el = e.target;
      if (!el.classList.contains('col-filter')) return;
      columnFilters[el.dataset.col] = el.value;
      page = 0;
      refresh();
    });

    // -- Render loop ---------------------------------------------------------

    function getFilteredRows() {
      const quarterSet = selectedQuarter ? new Set([selectedQuarter]) : new Set();
      let rows = applyFilters(allRows, selectedProjects, selectedInstruments, quarterSet);
      // Apply column text/select filters
      const colEntries = Object.entries(columnFilters).filter(([, v]) => v !== '');
      if (colEntries.length > 0) {
        rows = rows.filter((row) =>
          colEntries.every(([col, val]) => {
            const cell = String(row[col] ?? '').toLowerCase();
            return cell.includes(val.toLowerCase());
          }),
        );
      }
      return rows;
    }

    function updateStats(filteredRows) {
      // In-progress quarter warning
      const currentQ = getQuarterLabel(new Date().toISOString());
      if (selectedQuarter === currentQ) {
        statsWarningEl.textContent = 'Warning: this quarter is in progress!';
        statsWarningEl.hidden = false;
      } else {
        statsWarningEl.hidden = true;
      }

      // Total
      statsTotalEl.innerHTML = `
        <div class="sessions-stat-title">Total Sessions</div>
        <div class="sessions-stat-value">${filteredRows.length.toLocaleString()}</div>
      `;

      // By experimenter
      const byExp = countByExperimenter(filteredRows);
      const expRows = byExp
        .map(({ experimenter, count }) =>
          `<tr><td>${escHtml(experimenter)}</td><td class="stat-count">${count.toLocaleString()}</td></tr>`,
        )
        .join('');
      statsExperimenterEl.innerHTML = `
        <div class="sessions-stat-title">Sessions by Experimenter</div>
        <table class="sessions-stat-table">
          <thead><tr><th>Experimenter</th><th>Count</th></tr></thead>
          <tbody>${expRows || '<tr><td colspan="2">No data</td></tr>'}</tbody>
        </table>
      `;

      // By project
      const byProj = countByProject(filteredRows);
      const projRows = byProj
        .map(({ project, count }) =>
          `<tr><td>${escHtml(project)}</td><td class="stat-count">${count.toLocaleString()}</td></tr>`,
        )
        .join('');
      statsProjectEl.innerHTML = `
        <div class="sessions-stat-title">Sessions by Project</div>
        <table class="sessions-stat-table">
          <thead><tr><th>Project</th><th>Count</th></tr></thead>
          <tbody>${projRows || '<tr><td colspan="2">No data</td></tr>'}</tbody>
        </table>
      `;
    }

    function updateSortIndicators() {
      table.querySelectorAll('th.sortable').forEach((th) => {
        const col = th.dataset.col;
        const label = COLUMN_LABELS[col] ?? col;
        const arrow = col === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        th.querySelector('.col-label').textContent = label + arrow;
      });
    }

    function refresh() {
      const filtered = getFilteredRows();
      const sorted = sortRows([...filtered], sortCol, sortDir);

      const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
      if (page >= totalPages) page = totalPages - 1;

      const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      tbody.innerHTML = pageRows.map(renderSessionRow).join('');

      const start = sorted.length === 0 ? 0 : page * PAGE_SIZE + 1;
      const end = Math.min((page + 1) * PAGE_SIZE, sorted.length);
      pagingBar.innerHTML = `
        <button class="page-btn" id="sess-prev" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="page-info">${start}–${end} of ${sorted.length.toLocaleString()}</span>
        <button class="page-btn" id="sess-next" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
      `;
      pagingBar.querySelector('#sess-prev').addEventListener('click', () => { page--; refresh(); });
      pagingBar.querySelector('#sess-next').addEventListener('click', () => { page++; refresh(); });

      updateSortIndicators();
      updateStats(filtered);
      writeUrlState();
    }

    function onFilterChange() {
      page = 0;
      refresh();
    }

    refresh();
  }

  return container;
}

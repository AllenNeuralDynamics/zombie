/**
 * assets-view.js — Assets table page.
 *
 * Queries the `asset_basics` DuckDB table (registered at startup by metadata.js)
 * and renders a sortable HTML table with clickable link columns.
 *
 * Pure helpers (buildS3ConsoleUrl, buildQcLink, buildMetadataLink, buildCoLink,
 * formatAssetRow) are exported for unit testing.
 */

import { escHtml, formatDatetime, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD } from '../lib/utils.js';
import { queryRows } from '../lib/arrow.js';
import { buildModalityHistogram } from '../lib/charts.js';

// Re-export for backward compatibility with tests
export { formatDatetime, sortRows, uniqueValues, filterRows };

// ---------------------------------------------------------------------------
// Pure link builders
// ---------------------------------------------------------------------------

/**
 * Convert an S3 URI to an AWS console URL.
 *
 * s3://bucket/key/path  →  https://s3.console.aws.amazon.com/s3/buckets/bucket?prefix=key/path/
 *
 * @param {string|null} location - e.g. "s3://aind-data/my-project/asset/"
 * @returns {string|null}
 */
export function buildS3ConsoleUrl(location) {
  if (!location || !location.startsWith('s3://')) return null;
  const withoutScheme = location.slice(5); // drop "s3://"
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx === -1) {
    return `https://s3.console.aws.amazon.com/s3/buckets/${withoutScheme}`;
  }
  const bucket = withoutScheme.slice(0, slashIdx);
  const prefix = withoutScheme.slice(slashIdx + 1);
  // Ensure trailing slash so the console shows the folder contents.
  const trailingPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `https://s3.console.aws.amazon.com/s3/buckets/${bucket}?prefix=${trailingPrefix}`;
}

/**
 * Build the AIND QC portal URL for an asset.
 *
 * @param {string|null} name - Asset name column value.
 * @returns {string|null}
 */
export function buildQcLink(name) {
  if (!name) return null;
  return `/quality_control?name=${encodeURIComponent(name)}`;
}

/**
 * Build the AIND metadata portal URL for an asset.
 *
 * @param {string|null} name - Asset name column value.
 * @returns {string|null}
 */
export function buildMetadataLink(name) {
  if (!name) return null;
  return `https://metadata-portal.allenneuraldynamics.org/view?name=${encodeURIComponent(name)}`;
}

/**
 * Build the Code Ocean data-asset URL.
 *
 * @param {string|null} codeOcean - Data-asset ID or null.
 * @returns {string|null}
 */
export function buildCoLink(codeOcean) {
  if (!codeOcean) return null;
  return `https://codeocean.allenneuraldynamics.org/data-assets/${codeOcean}`;
}

/**
 * Build an anchor tag or a fallback text node.
 *
 * @param {string|null} href
 * @param {string} label
 * @returns {string} HTML fragment
 */
function linkHtml(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

const ALL_AVAILABLE_COLUMNS = [
  '_id',
  'name',
  'subject_id',
  'acquisition_start_time',
  'acquisition_end_time',
  'project_name',
  'modalities',
  'data_level',
  'acquisition_type',
  'genotype',
  'age',
  'experimenters',
  'experimenters_normalized',
  'investigators',
  'investigators_normalized',
  'instrument_id',
  'instrument_id_normalized',
  'location',
  'code_ocean',
  'process_date',
];

const DEFAULT_DISPLAY_COLUMNS = [
  'subject_id',
  'acquisition_start_time',
  'project_name',
  'modalities',
  'data_level',
  'acquisition_type',
];

const COLUMN_LABELS = {
  _id: 'ID',
  name: 'Asset Name',
  subject_id: 'Subject',
  acquisition_start_time: 'Acquired (UTC)',
  acquisition_end_time: 'Acquisition End (UTC)',
  project_name: 'Project',
  modalities: 'Modalities',
  data_level: 'Level',
  acquisition_type: 'Acquisition Type',
  genotype: 'Genotype',
  age: 'Age (days)',
  experimenters: 'Experimenters',
  experimenters_normalized: 'Experimenters (normalized)',
  investigators: 'Investigators',
  investigators_normalized: 'Investigators (normalized)',
  instrument_id: 'Instrument ID',
  instrument_id_normalized: 'Instrument ID (normalized)',
  location: 'Location',
  code_ocean: 'Code Ocean',
  process_date: 'Processed',
};

export function renderAssetRow(row, visibleColumns) {
  const s3Href = buildS3ConsoleUrl(row.location ?? null);
  const qcHref = buildQcLink(row.name ?? null);
  const metaHref = buildMetadataLink(row.name ?? null);
  const coHref = buildCoLink(row.code_ocean ?? null);
  const acqTime = formatDatetime(row.acquisition_start_time ?? null);
  const acqEndTime = formatDatetime(row.acquisition_end_time ?? null);
  const procDate = formatDatetime(row.process_date ?? null);

  const cellValues = {
    _id: row._id ?? '',
    name: row.name ?? '',
    subject_id: `<a href="/subject?subject_id=${encodeURIComponent(row.subject_id ?? '')}">${escHtml(row.subject_id ?? '')}</a>`,
    acquisition_start_time: acqTime,
    acquisition_end_time: acqEndTime,
    project_name: row.project_name ? `<a href="/project?project=${encodeURIComponent(row.project_name)}">${escHtml(row.project_name)}</a>` : '',
    modalities: Array.isArray(row.modalities) ? row.modalities.join(', ') : (row.modalities ?? ''),
    data_level: row.data_level ?? '',
    acquisition_type: row.acquisition_type ?? '',
    genotype: row.genotype ?? '',
    age: row.age != null ? String(row.age) : '',
    experimenters: escHtml(Array.isArray(row.experimenters) ? row.experimenters.join(', ') : (row.experimenters ?? '')),
    experimenters_normalized: escHtml(Array.isArray(row.experimenters_normalized) ? row.experimenters_normalized.join(', ') : (row.experimenters_normalized ?? '')),
    investigators: escHtml(Array.isArray(row.investigators) ? row.investigators.join(', ') : (row.investigators ?? '')),
    investigators_normalized: escHtml(Array.isArray(row.investigators_normalized) ? row.investigators_normalized.join(', ') : (row.investigators_normalized ?? '')),
    instrument_id: escHtml(row.instrument_id ?? ''),
    instrument_id_normalized: escHtml(row.instrument_id_normalized ?? ''),
    location: row.location ?? '',
    code_ocean: row.code_ocean ?? '',
    process_date: procDate,
  };

  const cells = visibleColumns.map((col) => {
    if (col === 'links') {
      return `<td class="link-cell">` +
        `${linkHtml(s3Href, 'S3')} ` +
        `${linkHtml(coHref, 'CO')} ` +
        `${linkHtml(metaHref, 'Meta')} ` +
        `${linkHtml(qcHref, 'QC')}` +
        `</td>`;
    }
    return `<td>${cellValues[col]}</td>`;
  });

  return `<tr>${cells.join('')}</tr>`;
}

// ---------------------------------------------------------------------------
// Sort state
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assets overview
// ---------------------------------------------------------------------------

/**
 * Build the "Data Overview" section — total counts + modality histogram.
 * Appended before the table in createAssetsView.
 *
 * @param {import('@uwdata/vgplot').Coordinator} coord
 * @returns {HTMLElement}
 */
const OVERVIEW_COOKIE = 'assets_overview_collapsed';

function _readCookie(name) {
  const m = ('; ' + document.cookie).split(`; ${name}=`);
  if (m.length < 2) return null;
  return decodeURIComponent(m.pop().split(';')[0]);
}

function _writeCookie(name, value) {
  const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
}

function buildAssetsOverview(coord) {
  let collapsed = _readCookie(OVERVIEW_COOKIE) === '1';

  const section = document.createElement('div');
  section.className = 'platform-overview';

  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'platform-qc-toggle';
  collapseBtn.setAttribute('aria-expanded', String(!collapsed));

  const arrow = document.createElement('span');
  arrow.className = 'platform-qc-toggle-arrow';
  arrow.textContent = collapsed ? '▶' : '▼';
  collapseBtn.appendChild(arrow);

  const labelText = document.createTextNode(' Data overview');
  collapseBtn.appendChild(labelText);

  section.appendChild(collapseBtn);

  const bodyRow = document.createElement('div');
  bodyRow.className = 'platform-overview-body';
  bodyRow.hidden = collapsed;
  section.appendChild(bodyRow);

  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    bodyRow.hidden = collapsed;
    arrow.textContent = collapsed ? '▶' : '▼';
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    _writeCookie(OVERVIEW_COOKIE, collapsed ? '1' : '0');
  });

  // ── Left: stat list ──────────────────────────────────────────────────────
  const leftCol = document.createElement('div');
  leftCol.className = 'platform-overview-left';
  bodyRow.appendChild(leftCol);

  const statList = document.createElement('div');
  statList.className = 'assets-stat-list';
  statList.textContent = 'Loading…';
  leftCol.appendChild(statList);

  // ── Right: modality histogram ─────────────────────────────────────────────
  const histCol = document.createElement('div');
  histCol.className = 'platform-overview-histogram';
  bodyRow.appendChild(histCol);

  const histPlot = document.createElement('div');
  histPlot.className = 'platform-overview-histogram-plot';
  histCol.appendChild(histPlot);

  // ── Stats query ────────────────────────────────────────────────────────────
  coord
    .query(`
      SELECT
        (SELECT COUNT(*) FROM asset_basics) AS total_assets,
        (SELECT COUNT(DISTINCT subject_id) FROM asset_basics WHERE subject_id IS NOT NULL) AS total_subjects,
        (SELECT COUNT(*) FROM unique_project_names) AS total_projects,
        (SELECT COUNT(DISTINCT investigator)
          FROM (SELECT UNNEST(investigators_normalized) AS investigator
                FROM asset_basics
                WHERE investigators_normalized IS NOT NULL)) AS total_investigators
    `)
    .then((result) => {
      const row = result.get(0) ?? {};
      const fmt = (n) => Number(n ?? 0).toLocaleString();
      const stats = [
        { count: fmt(row.total_assets),        label: 'Total assets' },
        { count: fmt(row.total_subjects),      label: 'Unique subjects' },
        { count: fmt(row.total_projects),      label: 'Projects' },
        { count: fmt(row.total_investigators), label: 'Unique investigators' },
      ];
      statList.textContent = '';
      for (const { count, label } of stats) {
        const item = document.createElement('div');
        item.className = 'assets-stat-item';
        const countEl = document.createElement('span');
        countEl.className = 'assets-stat-count';
        countEl.textContent = count;
        const labelEl = document.createElement('span');
        labelEl.className = 'assets-stat-label';
        labelEl.textContent = label;
        item.appendChild(countEl);
        item.appendChild(labelEl);
        statList.appendChild(item);
      }
    })
    .catch((err) => {
      statList.textContent = `Summary unavailable: ${err?.message ?? err}`;
    });

  // ── Histogram query ────────────────────────────────────────────────────────
  coord
    .query(`
      SELECT acquisition_start_time, modalities
      FROM asset_basics
      WHERE (data_level IS NULL OR data_level != 'derived')
        AND acquisition_start_time IS NOT NULL
        AND modalities IS NOT NULL
    `)
    .then((result) => {
      // arrowTableToRows handles list-typed modalities columns
      const fields = result.schema.fields.map((f) => f.name);
      const rows = [];
      for (let i = 0; i < result.numRows; i++) {
        const r = {};
        for (const f of fields) {
          const col = result.getChild(f);
          if (!col) { r[f] = null; continue; }
          const val = col.get(i);
          r[f] = (val != null && typeof val === 'object' && typeof val.toArray === 'function' && !Array.isArray(val))
            ? Array.from(val.toArray()) : val;
        }
        rows.push(r);
      }
      const width = histPlot.getBoundingClientRect().width || 500;
      const plot = buildModalityHistogram(rows, width, { xTicks: 'year' });
      if (plot) histPlot.appendChild(plot);
    })
    .catch((err) => {
      console.error('[AssetsOverview] histogram query failed:', err?.message ?? err);
    });

  return section;
}

// ---------------------------------------------------------------------------
// View factory
// ---------------------------------------------------------------------------

/**
 * Create the assets view element.
 *
 * Queries `asset_basics` (already registered in DuckDB by metadata.js at startup),
 * then renders a sortable, filterable, paginated HTML table.
 *
 * @param {import('@uwdata/vgplot').Coordinator} coord - Mosaic coordinator.
 * @returns {HTMLElement}
 */
export function createAssetsView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view';

  const header = document.createElement('div');
  header.className = 'assets-header';
  header.innerHTML = '<h2>Data Assets</h2>';
  
  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'assets-settings-btn icon-btn';
  settingsBtn.setAttribute('aria-label', 'Column settings');
  settingsBtn.innerHTML = '<img src="/icons/gear.svg" alt="Settings" />';
  header.appendChild(settingsBtn);
  
  container.appendChild(header);
  container.appendChild(buildAssetsOverview(coord));

  const loadingEl = document.createElement('p');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading assets…';
  container.appendChild(loadingEl);

  const sql = `
    SELECT
      _id, name, subject_id, acquisition_start_time, acquisition_end_time,
      project_name, modalities, data_level, acquisition_type, genotype, age,
      experimenters, experimenters_normalized, investigators, investigators_normalized,
      instrument_id, instrument_id_normalized, location, code_ocean, process_date
    FROM asset_basics
    ORDER BY acquisition_start_time DESC NULLS LAST
  `;

  queryRows(coord, sql)
    .then((rows) => {
      loadingEl.remove();
      buildTable(rows, settingsBtn);
    })
    .catch((err) => {
      loadingEl.textContent = `Failed to load assets: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    });

  function buildTable(allRows, settingsBtn) {
    let sortCol = 'acquisition_start_time';
    let sortDir = 'desc';
    let visibleColumns = [...DEFAULT_DISPLAY_COLUMNS, 'links'];
    let filters = Object.fromEntries(ALL_AVAILABLE_COLUMNS.map((c) => [c, '']));
    let page = 0;

    const uniques = {};
    for (const col of ALL_AVAILABLE_COLUMNS) {
      uniques[col] = uniqueValues(allRows, col, { split: col === 'modalities' ? ',' : null });
    }

    const useSelect = {};
    for (const col of ALL_AVAILABLE_COLUMNS) {
      useSelect[col] = uniques[col].length > 0 && uniques[col].length <= SELECT_THRESHOLD;
    }

    const COOKIE_NAME = 'assets_cols';

    function readColsFromCookie() {
      const entry = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE_NAME}=`));
      if (!entry) return null;
      const cols = decodeURIComponent(entry.slice(COOKIE_NAME.length + 1))
        .split(',')
        .filter((c) => ALL_AVAILABLE_COLUMNS.includes(c));
      return cols.length > 0 ? cols : null;
    }

    function writeColsToCookie(cols) {
      if (JSON.stringify(cols) === JSON.stringify(DEFAULT_DISPLAY_COLUMNS)) {
        document.cookie = `${COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=Lax`;
      } else {
        const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
        document.cookie = `${COOKIE_NAME}=${encodeURIComponent(cols.join(','))}; expires=${expires}; path=/; SameSite=Lax`;
      }
    }

    function readFromUrl() {
      const params = new URLSearchParams(window.location.search);
      if (params.has('sort') && ALL_AVAILABLE_COLUMNS.includes(params.get('sort'))) sortCol = params.get('sort');
      if (params.has('dir') && ['asc', 'desc'].includes(params.get('dir'))) sortDir = params.get('dir');
      if (params.has('page')) {
        const p = parseInt(params.get('page'), 10);
        if (!isNaN(p) && p >= 0) page = p;
      }
      if (params.has('cols')) {
        const cols = params.get('cols').split(',').filter((c) => ALL_AVAILABLE_COLUMNS.includes(c));
        if (cols.length > 0) visibleColumns = [...cols, 'links'];
      } else {
        const cookieCols = readColsFromCookie();
        if (cookieCols) visibleColumns = [...cookieCols, 'links'];
      }
      for (const col of ALL_AVAILABLE_COLUMNS) {
        if (params.has(`f_${col}`)) filters[col] = params.get(`f_${col}`);
      }
    }

    function writeToUrl() {
      const params = new URLSearchParams();
      if (sortCol !== 'acquisition_start_time') params.set('sort', sortCol);
      if (sortDir !== 'desc') params.set('dir', sortDir);
      if (page !== 0) params.set('page', String(page));
      const dataCols = visibleColumns.filter((c) => c !== 'links');
      const isDefault = JSON.stringify(dataCols) === JSON.stringify(DEFAULT_DISPLAY_COLUMNS);
      if (!isDefault) {
        params.set('cols', dataCols.join(','));
      }
      writeColsToCookie(dataCols);
      for (const col of ALL_AVAILABLE_COLUMNS) {
        if (filters[col]) params.set(`f_${col}`, filters[col]);
      }
      const qs = params.toString();
      history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
    }

    readFromUrl();

    const table = document.createElement('table');
    table.className = 'assets-table';
    
    const tbody = document.createElement('tbody');
    const thead = document.createElement('thead');
    table.appendChild(thead);
    table.appendChild(tbody);

    const pagingBar = document.createElement('div');
    pagingBar.className = 'assets-paging';

    container.appendChild(table);
    container.appendChild(pagingBar);

    let settingsModalOpen = false;

    function renderHeader() {
      const headerRowHtml = visibleColumns.map((col) => {
        const label = COLUMN_LABELS[col] ?? col;
        if (col === 'links') {
          return `<th class="col-links"><span class="col-label">${label}</span></th>`;
        }
        let filterEl;
        if (useSelect[col]) {
          const options = uniques[col]
            .map((v) => `<option value="${escHtml(v)}">${escHtml(v)}</option>`)
            .join('');
          filterEl = `<select class="col-filter" data-col="${col}"><option value="">— all —</option>${options}</select>`;
        } else {
          filterEl = `<input class="col-filter" type="text" data-col="${col}" placeholder="filter…" />`;
        }
        return `<th class="sortable" data-col="${col}"><span class="col-label">${label}</span>${filterEl}</th>`;
      }).join('');

      thead.innerHTML = `<tr>${headerRowHtml}</tr>`;

      thead.addEventListener('click', (e) => {
        if (!e.target.closest('.col-label')) return;
        const th = e.target.closest('th.sortable');
        if (!th) return;
        const col = th.dataset.col;
        if (sortCol === col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col;
          sortDir = 'asc';
        }
        page = 0;
        refresh();
      });

      thead.addEventListener('input', (e) => {
        const el = e.target.closest('.col-filter');
        if (!el) return;
        filters[el.dataset.col] = el.value;
        page = 0;
        refresh();
      });
      thead.addEventListener('change', (e) => {
        const el = e.target.closest('.col-filter');
        if (!el) return;
        filters[el.dataset.col] = el.value;
        page = 0;
        refresh();
      });

      restoreFilterInputs();
      updateSortIndicators();
    }

    function restoreFilterInputs() {
      thead.querySelectorAll('.col-filter').forEach((el) => {
        const col = el.dataset.col;
        if (filters[col]) el.value = filters[col];
      });
    }

    function updateSortIndicators() {
      thead.querySelectorAll('th.sortable').forEach((th) => {
        const col = th.dataset.col;
        th.dataset.sortDir = col === sortCol ? sortDir : '';
        const label = COLUMN_LABELS[col] ?? col;
        const arrow = col === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        th.querySelector('.col-label').textContent = label + arrow;
      });
    }

    function visibleRows() {
      const filtered = filterRows(allRows, filters);
      const sorted = sortRows(filtered, sortCol, sortDir);
      return sorted;
    }

    function refresh() {
      writeToUrl();
      const rows = visibleRows();
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (page >= totalPages) page = totalPages - 1;

      const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      tbody.innerHTML = pageRows.map((row) => renderAssetRow(row, visibleColumns)).join('');

      const start = rows.length === 0 ? 0 : page * PAGE_SIZE + 1;
      const end = Math.min((page + 1) * PAGE_SIZE, rows.length);
      pagingBar.innerHTML = `
        <button class="page-btn" id="prev-page" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="page-info">${start}–${end} of ${rows.length.toLocaleString()}</span>
        <button class="page-btn" id="next-page" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
      `;
      pagingBar.querySelector('#prev-page').addEventListener('click', () => { page--; refresh(); });
      pagingBar.querySelector('#next-page').addEventListener('click', () => { page++; refresh(); });

      updateSortIndicators();
    }

    function openSettingsModal() {
      if (settingsModalOpen) {
        settingsModal.remove();
        settingsModalOpen = false;
        return;
      }

      const settingsModal = document.createElement('div');
      settingsModal.className = 'assets-settings-modal';

      const listHtml = ALL_AVAILABLE_COLUMNS
        .map((col) => {
          const isChecked = visibleColumns.includes(col);
          return `
            <label class="settings-checkbox-label">
              <input type="checkbox" class="settings-col-checkbox" data-col="${col}" ${isChecked ? 'checked' : ''} />
              <span>${COLUMN_LABELS[col] ?? col}</span>
            </label>
          `;
        })
        .join('');

      settingsModal.innerHTML = `
        <div class="settings-modal-content">
          <h3>Visible Columns</h3>
          <div class="settings-checkbox-list">
            ${listHtml}
          </div>
          <div class="settings-modal-actions">
            <button class="settings-reset-btn">Reset to Defaults</button>
            <button class="settings-close-btn">Close</button>
          </div>
        </div>
      `;

      document.body.appendChild(settingsModal);
      settingsModalOpen = true;

      settingsModal.querySelectorAll('.settings-col-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          const col = checkbox.dataset.col;
          if (checkbox.checked) {
            if (!visibleColumns.includes(col) && col !== 'links') {
              visibleColumns.splice(visibleColumns.length - 1, 0, col);
            }
          } else {
            visibleColumns = visibleColumns.filter((c) => c !== col);
          }
          renderHeader();
          refresh();
        });
      });

      settingsModal.querySelector('.settings-close-btn').addEventListener('click', () => {
        settingsModal.remove();
        settingsModalOpen = false;
      });

      settingsModal.querySelector('.settings-reset-btn').addEventListener('click', () => {
        visibleColumns = [...DEFAULT_DISPLAY_COLUMNS, 'links'];
        renderHeader();
        refresh();
        settingsModal.querySelectorAll('.settings-col-checkbox').forEach((checkbox) => {
          const col = checkbox.dataset.col;
          checkbox.checked = DEFAULT_DISPLAY_COLUMNS.includes(col);
        });
      });

      settingsModal.addEventListener('click', (e) => {
        if (e.target === settingsModal) {
          settingsModal.remove();
          settingsModalOpen = false;
        }
      });
    }

    settingsBtn.addEventListener('click', openSettingsModal);

    renderHeader();
    refresh();
  }

  return container;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

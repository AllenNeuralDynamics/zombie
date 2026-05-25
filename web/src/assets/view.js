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
  'genotype',
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
  'genotype',
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
  genotype: 'Genotype',
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
    modalities: row.modalities ?? '',
    data_level: row.data_level ?? '',
    genotype: row.genotype ?? '',
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

  const loadingEl = document.createElement('p');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading assets…';
  container.appendChild(loadingEl);

  const sql = `
    SELECT
      _id, name, subject_id, acquisition_start_time, acquisition_end_time,
      project_name, modalities, data_level, genotype, location, code_ocean,
      process_date
    FROM asset_basics
    ORDER BY acquisition_start_time DESC NULLS LAST
  `;

  coord.query(sql, { type: 'json' })
    .then((result) => {
      loadingEl.remove();
      const rows = Array.isArray(result) ? result
        : Array.isArray(result?.data) ? result.data
        : Array.from(result ?? []);
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
      if (JSON.stringify(dataCols) !== JSON.stringify(DEFAULT_DISPLAY_COLUMNS)) {
        params.set('cols', dataCols.join(','));
      }
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

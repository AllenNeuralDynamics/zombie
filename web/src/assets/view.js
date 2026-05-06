/**
 * assets-view.js — Assets table page.
 *
 * Queries the `asset_basics` DuckDB table (registered at startup by metadata.js)
 * and renders a sortable HTML table with clickable link columns.
 *
 * Pure helpers (buildS3ConsoleUrl, buildQcLink, buildMetadataLink, buildCoLink,
 * formatAssetRow) are exported for unit testing.
 */

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
  return `https://qc.allenneuraldynamics.org/view?name=${encodeURIComponent(name)}`;
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
 * Format an ISO datetime string to "YYYY-MM-DD HH:MM" (UTC, no seconds).
 *
 * @param {string|null} iso
 * @returns {string}
 */
export function formatDatetime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  } catch {
    return String(iso);
  }
}

// ---------------------------------------------------------------------------
// Table rendering helpers
// ---------------------------------------------------------------------------

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

/** Columns displayed in the table, in order. */
const DISPLAY_COLUMNS = [
  'subject_id',
  'acquisition_start_time',
  'project_name',
  'modalities',
  'data_level',
  'genotype',
];

/** Column header labels. */
const COLUMN_LABELS = {
  subject_id: 'Subject',
  acquisition_start_time: 'Acquired (UTC)',
  project_name: 'Project',
  modalities: 'Modalities',
  data_level: 'Level',
  genotype: 'Genotype',
};

/**
 * Render one table row as an HTML string.
 *
 * @param {object} row - Plain object with asset_basics columns.
 * @returns {string} `<tr>…</tr>` HTML
 */
export function renderAssetRow(row) {
  const s3Href = buildS3ConsoleUrl(row.location ?? null);
  const qcHref = buildQcLink(row.name ?? null);
  const metaHref = buildMetadataLink(row.name ?? null);
  const coHref = buildCoLink(row.code_ocean ?? null);
  const acqTime = formatDatetime(row.acquisition_start_time ?? null);

  const cells = [
    `<td>${row.subject_id ?? ''}</td>`,
    `<td>${acqTime}</td>`,
    `<td>${row.project_name ?? ''}</td>`,
    `<td>${row.modalities ?? ''}</td>`,
    `<td>${row.data_level ?? ''}</td>`,
    `<td>${row.genotype ?? ''}</td>`,
    `<td class="link-cell">` +
      `${linkHtml(s3Href, 'S3')} ` +
      `${linkHtml(coHref, 'CO')} ` +
      `${linkHtml(metaHref, 'Meta')} ` +
      `${linkHtml(qcHref, 'QC')}` +
      `</td>`,
  ];

  return `<tr>${cells.join('')}</tr>`;
}

// ---------------------------------------------------------------------------
// Sort state
// ---------------------------------------------------------------------------

/**
 * Sort an array of row objects by a column.  Modifies the array in-place and
 * returns it.
 *
 * @param {object[]} rows
 * @param {string} col
 * @param {'asc'|'desc'} dir
 * @returns {object[]}
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
// Filter helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

/** Threshold for using a <select> instead of a text input in the filter row. */
const SELECT_THRESHOLD = 40;

/**
 * Collect unique non-null/non-empty values for a column, sorted lexicographically.
 *
 * @param {object[]} rows
 * @param {string} col
 * @returns {string[]}
 */
export function uniqueValues(rows, col) {
  const seen = new Set();
  for (const row of rows) {
    const v = row[col];
    if (v != null && v !== '') seen.add(String(v));
  }
  return Array.from(seen).sort();
}

/**
 * Apply per-column filters to a row array.
 * Text filters use case-insensitive substring match.
 * Select filters use exact match (after coercion to string).
 *
 * @param {object[]} rows
 * @param {Record<string, string>} filters - { colName: filterValue }
 * @returns {object[]}
 */
export function filterRows(rows, filters) {
  const entries = Object.entries(filters).filter(([, v]) => v !== '');
  if (entries.length === 0) return rows;
  return rows.filter((row) =>
    entries.every(([col, val]) => {
      const cell = String(row[col] ?? '').toLowerCase();
      return cell.includes(val.toLowerCase());
    }),
  );
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
      buildTable(rows);
    })
    .catch((err) => {
      loadingEl.textContent = `Failed to load assets: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    });

  /**
   * Build the full table DOM once data is available.  All subsequent state
   * changes (sort / filter / page) only update the <tbody> and pagination bar.
   */
  function buildTable(allRows) {
    // ── state ──────────────────────────────────────────────────────────────
    let sortCol = 'acquisition_start_time';
    let sortDir = 'desc';
    let filters = Object.fromEntries(DISPLAY_COLUMNS.map((c) => [c, '']));
    let page = 0; // 0-indexed

    // ── pre-compute unique values for each display column ──────────────────
    const uniques = {};
    for (const col of DISPLAY_COLUMNS) {
      uniques[col] = uniqueValues(allRows, col);
    }

    // ── column config: should this column use a <select> filter? ──────────
    const useSelect = {};
    for (const col of DISPLAY_COLUMNS) {
      useSelect[col] = uniques[col].length > 0 && uniques[col].length <= SELECT_THRESHOLD;
    }

    // ── build static skeleton ──────────────────────────────────────────────
    const allHeaders = [...DISPLAY_COLUMNS, 'links'];
    const allLabels = { ...COLUMN_LABELS, links: 'Links' };

    // Single header row: label (sortable) + filter control stacked in each <th>
    const headerRowHtml = allHeaders.map((col) => {
      const label = allLabels[col] ?? col;
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

    const table = document.createElement('table');
    table.className = 'assets-table';
    table.innerHTML = `
      <thead><tr>${headerRowHtml}</tr></thead>
      <tbody></tbody>
    `;

    const tbody = table.querySelector('tbody');

    // Pagination bar
    const pagingBar = document.createElement('div');
    pagingBar.className = 'assets-paging';

    container.appendChild(table);
    container.appendChild(pagingBar);

    // ── helpers ────────────────────────────────────────────────────────────

    /** Update sort-arrow indicators in the header row. */
    function updateSortIndicators() {
      table.querySelectorAll('th.sortable').forEach((th) => {
        const col = th.dataset.col;
        th.dataset.sortDir = col === sortCol ? sortDir : '';
        const label = allLabels[col] ?? col;
        const arrow = col === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        th.querySelector('.col-label').textContent = label + arrow;
      });
    }

    /** Derive visible rows from full dataset and current state. */
    function visibleRows() {
      const filtered = filterRows(allRows, filters);
      const sorted = sortRows(filtered, sortCol, sortDir);
      return sorted;
    }

    /** Re-render tbody and paging bar. */
    function refresh() {
      const rows = visibleRows();
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (page >= totalPages) page = totalPages - 1;

      const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      tbody.innerHTML = pageRows.map(renderAssetRow).join('');

      // Pagination bar
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

    // ── event listeners ───────────────────────────────────────────────────

    // Sort: click on the label span (not the filter input)
    table.querySelector('thead').addEventListener('click', (e) => {
      // Only trigger sort when clicking the label, not the filter control
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

    // Filter input / select changes
    table.querySelector('thead').addEventListener('input', (e) => {
      const el = e.target.closest('.col-filter');
      if (!el) return;
      filters[el.dataset.col] = el.value;
      page = 0;
      refresh();
    });
    table.querySelector('thead').addEventListener('change', (e) => {
      const el = e.target.closest('.col-filter');
      if (!el) return;
      filters[el.dataset.col] = el.value;
      page = 0;
      refresh();
    });

    refresh();
  }

  return container;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Escape a string for inclusion in HTML attribute values or text nodes. */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

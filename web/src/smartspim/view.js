/**
 * smartspim-view.js — SmartSPIM Assets page.
 *
 * Queries the `assets_smartspim` DuckDB table and renders two pie charts
 * (raw vs processed, by institution) plus a sortable, filterable, paginated
 * HTML table with a computed "Processed" column and clickable link columns.
 *
 * Pure helpers (buildNeuroglancerLink, isProcessed, renderSmartSpimRow,
 * institutionSlices, buildPieSvg, sortRows, uniqueValues, filterRows)
 * are exported for unit tests.
 */

import { registerAcornTable } from '../lib/metadata.js';
import { S3_BUCKET, S3_REGION } from '../constants.js';

// ---------------------------------------------------------------------------
// S3 path for fallback registration
// ---------------------------------------------------------------------------

const SMARTSPIM_S3_PATH =
  `s3://allen-data-views/data-asset-cache/zs_assets_smartspim.pqt`;

// ---------------------------------------------------------------------------
// Pure link builders
// ---------------------------------------------------------------------------

/**
 * Render a neuroglancer URL as an anchor tag or a dash placeholder.
 *
 * @param {string|null} href
 * @param {string} label
 * @returns {string} HTML fragment
 */
export function buildNeuroglancerLink(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  const safe = String(href).replace(/"/g, '&quot;');
  return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

/**
 * Return true when a row has both segmentation and quantification links.
 *
 * @param {object} row
 * @returns {boolean}
 */
export function isProcessed(row) {
  return row.processed === true || row.processed === 'true' || row.processed === 'Yes';
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

/** Columns displayed in the table, in order. */
const DISPLAY_COLUMNS = [
  'subject_id',
  'genotype',
  'institution',
  'acquisition_start_time',
  'processing_end_time',
  'channel_1',
  'channel_2',
  'channel_3',
  'processed',
];

/** Column header labels. */
const COLUMN_LABELS = {
  subject_id: 'Subject',
  genotype: 'Genotype',
  institution: 'Institution',
  acquisition_start_time: 'Acquired (UTC)',
  processing_end_time: 'Processed (UTC)',
  channel_1: 'Ch 1',
  channel_2: 'Ch 2',
  channel_3: 'Ch 3',
  processed: 'Processed',
};

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

/**
 * Render one table row as an HTML string.
 *
 * @param {object} row - Plain object with assets_smartspim columns.
 * @returns {string} `<tr>…</tr>` HTML
 */
export function renderSmartSpimRow(row) {
  const stitchedHtml = buildNeuroglancerLink(row.stitched_link ?? null, 'Stitched');

  const channelLinks = [1, 2, 3].map((n) => {
    const ch = row[`channel_${n}`];
    const seg = row[`segmentation_link_${n}`];
    const quant = row[`quantification_link_${n}`];
    if (!ch && !seg && !quant) return '';
    const label = ch ? escHtml(String(ch)) : `Ch${n}`;
    return `<span class="ch-links">${label}: ${buildNeuroglancerLink(seg, 'Seg')} ${buildNeuroglancerLink(quant, 'Quant')}</span>`;
  }).filter(Boolean).join(' ');

  const processedLabel = isProcessed(row)
    ? '<span class="badge badge-yes">Yes</span>'
    : '<span class="badge badge-no">No</span>';

  const cells = [
    `<td>${escHtml(String(row.subject_id ?? ''))}</td>`,
    `<td>${escHtml(String(row.genotype ?? ''))}</td>`,
    `<td>${escHtml(String(row.institution ?? ''))}</td>`,
    `<td>${escHtml(formatDatetime(row.acquisition_start_time ?? null))}</td>`,
    `<td>${escHtml(formatDatetime(row.processing_end_time ?? null))}</td>`,
    `<td>${escHtml(String(row.channel_1 ?? ''))}</td>`,
    `<td>${escHtml(String(row.channel_2 ?? ''))}</td>`,
    `<td>${escHtml(String(row.channel_3 ?? ''))}</td>`,
    `<td>${processedLabel}</td>`,
    `<td class="link-cell">${stitchedHtml} ${channelLinks}</td>`,
  ];

  return `<tr>${cells.join('')}</tr>`;
}

// ---------------------------------------------------------------------------
// Pie chart
// ---------------------------------------------------------------------------

/**
 * Compute institution slice data suitable for rendering a pie chart.
 *
 * Returns an array sorted descending by count, each entry having:
 *   { institution, count, fraction }
 *
 * @param {object[]} rows
 * @returns {Array<{institution: string, count: number, fraction: number}>}
 */
export function institutionSlices(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row.institution ?? 'Unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = rows.length;
  if (total === 0) return [];
  return Array.from(counts.entries())
    .map(([institution, count]) => ({ institution, count, fraction: count / total }))
    .sort((a, b) => b.count - a.count);
}

/** Fixed colours for known institutions; others fall back to grey shades. */
const INSTITUTION_COLORS = {
  AIND: '#FF8C00',
  AIBS: '#003087',
  AI: '#a0c4ff',
  Columbia: '#9b2226',
  NYU: '#6a0dad',
  None: '#999999',
};

const FALLBACK_COLORS = [
  '#4e9af1', '#f4845f', '#6bcb77', '#ffd166', '#ef476f', '#118ab2',
];

/**
 * Build an SVG string for a pie chart of institution slices.
 *
 * @param {Array<{institution: string, count: number, fraction: number}>} slices
 * @param {number} [size=220]  Diameter of the pie circle.
 * @returns {string} SVG markup string.
 */
export function buildPieSvg(slices, size = 220) {
  if (slices.length === 0) return '';

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;

  const legendItemH = 20;
  const legendWidth = 180;
  const svgHeight = Math.max(size, slices.length * legendItemH + 10);
  const svgWidth = size + legendWidth + 20;

  let paths = '';
  let legend = '';
  let fallbackIdx = 0;

  let angle = -Math.PI / 2;

  for (let i = 0; i < slices.length; i++) {
    const { institution, count, fraction } = slices[i];
    const sweep = fraction * 2 * Math.PI;
    const endAngle = angle + sweep;

    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = sweep > Math.PI ? 1 : 0;

    const color =
      INSTITUTION_COLORS[institution] ??
      FALLBACK_COLORS[fallbackIdx++ % FALLBACK_COLORS.length];

    paths += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z"
      fill="${color}" stroke="#fff" stroke-width="1.5" />`;

    const midAngle = angle + sweep / 2;
    const labelR = r * 0.65;
    const lx = cx + labelR * Math.cos(midAngle);
    const ly = cy + labelR * Math.sin(midAngle);
    if (fraction >= 0.05) {
      const pct = (fraction * 100).toFixed(2);
      paths += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}"
        text-anchor="middle" dominant-baseline="middle"
        font-size="11" fill="#fff" font-weight="600">${count.toLocaleString()} (${pct}%)</text>`;
    }

    const ly2 = 10 + i * legendItemH + legendItemH / 2;
    const lx2 = size + 16;
    legend += `<rect x="${lx2}" y="${(ly2 - 7).toFixed(1)}" width="14" height="14" rx="2" fill="${color}" />`;
    legend += `<text x="${(lx2 + 19).toFixed(1)}" y="${ly2.toFixed(1)}"
      dominant-baseline="middle" font-size="12" fill="#333">${escHtml(institution)}</text>`;

    angle = endAngle;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}"
    viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Subjects by Institution pie chart">
    <title>Subjects by Institution</title>
    ${paths}
    ${legend}
  </svg>`;
}

// ---------------------------------------------------------------------------
// Sort / filter / page helpers (shared pattern from assets/view.js)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;
const SELECT_THRESHOLD = 40;

/**
 * Sort an array of row objects by a column in-place.
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
 * Apply per-column filters.  Text filters use case-insensitive substring match.
 *
 * @param {object[]} rows
 * @param {Record<string, string>} filters
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
 * Create the SmartSPIM view element.
 *
 * Registers `assets_smartspim` in DuckDB (using the acorn from metadata if
 * available, otherwise falling back to the known S3 path), queries all rows,
 * then renders a pie chart + sortable/filterable/paginated table.
 *
 * @param {import('@uwdata/vgplot').Coordinator} coord
 * @param {{ acorns: object[] }} metadata
 * @returns {HTMLElement}
 */
export function createSmartSpimView(coord, metadata) {
  const container = document.createElement('div');
  container.className = 'assets-view smartspim-view';

  const loadingEl = document.createElement('p');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading SmartSPIM assets…';
  container.appendChild(loadingEl);

  const acorn = metadata?.acorns?.find((a) => a.name === 'assets_smartspim');

  const registerPromise = acorn
    ? registerAcornTable(coord, acorn)
    : coord.exec(
        `CREATE OR REPLACE TABLE assets_smartspim AS SELECT * FROM read_parquet('${SMARTSPIM_S3_PATH}')`,
      );

  registerPromise
    .then(() =>
      coord.query(
        `SELECT subject_id, genotype, institution, acquisition_start_time,
                processing_end_time, stitched_link, processed, name,
                channel_1, segmentation_link_1, quantification_link_1,
                channel_2, segmentation_link_2, quantification_link_2,
                channel_3, segmentation_link_3, quantification_link_3
         FROM assets_smartspim
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
      loadingEl.textContent = `Failed to load SmartSPIM assets: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    });

  function buildPage(allRows) {
    const rawRows = allRows.filter((r) => !isProcessed(r));
    const processedRows = allRows.filter((r) => isProcessed(r));

    const topCard = document.createElement('div');
    topCard.className = 'smartspim-top-card';

    const header = document.createElement('div');
    header.className = 'assets-header';
    header.innerHTML = '<h2>SmartSPIM Assets</h2>';
    topCard.appendChild(header);

    const chartsRow = document.createElement('div');
    chartsRow.className = 'smartspim-charts';

    const descPanel = document.createElement('div');
    descPanel.className = 'smartspim-desc';
    descPanel.innerHTML = `
      <p>The table below displays one row per subject that has started processing.</p>
      <p>If there are multiple processing attempts, only the latest attempt is displayed.</p>
      <p>The second group of links visualize cell segmentation results. If the &#8220;cell segmentation channels&#8221; column is not empty and there are no visualization links, this means that segmentation has not succeeded.</p>
      <p>The third group of links visualize segmentation results aligned to the CCF. If there are no links, CCF alignment has not succeeded.</p>
    `;
    chartsRow.appendChild(descPanel);

    function makePieSection(rows, title) {
      const section = document.createElement('div');
      section.className = 'smartspim-chart-section';
      const h = document.createElement('h3');
      h.className = 'chart-title';
      h.textContent = title;
      section.appendChild(h);
      const el = document.createElement('div');
      el.className = 'smartspim-pie';
      el.innerHTML = buildPieSvg(institutionSlices(rows));
      section.appendChild(el);
      return section;
    }

    chartsRow.appendChild(makePieSection(rawRows, `Raw (${rawRows.length.toLocaleString()})` ));
    chartsRow.appendChild(makePieSection(processedRows, `Processed (${processedRows.length.toLocaleString()})` ));

    topCard.appendChild(chartsRow);

    buildTable(allRows, topCard);
    container.appendChild(topCard);
  }

  function buildTable(allRows, target) {
    let sortCol = 'acquisition_start_time';
    let sortDir = 'desc';
    let filters = Object.fromEntries(DISPLAY_COLUMNS.map((c) => [c, '']));
    let page = 0;

    const uniques = {};
    for (const col of DISPLAY_COLUMNS) {
      uniques[col] = uniqueValues(allRows, col);
    }

    const useSelect = {};
    for (const col of DISPLAY_COLUMNS) {
      useSelect[col] = uniques[col].length > 0 && uniques[col].length <= SELECT_THRESHOLD;
    }

    const allHeaders = [...DISPLAY_COLUMNS, 'links'];
    const allLabels = { ...COLUMN_LABELS, links: 'Links' };

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

    const pagingBar = document.createElement('div');
    pagingBar.className = 'assets-paging';

    target.appendChild(table);
    target.appendChild(pagingBar);

    function updateSortIndicators() {
      table.querySelectorAll('th.sortable').forEach((th) => {
        const col = th.dataset.col;
        th.dataset.sortDir = col === sortCol ? sortDir : '';
        const label = allLabels[col] ?? col;
        const arrow = col === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        th.querySelector('.col-label').textContent = label + arrow;
      });
    }

    function visibleRows() {
      const filtered = filterRows(allRows, filters);
      return sortRows(filtered, sortCol, sortDir);
    }

    function refresh() {
      const rows = visibleRows();
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (page >= totalPages) page = totalPages - 1;

      const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      tbody.innerHTML = pageRows.map(renderSmartSpimRow).join('');

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

    table.querySelector('thead').addEventListener('click', (e) => {
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

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

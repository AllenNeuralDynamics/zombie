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
import { escHtml, formatDatetime, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD } from '../lib/utils.js';
import { institutionSlices, buildPieSvg } from '../lib/charts.js';

// Re-export for backward compatibility with tests
export { formatDatetime, sortRows, uniqueValues, filterRows, institutionSlices, buildPieSvg };

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
// ---------------------------------------------------------------------------
// Sort / filter / page helpers (shared pattern from assets/view.js)
// ---------------------------------------------------------------------------

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

/**
 * record_consistency/view.js — Record-consistency findings page.
 *
 * Summarizes each check from the record_consistency_checks cache table and lists
 * every record in record_consistency_results that did not pass.
 *
 * @module
 */

import { queryRows } from '../lib/arrow.js';
import { buildTableHead } from '../lib/paginated-table.js';
import { ensureTable } from '../lib/registry.js';
import { downloadCsv, escHtml, filterRows, formatDatetime, PAGE_SIZE, sortRows, uniqueValues } from '../lib/utils.js';
import { buildMetadataLink, buildS3ConsoleUrl } from '../assets/links.js';

export const RESULTS_TABLE = 'record_consistency_results';
export const CHECKS_TABLE = 'record_consistency_checks';

const COLUMNS = ['name', 'check_key', 'record_kind', 'record_id', 'location', 'record_last_modified'];
const COLUMN_LABELS = {
  name: 'Name',
  check_key: 'Check',
  record_kind: 'Record Kind',
  record_id: 'Record ID',
  location: 'Location',
  record_last_modified: 'Last Modified',
};
const FILTER_TYPES = { check_key: 'select', record_kind: 'select' };
const DEFAULT_SORT = 'check_key';

export const FINDINGS_QUERY = `
  SELECT ${COLUMNS.join(', ')}
  FROM ${RESULTS_TABLE}
  WHERE status <> 'pass'
  ORDER BY check_key, name, record_id
`;

export const CHECKS_QUERY = `
  SELECT check_key,
         check_description AS description,
         check_source_url AS source_url,
         evaluated_count::INTEGER AS evaluated,
         failed_count::INTEGER AS failed,
         check_eval_seconds,
         source_load_seconds,
         checked_at
  FROM ${CHECKS_TABLE}
  ORDER BY check_key
`;

export const RESULTS_RUN_QUERY = `SELECT DISTINCT checked_at FROM ${RESULTS_TABLE}`;

function githubUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : null;
  } catch {
    return null;
  }
}

function externalLink(href, html) {
  return href ? `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>` : html;
}

/**
 * Link a finding to its record: DocDB v2 records open in /record, v1 records in /upgrade.
 *
 * @param {object} row
 * @returns {string|null}
 */
export function recordHref(row) {
  if (row.record_kind === 'docdb_v2') return buildMetadataLink(row.name);
  if (row.record_kind === 'docdb_v1' && row.record_id) return `/upgrade?asset_id=${encodeURIComponent(row.record_id)}`;
  return null;
}

/**
 * Format a duration in seconds as milliseconds below one second, otherwise as seconds.
 *
 * @param {number|null} seconds
 * @returns {string}
 */
export function formatSeconds(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return '';
  const value = Number(seconds);
  return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(1)} s`;
}

/**
 * @param {object} check - One row of CHECKS_QUERY.
 * @returns {string} Escaped table-row HTML.
 */
export function renderCheckRow(check) {
  const key = `<code>${escHtml(check.check_key ?? '')}</code>`;
  return `<tr>
    <td>${externalLink(githubUrl(check.source_url), key)}<div>${escHtml(check.description ?? '')}</div></td>
    <td class="stat-count">${Number(check.evaluated).toLocaleString()}</td>
    <td class="stat-count">${Number(check.failed).toLocaleString()}</td>
    <td class="stat-duration">load ${formatSeconds(check.source_load_seconds)} · check ${formatSeconds(check.check_eval_seconds)}</td>
    <td class="stat-duration">${escHtml(formatDatetime(check.checked_at))}</td>
  </tr>`;
}

/**
 * @param {object} row - One row of FINDINGS_QUERY.
 * @returns {string} Escaped table-row HTML.
 */
export function renderFindingRow(row) {
  const name = escHtml(row.name ?? '');
  const href = recordHref(row);
  const location = row.location ?? '';
  return `<tr>
    <td>${href ? `<a href="${escHtml(href)}">${name}</a>` : name}</td>
    <td><code>${escHtml(row.check_key ?? '')}</code></td>
    <td>${escHtml(row.record_kind ?? '')}</td>
    <td><code>${escHtml(row.record_id ?? '')}</code></td>
    <td>${externalLink(buildS3ConsoleUrl(location), escHtml(location))}</td>
    <td>${escHtml(formatDatetime(row.record_last_modified))}</td>
  </tr>`;
}

/**
 * Read sort, page, and `f_<column>` filters from a query string.
 *
 * @param {string} search
 * @returns {{sort: string, dir: 'asc'|'desc', page: number, filters: Record<string, string>}}
 */
export function readTableState(search) {
  const params = new URLSearchParams(search);
  return {
    sort: COLUMNS.includes(params.get('sort')) ? params.get('sort') : DEFAULT_SORT,
    dir: params.get('dir') === 'desc' ? 'desc' : 'asc',
    page: Math.max(0, parseInt(params.get('page') ?? '0', 10) || 0),
    filters: Object.fromEntries(COLUMNS.map((col) => [col, params.get(`f_${col}`) ?? ''])),
  };
}

/**
 * Serialize table state to a query string, omitting defaults.
 *
 * @param {ReturnType<typeof readTableState>} state
 * @returns {string}
 */
export function tableStateSearch({ sort, dir, page, filters }) {
  const params = new URLSearchParams();
  if (sort !== DEFAULT_SORT) params.set('sort', sort);
  if (dir !== 'asc') params.set('dir', dir);
  if (page > 0) params.set('page', String(page));
  for (const col of COLUMNS) {
    if (filters[col]) params.set(`f_${col}`, filters[col]);
  }
  return params.toString();
}

/**
 * Return whether the checks summary and the results come from different cache runs.
 *
 * @param {object[]} checks - Rows of CHECKS_QUERY.
 * @param {object[]} resultRuns - Rows of RESULTS_RUN_QUERY.
 * @returns {boolean}
 */
export function runsDiffer(checks, resultRuns) {
  const checkRuns = new Set(checks.map((check) => String(check.checked_at)));
  return resultRuns.some((run) => !checkRuns.has(String(run.checked_at))) || checkRuns.size !== resultRuns.length;
}

function buildChecksPanel(checks, resultRuns) {
  const panel = document.createElement('section');
  panel.className = 'sessions-stats-panel';
  const warning = runsDiffer(checks, resultRuns)
    ? '<div class="sessions-stat-warning">Check summaries and results come from different cache runs.</div>'
    : '';
  panel.innerHTML = `
    ${warning}
    <div class="sessions-stat-block">
      <div class="sessions-stat-title">Checks</div>
      <table class="sessions-stat-table">
        <thead><tr><th>Check</th><th>Evaluated</th><th>Failed</th><th>Runtime</th><th>Checked</th></tr></thead>
        <tbody>${checks.map(renderCheckRow).join('')}</tbody>
      </table>
    </div>
  `;
  return panel;
}

function buildFindingsTable(rows) {
  const state = readTableState(window.location.search);
  for (const col of Object.keys(FILTER_TYPES)) {
    if (state.filters[col] && !uniqueValues(rows, col).includes(state.filters[col])) state.filters[col] = '';
  }
  let visible = rows;

  const area = document.createElement('div');
  area.className = 'sessions-table-area';

  const exportButton = document.createElement('button');
  exportButton.className = 'sessions-export-btn sessions-table-export-btn';
  exportButton.textContent = 'Export CSV';
  exportButton.addEventListener('click', () => {
    downloadCsv(
      'record-consistency.csv',
      COLUMNS.map((col) => COLUMN_LABELS[col]),
      visible.map((row) => COLUMNS.map((col) => String(row[col] ?? ''))),
    );
  });

  const table = document.createElement('table');
  table.className = 'assets-table';
  const paging = document.createElement('div');
  paging.className = 'assets-paging';
  area.append(exportButton, table, paging);

  const renderHead = () => {
    table.innerHTML = `${buildTableHead(COLUMNS, COLUMN_LABELS, state.sort, state.dir, state.filters, rows, FILTER_TYPES)}<tbody></tbody>`;
  };

  const refresh = () => {
    visible = sortRows([...filterRows(rows, state.filters)], state.sort, state.dir);
    const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
    state.page = Math.min(state.page, pageCount - 1);
    const start = state.page * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, visible.length);

    table.querySelector('tbody').innerHTML = visible.slice(start, end).map(renderFindingRow).join('');
    paging.innerHTML = `
      <button class="page-btn" data-page="-1" ${state.page === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span class="page-info">${visible.length ? start + 1 : 0}–${end} of ${visible.length.toLocaleString()}</span>
      <button class="page-btn" data-page="1" ${state.page >= pageCount - 1 ? 'disabled' : ''}>Next ›</button>
    `;
    const search = tableStateSearch(state);
    history.replaceState(null, '', search ? `?${search}` : window.location.pathname);
  };

  table.addEventListener('click', (event) => {
    if (event.target.closest('.col-filter')) return;
    const th = event.target.closest('th.sortable');
    if (!th) return;
    state.dir = state.sort === th.dataset.col && state.dir === 'asc' ? 'desc' : 'asc';
    state.sort = th.dataset.col;
    state.page = 0;
    renderHead();
    refresh();
  });
  const updateFilter = (event) => {
    const input = event.target.closest('.col-filter');
    if (!input || state.filters[input.dataset.col] === input.value) return;
    state.filters[input.dataset.col] = input.value;
    state.page = 0;
    refresh();
  };
  table.addEventListener('input', updateFilter);
  table.addEventListener('change', updateFilter);
  paging.addEventListener('click', (event) => {
    const button = event.target.closest('.page-btn');
    if (!button || button.disabled) return;
    state.page += Number(button.dataset.page);
    refresh();
  });

  renderHead();
  refresh();
  return area;
}

/**
 * Create the record-consistency view.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coord
 * @returns {Promise<HTMLElement>}
 */
export async function createRecordConsistencyView(coord) {
  await Promise.all([ensureTable(coord, RESULTS_TABLE), ensureTable(coord, CHECKS_TABLE)]);
  const [checks, findings, resultRuns] = await Promise.all([
    queryRows(coord, CHECKS_QUERY),
    queryRows(coord, FINDINGS_QUERY),
    queryRows(coord, RESULTS_RUN_QUERY),
  ]);

  const container = document.createElement('div');
  container.className = 'assets-view record-consistency-view';
  container.innerHTML = '<div class="assets-header"><h2>Record Consistency</h2></div>';
  container.appendChild(buildChecksPanel(checks, resultRuns));

  if (findings.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'loading-message';
    empty.textContent = 'No flagged records.';
    container.appendChild(empty);
  } else {
    container.appendChild(buildFindingsTable(findings));
  }
  return container;
}

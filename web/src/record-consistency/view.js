import { queryRows } from '../lib/arrow.js';
import { quoteIdentifier } from '../lib/metadata.js';
import { ensureTable } from '../lib/registry.js';
import { escHtml } from '../lib/utils.js';
import { buildMetadataLink, buildS3ConsoleUrl } from '../assets/links.js';

export const RECORD_CONSISTENCY_TABLE = 'record_consistency_checks';

/**
 * Build the query used by the dev-only flagged-records page.
 *
 * @param {string} tableName - Registered DuckDB table name.
 * @returns {string}
 */
export function buildFlaggedRecordsQuery(tableName = RECORD_CONSISTENCY_TABLE) {
  return `
    SELECT name, check_key, status, docdb_version, docdb_id, location, run_id, checked_at
    FROM ${quoteIdentifier(tableName)}
    WHERE status IN ('fail', 'unknown')
    ORDER BY check_key ASC, name ASC, docdb_id ASC
  `;
}

/**
 * Count checks represented by flagged rows.
 *
 * @param {object[]} rows
 * @returns {number}
 */
export function countChecks(rows) {
  return new Set(rows.map((row) => String(row.check_key ?? ''))).size;
}

function externalLink(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`;
}

/**
 * Render one flagged record-consistency finding.
 *
 * @param {object} row
 * @returns {string} Escaped table-row HTML.
 */
export function renderFindingRow(row) {
  const name = String(row.name ?? '');
  const nameHref = buildMetadataLink(name);
  const nameCell = nameHref
    ? `<a href="${escHtml(nameHref)}">${escHtml(name)}</a>`
    : '<span class="no-link">—</span>';
  const location = String(row.location ?? '');

  return `<tr>
    <td>${nameCell}</td>
    <td><code>${escHtml(row.check_key ?? '')}</code></td>
    <td>${escHtml(row.status ?? '')}</td>
    <td>${escHtml(row.docdb_version ?? '')}</td>
    <td><code>${escHtml(row.docdb_id ?? '')}</code></td>
    <td>${externalLink(buildS3ConsoleUrl(location), location)}</td>
    <td><code>${escHtml(row.run_id ?? '')}</code></td>
    <td>${escHtml(row.checked_at ?? '')}</td>
  </tr>`;
}

function buildTable(rows) {
  const table = document.createElement('table');
  table.className = 'record-consistency-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th>
        <th>Check</th>
        <th>Status</th>
        <th>DocDB version</th>
        <th>DocDB ID</th>
        <th>s3_location</th>
        <th>Run ID</th>
        <th>Checked at</th>
      </tr>
    </thead>
    <tbody>${rows.map(renderFindingRow).join('')}</tbody>
  `;
  return table;
}

/**
 * Create the dev-only record-consistency findings view.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coord
 * @returns {HTMLElement}
 */
export function createRecordConsistencyView(coord) {
  const container = document.createElement('div');
  container.className = 'record-consistency-view';

  const header = document.createElement('div');
  header.className = 'assets-header';
  const heading = document.createElement('h2');
  heading.textContent = 'Record-consistency checks';
  header.appendChild(heading);
  container.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'record-consistency-intro';
  intro.textContent = 'Each row is one non-pass result from the record-consistency cache.';
  container.appendChild(intro);

  const loading = document.createElement('p');
  loading.className = 'loading-message';
  loading.textContent = 'Loading record-consistency checks…';
  container.appendChild(loading);

  ensureTable(coord, RECORD_CONSISTENCY_TABLE)
    .then((tableName) => queryRows(coord, buildFlaggedRecordsQuery(tableName)))
    .then((rows) => {
      loading.remove();
      const summary = document.createElement('p');
      summary.className = 'record-consistency-summary';
      summary.textContent = `${rows.length.toLocaleString()} flagged record(s) across `
        + `${countChecks(rows).toLocaleString()} check(s).`;
      container.appendChild(summary);

      if (rows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'record-consistency-empty';
        empty.textContent = 'No flagged records.';
        container.appendChild(empty);
        return;
      }

      const tableWrap = document.createElement('div');
      tableWrap.className = 'record-consistency-table-wrap';
      tableWrap.appendChild(buildTable(rows));
      container.appendChild(tableWrap);
    })
    .catch((err) => {
      console.error('[Record-consistency checks] Failed to load:', err);
      loading.textContent = `Failed to load record-consistency checks: ${err?.message ?? err}`;
      loading.className = 'loading-message error';
    });

  return container;
}

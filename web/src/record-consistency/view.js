import { queryRows } from '../lib/arrow.js';
import { quoteIdentifier } from '../lib/metadata.js';
import { ensureTable } from '../lib/registry.js';
import { escHtml } from '../lib/utils.js';
import { buildMetadataLink, buildS3ConsoleUrl } from '../assets/links.js';

export const RECORD_CONSISTENCY_TABLE = 'record_consistency_checks';
export const DUPLICATE_NAME_CHECK_KEY = 'docdb_duplicate_name_v2';

/**
 * Build the query used by the dev-only duplicate-name findings page.
 *
 * @param {string} tableName - Registered DuckDB table name.
 * @returns {string}
 */
export function buildDuplicateNameQuery(tableName = RECORD_CONSISTENCY_TABLE) {
  return `
    SELECT docdb_id, docdb_version, name, location
    FROM ${quoteIdentifier(tableName)}
    WHERE check_key = '${DUPLICATE_NAME_CHECK_KEY}'
      AND docdb_version = 'v2'
      AND status = 'fail'
    ORDER BY name ASC, docdb_id ASC
  `;
}

/**
 * Derive duplicate-group display fields from failed result rows.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function addDuplicateGroupDetails(rows) {
  const idsByName = new Map();
  for (const row of rows) {
    const name = String(row.name ?? '');
    const ids = idsByName.get(name) ?? [];
    ids.push(String(row.docdb_id ?? ''));
    idsByName.set(name, ids);
  }
  return rows.map((row) => {
    const ids = idsByName.get(String(row.name ?? '')) ?? [];
    const docdbId = String(row.docdb_id ?? '');
    return {
      ...row,
      duplicate_group_count: ids.length,
      peer_docdb_ids: ids.filter((id) => id !== docdbId),
    };
  });
}

/**
 * Format a scalar or list-valued cache field for display.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatListValue(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  return String(value);
}

/**
 * Count distinct duplicate-name groups in the failed rows.
 *
 * @param {object[]} rows
 * @returns {number}
 */
export function countDuplicateNameGroups(rows) {
  return new Set(rows.map((row) => String(row.name ?? ''))).size;
}

function externalLink(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`;
}

/**
 * Render one failed v2 duplicate-name finding.
 *
 * @param {object} row - Row enriched by {@link addDuplicateGroupDetails}.
 * @returns {string} Escaped table-row HTML.
 */
export function renderDuplicateNameRow(row) {
  const name = String(row.name ?? '');
  const nameHref = buildMetadataLink(name);
  const nameCell = nameHref
    ? `<a href="${escHtml(nameHref)}">${escHtml(name)}</a>`
    : '<span class="no-link">—</span>';
  const location = String(row.location ?? '');
  const peerIds = formatListValue(row.peer_docdb_ids);
  const groupCount = row.duplicate_group_count == null ? '' : String(row.duplicate_group_count);

  return `<tr>
    <td>${nameCell}</td>
    <td><code>${escHtml(row.docdb_id ?? '')}</code></td>
    <td>${escHtml(groupCount)}</td>
    <td><code>${escHtml(peerIds)}</code></td>
    <td>${externalLink(buildS3ConsoleUrl(location), location)}</td>
  </tr>`;
}

function buildTable(rows) {
  const table = document.createElement('table');
  table.className = 'record-consistency-table';
  table.innerHTML = `
    <thead>
      <tr>
        <th>Name</th>
        <th>DocDB v2 ID</th>
        <th>Group size</th>
        <th>Peer DocDB v2 IDs</th>
        <th>S3 location</th>
      </tr>
    </thead>
    <tbody>${rows.map(renderDuplicateNameRow).join('')}</tbody>
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
  intro.textContent =
    'Current check: docdb_duplicate_name_v2. Each row is one v2 DocDB record in an exact duplicate-name group.';
  container.appendChild(intro);

  const loading = document.createElement('p');
  loading.className = 'loading-message';
  loading.textContent = 'Loading record-consistency checks…';
  container.appendChild(loading);

  ensureTable(coord, RECORD_CONSISTENCY_TABLE)
    .then((tableName) => queryRows(coord, buildDuplicateNameQuery(tableName)))
    .then((rows) => {
      const displayRows = addDuplicateGroupDetails(rows);
      loading.remove();
      const summary = document.createElement('p');
      summary.className = 'record-consistency-summary';
      summary.textContent = `${displayRows.length.toLocaleString()} flagged v2 record(s) across `
        + `${countDuplicateNameGroups(displayRows).toLocaleString()} duplicate name group(s).`;
      container.appendChild(summary);

      if (displayRows.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'record-consistency-empty';
        empty.textContent = 'No flagged v2 duplicate-name records.';
        container.appendChild(empty);
        return;
      }

      const tableWrap = document.createElement('div');
      tableWrap.className = 'record-consistency-table-wrap';
      tableWrap.appendChild(buildTable(displayRows));
      container.appendChild(tableWrap);
    })
    .catch((err) => {
      console.error('[Record-consistency checks] Failed to load:', err);
      loading.textContent = `Failed to load record-consistency checks: ${err?.message ?? err}`;
      loading.className = 'loading-message error';
    });

  return container;
}

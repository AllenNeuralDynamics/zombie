import { queryRows } from '../lib/arrow.js';
import { quoteIdentifier, s3PathToHttps } from '../lib/metadata.js';
import { ensureTable, getAcorn } from '../lib/registry.js';
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

/**
 * Build the manifest URL beside the record-consistency Parquet table.
 *
 * @param {string} tableLocation
 * @returns {string}
 */
export function buildManifestUrl(tableLocation) {
  const tableUrl = s3PathToHttps(tableLocation);
  if (!tableUrl.endsWith('.pqt')) {
    throw new Error(`Unexpected record-consistency table location: ${tableLocation}`);
  }
  return `${tableUrl.slice(0, -4)}.manifest.json`;
}

async function fetchRecordConsistencyManifest() {
  const location = getAcorn(RECORD_CONSISTENCY_TABLE)?.location;
  if (!location) return null;

  const response = await fetch(buildManifestUrl(location), { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Record-consistency manifest request failed (${response.status})`);
  }
  return response.json();
}

function indexCheckMetadata(manifest) {
  if (!Array.isArray(manifest?.checks)) return {};
  return Object.fromEntries(
    manifest.checks
      .filter((check) => typeof check?.check_key === 'string')
      .map((check) => [check.check_key, check]),
  );
}

function summarizeFindings(rows, manifest) {
  const failedCount = rows.filter((row) => row.status === 'fail').length;
  const unknownCount = rows.filter((row) => row.status === 'unknown').length;
  return {
    findingCount: rows.length,
    failedCount,
    unknownCount,
    checkCount: Number.isInteger(manifest?.check_count) ? manifest.check_count : countChecks(rows),
    evaluatedCount: Number.isInteger(manifest?.row_count) ? manifest.row_count : null,
    checkedAt: manifest?.checked_at ?? rows[0]?.checked_at ?? null,
  };
}

function checkSummaries(rows, manifest) {
  const rowsByCheck = new Map();
  for (const row of rows) {
    const key = String(row.check_key ?? '');
    const counts = rowsByCheck.get(key) ?? { failedCount: 0, unknownCount: 0 };
    if (row.status === 'fail') counts.failedCount += 1;
    if (row.status === 'unknown') counts.unknownCount += 1;
    rowsByCheck.set(key, counts);
  }

  const metadataByKey = indexCheckMetadata(manifest);
  const keys = [
    ...Object.keys(metadataByKey),
    ...[...rowsByCheck.keys()].filter((key) => !metadataByKey[key]).sort(),
  ];
  return keys.map((key) => {
    const metadata = metadataByKey[key] ?? {};
    const rowCounts = rowsByCheck.get(key) ?? { failedCount: 0, unknownCount: 0 };
    const failedCount = Number.isInteger(metadata.failed_count)
      ? metadata.failed_count
      : rowCounts.failedCount;
    const unknownCount = Number.isInteger(metadata.unknown_count)
      ? metadata.unknown_count
      : rowCounts.unknownCount;
    return {
      key,
      description: metadata.description ?? '',
      implementationUrl: implementationUrl(metadata.implementation_url),
      findingCount: failedCount + unknownCount,
      failedCount,
      unknownCount,
      evaluatedCount: Number.isInteger(metadata.processed_count) ? metadata.processed_count : null,
    };
  });
}

function buildCheckDetails(rows, manifest) {
  const checks = checkSummaries(rows, manifest);
  if (checks.length === 0) return '';

  return `
    <div class="record-consistency-checks">
      <h4>Checks</h4>
      ${checks.map((check) => `
        <article class="record-consistency-check-card">
          <code class="record-consistency-check-key">${escHtml(check.key)}</code>
          <div class="record-consistency-check-counts">
            <span><strong>${check.findingCount.toLocaleString()}</strong> flagged</span>
            <span><strong>${check.failedCount.toLocaleString()}</strong> failed</span>
            <span><strong>${check.unknownCount.toLocaleString()}</strong> unknown</span>
            <span><strong>${check.evaluatedCount?.toLocaleString() ?? '—'}</strong> evaluated</span>
          </div>
          ${check.description
            ? `<p>${escHtml(check.description)}</p>`
            : '<p class="no-link">Description unavailable.</p>'}
          <div class="record-consistency-implementation">
            <span>Implementation permalink</span>
            ${check.implementationUrl
              ? externalLink(check.implementationUrl, 'View source')
              : '<span class="no-link">—</span>'}
          </div>
        </article>
      `).join('')}
    </div>
  `;
}

function buildSummary(rows, manifest) {
  const summary = summarizeFindings(rows, manifest);
  const panel = document.createElement('section');
  panel.className = 'record-consistency-summary-panel';
  panel.innerHTML = `
    <h3>Summary</h3>
    <div class="record-consistency-summary-grid">
      <div class="record-consistency-summary-stat">
        <span class="record-consistency-summary-label">Flagged results</span>
        <strong>${summary.findingCount.toLocaleString()}</strong>
      </div>
      <div class="record-consistency-summary-stat">
        <span class="record-consistency-summary-label">Failed</span>
        <strong>${summary.failedCount.toLocaleString()}</strong>
      </div>
      <div class="record-consistency-summary-stat">
        <span class="record-consistency-summary-label">Unknown</span>
        <strong>${summary.unknownCount.toLocaleString()}</strong>
      </div>
      <div class="record-consistency-summary-stat">
        <span class="record-consistency-summary-label">Checks run</span>
        <strong>${summary.checkCount.toLocaleString()}</strong>
      </div>
      <div class="record-consistency-summary-stat">
        <span class="record-consistency-summary-label">Evaluated rows</span>
        <strong>${summary.evaluatedCount?.toLocaleString() ?? '—'}</strong>
      </div>
      <div class="record-consistency-summary-stat">
        <span class="record-consistency-summary-label">Checked at</span>
        <strong class="record-consistency-summary-time">${escHtml(summary.checkedAt ?? '—')}</strong>
      </div>
    </div>
    ${buildCheckDetails(rows, manifest)}
  `;
  return panel;
}

function externalLink(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${escHtml(label)}</a>`;
}

function implementationUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : '';
  } catch {
    return '';
  }
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
    <tbody>${rows.map((row) => renderFindingRow(row)).join('')}</tbody>
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

  const manifestPromise = fetchRecordConsistencyManifest().catch((error) => {
    console.warn('[Record-consistency checks] Manifest unavailable:', error);
    return null;
  });

  Promise.all([
    ensureTable(coord, RECORD_CONSISTENCY_TABLE)
      .then((tableName) => queryRows(coord, buildFlaggedRecordsQuery(tableName))),
    manifestPromise,
  ])
    .then(([rows, manifest]) => {
      loading.remove();
      container.appendChild(buildSummary(rows, manifest));

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

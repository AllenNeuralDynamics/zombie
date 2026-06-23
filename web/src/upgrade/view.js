/**
 * upgrade/view.js — Metadata Upgrade Status page.
 *
 * Shows a summary table (from the metadata_upgrade DuckDB table), charts of
 * upgrade success rate by version and by project, and a tool to run the
 * upgrader on any individual asset record.
 */

import * as Plot from '@observablehq/plot';
import { escHtml } from '../lib/utils.js';
import { arrowTableToRows } from '../lib/arrow.js';
import { queryDocDb } from '../lib/docdb.js';
import { buildTableHead, buildPagingBar } from '../lib/paginated-table.js';
import { ensureTable } from '../lib/registry.js';

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Metadata portal upgrade endpoint (proxied via /metadata-portal/). */
const UPGRADE_API = '/metadata-portal/upgrade';

/** DocDB v1 base URL — returns the original (pre-upgrade) record. */
const DOCDB_V1_BASE = 'https://api.allenneuraldynamics.org/v1/metadata_index/data_assets';

const COL_LABEL_OVERRIDES = {
  _id: 'ID',
  name: 'Name',
  project_name: 'Project',
  data_level: 'Data Level',
  status: 'Status',
  upgrader_version: 'Upgrader Version',
};

function colLabel(col) {
  return COL_LABEL_OVERRIDES[col] ?? col.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function deriveColumns(rows) {
  if (!rows.length) return ['name', 'project_name', 'data_level', 'status', 'upgrader_version'];
  const preferred = ['name', 'project_name', 'data_level', 'status', 'upgrader_version'];
  const all = Object.keys(rows[0]);
  const rest = all.filter((c) => !preferred.includes(c));
  return [...preferred.filter((c) => all.includes(c)), ...rest];
}

// ---------------------------------------------------------------------------
// Data aggregation helpers
// ---------------------------------------------------------------------------

function computeVersionData(rows) {
  const map = {};
  for (const row of rows) {
    const v = row.upgrader_version ?? 'unknown';
    if (!map[v]) map[v] = { success: 0, total: 0 };
    map[v].total++;
    if (row.status === 'success') map[v].success++;
  }
  return Object.entries(map)
    .map(([version, d]) => ({
      version,
      pct_success: d.total > 0 ? (d.success / d.total) * 100 : 0,
    }))
    .sort((a, b) => {
      const parse = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
      const [a1, a2, a3] = parse(a.version);
      const [b1, b2, b3] = parse(b.version);
      return a1 - b1 || a2 - b2 || a3 - b3;
    });
}

function computeProjectAggregates(rows) {
  const countMap = {};
  for (const row of rows) {
    const key = `${row.project_name}||${row.status}`;
    if (!countMap[key]) countMap[key] = { project_name: row.project_name, status: row.status, count: 0 };
    countMap[key].count++;
  }
  const projectData = Object.values(countMap);

  const totalByProject = {};
  for (const d of projectData) {
    totalByProject[d.project_name] = (totalByProject[d.project_name] || 0) + d.count;
  }
  const projectOrder = Object.entries(totalByProject)
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);

  return { projectData, projectOrder };
}

// ---------------------------------------------------------------------------
// Chart builders
// ---------------------------------------------------------------------------

function chartWidth() {
  return Math.max(700, (document.documentElement.clientWidth || 1200) - 56);
}

function buildVersionChart(versionData) {
  if (versionData.length < 2) return null;
  const wrap = document.createElement('div');
  wrap.className = 'upgrade-chart-wrap';
  const heading = document.createElement('h3');
  heading.className = 'upgrade-chart-heading';
  heading.textContent = '% Upgrade Success Across Versions';
  wrap.appendChild(heading);
  wrap.appendChild(
    Plot.plot({
      width: chartWidth(),
      height: 200,
      marginLeft: 60,
      style: { background: 'transparent', fontFamily: 'inherit' },
      x: { label: 'Upgrader Version', tickRotate: -30 },
      y: { label: '% Success', domain: [0, 100] },
      marks: [
        Plot.line(versionData, { x: 'version', y: 'pct_success', stroke: 'steelblue', strokeWidth: 2 }),
        Plot.dot(versionData, { x: 'version', y: 'pct_success', fill: 'steelblue', r: 4 }),
        Plot.tip(versionData, Plot.pointerX({ x: 'version', y: 'pct_success' })),
      ],
    }),
  );
  return wrap;
}

function buildProjectChart(projectData, projectOrder, onProjectClick) {
  const projectTotals = projectOrder.map((project) => {
    const pRows = projectData.filter((r) => r.project_name === project);
    const total = pRows.reduce((s, r) => s + r.count, 0);
    const successCount = (pRows.find((r) => r.status === 'success') ?? {}).count ?? 0;
    const failedCount = (pRows.find((r) => r.status === 'failed') ?? {}).count ?? 0;
    const pct = total > 0 ? ((successCount / total) * 100).toFixed(1) : '0.0';
    return { project_name: project, total, success: successCount, failed: failedCount, pct_success: pct };
  });

  const wrap = document.createElement('div');
  wrap.className = 'upgrade-chart-wrap';
  const heading = document.createElement('h3');
  heading.className = 'upgrade-chart-heading';
  heading.textContent = 'Upgrade Status by Project';
  wrap.appendChild(heading);

  const plotEl = Plot.plot({
    width: chartWidth(),
    height: Math.min(Math.max(600, 25 * projectOrder.length + 240), 800),
    marginBottom: 160,
    marginLeft: 70,
    style: { background: 'transparent', fontFamily: 'inherit', cursor: 'pointer' },
    x: { label: 'Project', tickRotate: -45, domain: projectOrder },
    y: { label: 'Count' },
    color: {
      legend: true,
      domain: ['success', 'failed', 'unknown'],
      range: ['#1D8649', '#c0392b', '#888888'],
    },
    marks: [
      Plot.barY(projectData, Plot.stackY({ x: 'project_name', y: 'count', fill: 'status', order: ['success', 'failed', 'unknown'] })),
      Plot.tip(projectTotals, Plot.pointerX({
        x: 'project_name',
        y: 'total',
        title: (d) => `${d.project_name}\nSuccess: ${d.success.toLocaleString()}\nFailed: ${d.failed.toLocaleString()}\n% Success: ${d.pct_success}%`,
      })),
    ],
  });

  if (onProjectClick) {
    const xScale = plotEl.scale('x');
    plotEl.addEventListener('click', (e) => {
      const svgRect = plotEl.getBoundingClientRect();
      const offsetX = e.clientX - svgRect.left;
      let clicked = null;
      for (const p of projectOrder) {
        const x = xScale.apply(p);
        if (offsetX >= x && offsetX < x + xScale.bandwidth) {
          clicked = p;
          break;
        }
      }
      onProjectClick(clicked);
    });
  }

  wrap.appendChild(plotEl);
  return wrap;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function buildUpgradeTable(rows, columns) {
  let allRows = rows;
  let filteredRows = [...allRows];
  let sortCol = 'name';
  let sortDir = 'asc';
  let filterValues = {};
  let projectFilter = null;
  let page = 0;
  const COLUMNS = columns;
  const COLUMN_LABELS = Object.fromEntries(columns.map((c) => [c, colLabel(c)]));

  const wrapper = document.createElement('div');
  wrapper.className = 'upgrade-table-wrap';

  const filterBanner = document.createElement('div');
  filterBanner.className = 'upgrade-project-filter-banner';
  filterBanner.style.display = 'none';
  wrapper.appendChild(filterBanner);

  const countEl = document.createElement('p');
  countEl.className = 'upgrade-table-count';
  wrapper.appendChild(countEl);

  const tableContainer = document.createElement('div');
  tableContainer.className = 'table-responsive';
  wrapper.appendChild(tableContainer);

  const pagingContainer = document.createElement('div');
  wrapper.appendChild(pagingContainer);

  function applyFiltersAndSort() {
    filteredRows = allRows.filter((row) => {
      if (projectFilter && row.project_name !== projectFilter) return false;
      return COLUMNS.every((col) => {
        const fv = (filterValues[col] ?? '').toLowerCase();
        if (!fv) return true;
        return String(row[col] ?? '').toLowerCase().includes(fv);
      });
    });
    filteredRows.sort((a, b) => {
      const av = String(a[sortCol] ?? '');
      const bv = String(b[sortCol] ?? '');
      const cmp = av.localeCompare(bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  function render() {
    applyFiltersAndSort();
    const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
    if (page >= totalPages) page = 0;

    const pageRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

    const theadHtml = buildTableHead(COLUMNS, COLUMN_LABELS, sortCol, sortDir, filterValues, allRows);

    const tbodyRows = pageRows
      .map((row) => {
        const statusClass = row.status === 'success' ? 'status-success' : row.status === 'failed' ? 'status-failed' : '';
        return `<tr>
          ${COLUMNS.map((col) => {
            const val = row[col];
            if (col === 'name' && val) {
              return `<td><a href="/record?name=${encodeURIComponent(val)}">${escHtml(String(val))}</a></td>`;
            }
            if (col === 'status') {
              return `<td><span class="upgrade-status ${statusClass}">${escHtml(String(val ?? ''))}</span></td>`;
            }
            return `<td>${escHtml(String(val ?? ''))}</td>`;
          }).join('')}
        </tr>`;
      })
      .join('');

    tableContainer.innerHTML = `<table class="assets-table upgrade-table">
      ${theadHtml}
      <tbody>${tbodyRows}</tbody>
    </table>`;

    countEl.textContent = `Showing ${filteredRows.length} of ${allRows.length} records`;

    pagingContainer.innerHTML = buildPagingBar(page, PAGE_SIZE, filteredRows.length, 'upgrade-prev', 'upgrade-next');

    tableContainer.querySelectorAll('th.sortable').forEach((th) => {
      th.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
        const col = th.dataset.col;
        if (sortCol === col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col;
          sortDir = 'asc';
        }
        page = 0;
        render();
      });
    });

    tableContainer.querySelectorAll('.col-filter').forEach((input) => {
      input.addEventListener('input', (e) => {
        filterValues[e.target.dataset.col] = e.target.value;
        page = 0;
        render();
      });
      input.addEventListener('change', (e) => {
        filterValues[e.target.dataset.col] = e.target.value;
        page = 0;
        render();
      });
    });

    pagingContainer.querySelector('#upgrade-prev')?.addEventListener('click', () => {
      if (page > 0) { page--; render(); }
    });
    pagingContainer.querySelector('#upgrade-next')?.addEventListener('click', () => {
      const totalPages = Math.ceil(filteredRows.length / PAGE_SIZE);
      if (page < totalPages - 1) { page++; render(); }
    });
  }

  render();

  wrapper.setProjectFilter = (project) => {
    projectFilter = project;
    page = 0;
    if (project) {
      filterBanner.style.display = 'block';
      filterBanner.textContent = `Filtered by project: ${project} — click elsewhere on chart to clear`;
    } else {
      filterBanner.style.display = 'none';
    }
    render();
  };

  return wrapper;
}

// ---------------------------------------------------------------------------
// Upgrade runner UI
// ---------------------------------------------------------------------------

/**
 * Render the upgrade results object returned by the metadata portal.
 * @param {object} results
 * @param {string} [fallbackName] - The asset name/id typed by the user, used if results.asset_name is missing.
 * @returns {HTMLElement}
 */
function renderUpgradeResults(results, fallbackName) {
  const container = document.createElement('div');
  container.className = 'upgrade-results';

  if (results.error) {
    const p = document.createElement('p');
    p.className = 'upgrade-results-error';
    p.textContent = results.error;
    container.appendChild(p);
    return container;
  }

  const assetName = results.name ?? results.asset_name ?? fallbackName ?? 'Unknown';
  const overall = results.overall_success;
  const partial = results.partial_success;

  const statusClass = overall ? 'upgrade-status-success' : partial ? 'upgrade-status-partial' : 'upgrade-status-failed';
  const statusText = overall ? 'SUCCESS: Full upgrade successful' : partial ? 'PARTIAL: Some fields failed' : 'FAILED: Upgrade failed';

  const header = document.createElement('div');
  header.className = `upgrade-results-header ${statusClass}`;
  header.innerHTML = `<strong>${escHtml(statusText)}</strong> — ${escHtml(assetName)}`;
  container.appendChild(header);

  // Summary counts
  const filesTested = results.files_tested ?? {};
  const fileEntries = Object.entries(filesTested);
  if (fileEntries.length > 0) {
    const successCount = fileEntries.filter(([, r]) => r.success).length;
    const summary = document.createElement('p');
    summary.className = 'upgrade-results-summary';
    summary.innerHTML = `${fileEntries.length} file(s) tested — <span class="status-success">${successCount} succeeded</span> / <span class="status-failed">${fileEntries.length - successCount} failed</span>`;
    container.appendChild(summary);
  }

  // Overall error
  if (results.overall_error) {
    const err = document.createElement('details');
    err.className = 'upgrade-results-err-block';
    err.innerHTML = `<summary>Overall Error</summary><pre>${escHtml(results.overall_error)}</pre>`;
    container.appendChild(err);
  }

  // Per-file sections
  for (const [fileName, fileResult] of fileEntries) {
    const details = document.createElement('details');
    details.className = `upgrade-file-section ${fileResult.success ? 'file-success' : 'file-failed'}`;
    details.open = !fileResult.success; // open failed ones by default

    let displayName = fileName;
    if (fileResult.converted_to) displayName += ` → ${fileResult.converted_to}`;

    const summary = document.createElement('summary');
    summary.className = 'upgrade-file-summary';
    summary.innerHTML = `<span class="upgrade-file-icon">${fileResult.success ? '✓' : '✗'}</span> <strong>${escHtml(displayName)}</strong>`;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'upgrade-file-body';

    if (fileResult.converted_to) {
      const notice = document.createElement('p');
      notice.className = 'upgrade-conversion-notice';
      notice.innerHTML = `Field renamed: <code>${escHtml(fileName)}</code> → <code>${escHtml(fileResult.converted_to)}</code>`;
      body.appendChild(notice);
    }

    if (fileResult.success) {
      const row = document.createElement('div');
      row.className = 'upgrade-json-row';

      const origCol = document.createElement('div');
      origCol.className = 'upgrade-json-col';
      origCol.innerHTML = `<h4>Original</h4><pre class="upgrade-json-pre">${escHtml(JSON.stringify(fileResult.original, null, 2))}</pre>`;

      const upgCol = document.createElement('div');
      upgCol.className = 'upgrade-json-col';
      upgCol.innerHTML = `<h4>Upgraded</h4><pre class="upgrade-json-pre">${escHtml(JSON.stringify(fileResult.upgraded, null, 2))}</pre>`;

      row.appendChild(origCol);
      row.appendChild(upgCol);
      body.appendChild(row);
    } else {
      const errDiv = document.createElement('div');
      errDiv.className = 'upgrade-file-error';
      errDiv.innerHTML = `<p><strong>Error:</strong> ${escHtml(fileResult.error ?? 'Unknown error')}</p>`;

      if (fileResult.traceback) {
        const tb = document.createElement('details');
        tb.innerHTML = `<summary>Traceback</summary><pre>${escHtml(fileResult.traceback)}</pre>`;
        errDiv.appendChild(tb);
      }

      if (fileResult.original) {
        errDiv.innerHTML += `<h4>Original Data</h4><pre class="upgrade-json-pre">${escHtml(JSON.stringify(fileResult.original, null, 2))}</pre>`;
      }

      body.appendChild(errDiv);
    }

    details.appendChild(body);
    container.appendChild(details);
  }

  return container;
}

function buildUpgradeRunner() {
  const section = document.createElement('section');
  section.className = 'upgrade-runner';

  section.innerHTML = `
    <h2>Run Upgrade</h2>
    <p>Enter an asset name or DocDB <code>_id</code> to fetch the record and run the upgrader.</p>
    <div class="upgrade-runner-controls">
      <input id="upgrade-asset-input" type="text" class="upgrade-asset-input"
             placeholder="Asset name or _id…" autocomplete="off" />
      <button id="upgrade-run-btn" class="btn btn-primary" disabled>Run Upgrade</button>
      <button id="upgrade-copy-url-btn" class="btn btn-secondary" disabled>Copy URL</button>
    </div>
    <div id="upgrade-runner-output"></div>
  `;

  const input = section.querySelector('#upgrade-asset-input');
  const runBtn = section.querySelector('#upgrade-run-btn');
  const copyBtn = section.querySelector('#upgrade-copy-url-btn');
  const output = section.querySelector('#upgrade-runner-output');

  // Sync with URL param
  const params = new URLSearchParams(window.location.search);
  const initialId = params.get('asset_id') ?? '';
  if (initialId) {
    input.value = initialId;
    runBtn.disabled = false;
  }

  input.addEventListener('input', () => {
    runBtn.disabled = !input.value.trim();
    if (!input.value.trim()) copyBtn.disabled = true;
  });

  async function runUpgrade() {
    const idOrName = input.value.trim();
    if (!idOrName) return;

    runBtn.disabled = true;
    copyBtn.disabled = true;
    output.innerHTML = '<p class="upgrade-loading">Fetching record…</p>';

    // Update URL
    const url = new URL(window.location.href);
    url.searchParams.set('asset_id', idOrName);
    history.replaceState({}, '', url);

    try {
      // Fetch from the v1 DocDB endpoint to get the original (pre-upgrade) record
      let records = await queryDocDb({ name: idOrName }, { baseUrl: DOCDB_V1_BASE });
      if (!records || records.length === 0) {
        records = await queryDocDb({ _id: idOrName }, { baseUrl: DOCDB_V1_BASE });
      }

      if (!records || records.length === 0) {
        output.innerHTML = `<p class="upgrade-results-error">No record found for: <strong>${escHtml(idOrName)}</strong></p>`;
        runBtn.disabled = false;
        return;
      }

      const record = records[0];
      output.innerHTML = '<p class="upgrade-loading">Running upgrade…</p>';

      const resp = await fetch(UPGRADE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Upgrade API error ${resp.status}: ${text}`);
      }

      const results = await resp.json();
      output.innerHTML = '';
      output.appendChild(renderUpgradeResults(results, idOrName));
      copyBtn.disabled = false;
    } catch (err) {
      output.innerHTML = `<p class="upgrade-results-error">Error: ${escHtml(err.message)}</p>`;
    } finally {
      runBtn.disabled = false;
    }
  }

  runBtn.addEventListener('click', runUpgrade);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !runBtn.disabled) runUpgrade();
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
  });

  // Auto-run if asset_id was in URL
  if (initialId) {
    runUpgrade();
  }

  return section;
}

// ---------------------------------------------------------------------------
// Main view factory
// ---------------------------------------------------------------------------

export async function createUpgradeView({ coordinator }) {
  const root = document.createElement('div');
  root.className = 'upgrade-page';

  const h1 = document.createElement('h1');
  h1.textContent = 'Metadata Upgrade Status';
  root.appendChild(h1);

  if (!coordinator) {
    root.appendChild(Object.assign(document.createElement('p'), {
      className: 'loading-message error',
      textContent: 'DuckDB unavailable — table and charts cannot be loaded.',
    }));
    root.appendChild(buildUpgradeRunner());
    return root;
  }

  // Fetch all rows from metadata_upgrade table (lazy-load if not yet registered)
  let rows;
  try {
    await ensureTable(coordinator, 'metadata_upgrade');
    const result = await coordinator.query(
      `SELECT * FROM metadata_upgrade ORDER BY name`,
    );
    rows = arrowTableToRows(result);
  } catch (err) {
    root.appendChild(Object.assign(document.createElement('p'), {
      className: 'loading-message error',
      textContent: `Failed to load metadata_upgrade table: ${err.message}`,
    }));
    root.appendChild(buildUpgradeRunner());
    return root;
  }

  const total = rows.length;
  const successCount = rows.filter((r) => r.status === 'success').length;

  // Summary bar
  const summary = document.createElement('div');
  summary.className = 'upgrade-summary';
  summary.innerHTML = `<strong>Records upgraded:</strong> ${successCount} / ${total}
    <span class="upgrade-summary-pct">(${total > 0 ? ((successCount / total) * 100).toFixed(1) : 0}%)</span>`;
  root.appendChild(summary);

  // Charts section
  const chartsSection = document.createElement('section');
  chartsSection.className = 'upgrade-charts';

  const versionData = computeVersionData(rows);
  const versionChart = buildVersionChart(versionData);
  if (versionChart) chartsSection.appendChild(versionChart);

  // Table section (built before chart so we can wire the click callback)
  const tableSection = document.createElement('section');
  tableSection.className = 'upgrade-table-section';
  const tableHeading = document.createElement('h2');
  tableHeading.textContent = 'All Records';
  tableSection.appendChild(tableHeading);
  const tableEl = buildUpgradeTable(rows, deriveColumns(rows));
  tableSection.appendChild(tableEl);

  const { projectData, projectOrder } = computeProjectAggregates(rows);
  if (projectOrder.length > 0) {
    chartsSection.appendChild(buildProjectChart(projectData, projectOrder, (project) => {
      tableEl.setProjectFilter(project);
    }));
  }

  root.appendChild(chartsSection);
  root.appendChild(tableSection);

  // Upgrade runner
  root.appendChild(buildUpgradeRunner());

  return root;
}

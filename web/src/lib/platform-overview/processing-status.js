/**
 * lib/platform-overview/processing-status.js — "Processing status" collapsible
 * dropdown for the platform overview.
 *
 * Shows, for a one-week window (default: last 7 days, navigable with prev/next),
 * each acquisition's pipeline stages as discrete steps ordered by when they ran,
 * with timestamps and captured error tracebacks for failures.
 *
 * The operations table is partitioned by asset_name. The in-range acquisition
 * list is resolved from asset_basics first so only the matching partition
 * parquet files are read (not every partition).
 *
 * @module
 */

import { queryRows } from '../arrow.js';
import { getResolvedVersion } from '../metadata.js';
import { escHtml, formatDate, formatDatetime } from '../utils.js';
import { S3_BUCKET, S3_REGION } from '../../constants.js';

/**
 * @param {object} ctx  Shared overview context ({ coord, operationsTableName }).
 */
export function createProcessingStatusDropdown(ctx) {
  const { coord, operationsTableName } = ctx;

  const col = document.createElement('div');
  col.className = 'platform-dropdown-col';

  const toggle = document.createElement('button');
  toggle.className = 'platform-qc-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const arrow = document.createElement('span');
  arrow.className = 'platform-qc-toggle-arrow';
  arrow.textContent = '▶';
  toggle.appendChild(arrow);
  toggle.appendChild(document.createTextNode(' Processing status'));

  const content = document.createElement('div');
  content.className = 'platform-ops-section';
  content.hidden = true;

  col.appendChild(toggle);
  col.appendChild(content);

  let built = false;

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    arrow.textContent = expanded ? '▼' : '▶';
    content.hidden = !expanded;
    if (expanded && !built) {
      built = true;
      buildOperationsSection(coord, { operationsTableName }, content);
    }
  });

  return { col };
}

function buildOperationsSection(coord, { operationsTableName }, containerEl) {
  containerEl.innerHTML = '';

  if (!operationsTableName) {
    const empty = document.createElement('p');
    empty.className = 'settings-loading-note';
    empty.textContent = 'No processing operations for this platform.';
    containerEl.appendChild(empty);
    return;
  }

  const WEEK_MS = 7 * 864e5;
  const maxEnd = new Date();
  let end = new Date();
  let start = new Date(end.getTime() - WEEK_MS);

  const controls = document.createElement('div');
  controls.className = 'ops-controls';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'settings-metric-btn';
  prevBtn.textContent = '‹ Prev week';

  const rangeLabel = document.createElement('span');
  rangeLabel.className = 'ops-range';

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'settings-metric-btn';
  nextBtn.textContent = 'Next week ›';

  const failureLabel = document.createElement('label');
  failureLabel.className = 'ops-filter';
  const failureToggle = document.createElement('input');
  failureToggle.type = 'checkbox';
  failureLabel.append(failureToggle, document.createTextNode(' Only errors'));

  controls.append(prevBtn, rangeLabel, nextBtn, failureLabel);

  const body = document.createElement('div');
  body.className = 'ops-body';

  containerEl.append(controls, body);

  const filterState = { onlyErrors: false };

  failureToggle.addEventListener('change', () => {
    filterState.onlyErrors = failureToggle.checked;
    body.__applyFilter?.();
  });

  let reqId = 0;

  function reload() {
    rangeLabel.textContent = `${formatDate(start.toISOString())} – ${formatDate(end.toISOString())}`;
    nextBtn.disabled = end.getTime() >= maxEnd.getTime();
    const myReq = ++reqId;
    loadOperations(coord, { operationsTableName, start, end, filterState }, body, () => myReq === reqId);
  }

  prevBtn.addEventListener('click', () => {
    start = new Date(start.getTime() - WEEK_MS);
    end = new Date(end.getTime() - WEEK_MS);
    reload();
  });
  nextBtn.addEventListener('click', () => {
    if (end.getTime() >= maxEnd.getTime()) return;
    start = new Date(start.getTime() + WEEK_MS);
    end = new Date(Math.min(end.getTime() + WEEK_MS, maxEnd.getTime()));
    reload();
  });

  reload();
}

async function loadOperations(coord, { operationsTableName, start, end, filterState }, containerEl, isCurrent) {
  containerEl.innerHTML = '';
  containerEl.__applyFilter = null;
  const stillCurrent = () => (isCurrent ? isCurrent() : true);

  const loadingEl = document.createElement('p');
  loadingEl.className = 'settings-loading-note';
  loadingEl.textContent = 'Loading…';
  containerEl.appendChild(loadingEl);

  try {
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    // In-range acquisitions come from asset_basics (already in memory) so we
    // only read the matching partition parquet files, not every partition.
    const abRows = await queryRows(coord,
      `SELECT name, acquisition_start_time AS acq
       FROM asset_basics
       WHERE acquisition_start_time >= '${startIso}'
         AND acquisition_start_time < '${endIso}'`);
    if (!stillCurrent()) return;

    const acqByName = new Map();
    for (const r of abRows) acqByName.set(r.name, r.acq);

    if (!acqByName.size) {
      loadingEl.remove();
      const empty = document.createElement('p');
      empty.className = 'settings-loading-note';
      empty.textContent = 'No acquisitions in this week.';
      containerEl.appendChild(empty);
      return;
    }

    // DuckDB-WASM cannot expand `*` globs over virtual-hosted S3 HTTPS URLs, so
    // resolve the partition shards explicitly via S3 ListObjectsV2. Each
    // partition dir is asset_name=<acquisition>/data.pqt.
    const prefix = `data-asset-cache/${getResolvedVersion()}/${operationsTableName}/`;
    const listUrl =
      `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/` +
      `?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    const urlByName = new Map();
    let token = null;
    do {
      const pageUrl = token ? `${listUrl}&continuation-token=${encodeURIComponent(token)}` : listUrl;
      const resp = await fetch(pageUrl);
      if (!resp.ok) throw new Error(`S3 list returned ${resp.status}`);
      const xml = await resp.text();
      const re = /<Key>([^<]+asset_name=([^/]+)\/[^<]+\.pqt)<\/Key>/g;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const name = decodeURIComponent(m[2]);
        if (acqByName.has(name)) {
          urlByName.set(name, `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${m[1]}`);
        }
      }
      const tokMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
      token = tokMatch ? tokMatch[1] : null;
    } while (token);
    if (!stillCurrent()) return;

    if (!urlByName.size) {
      loadingEl.remove();
      const empty = document.createElement('p');
      empty.className = 'settings-loading-note';
      empty.textContent = 'No processing operations for this week’s acquisitions.';
      containerEl.appendChild(empty);
      return;
    }

    const source = `[${[...urlByName.values()].map((u) => `'${u.replace(/'/g, "''")}'`).join(', ')}]`;
    const sql = `
      SELECT asset_name, process_name,
        MIN(timestamp) AS first_ts,
        MAX(timestamp) AS last_ts,
        arg_max(event_type, timestamp) AS last_event,
        arg_max(error_info, timestamp) AS last_error
      FROM read_parquet(${source}, hive_partitioning=true, union_by_name=true)
      GROUP BY asset_name, process_name
      ORDER BY asset_name, first_ts
    `;
    const rows = await queryRows(coord, sql);
    if (!stillCurrent()) return;
    loadingEl.remove();

    const byAsset = new Map();
    for (const r of rows) {
      if (!byAsset.has(r.asset_name)) {
        byAsset.set(r.asset_name, { acq: acqByName.get(r.asset_name) ?? null, steps: [] });
      }
      byAsset.get(r.asset_name).steps.push(r);
    }

    // Most-recent acquisition first (missing acquisition times sort last).
    const ordered = [...byAsset.entries()].sort((a, b) => {
      const ta = a[1].acq, tb = b[1].acq;
      if (ta && tb) return ta < tb ? 1 : ta > tb ? -1 : 0;
      if (ta) return -1;
      if (tb) return 1;
      return 0;
    });

    const table = document.createElement('table');
    table.className = 'assets-table platform-ops-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Asset name</th><th>Acquired</th><th>Processing steps</th></tr>';
    const tbody = document.createElement('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);

    for (const [name, info] of ordered) {
      const tr = document.createElement('tr');

      const hasFailure = info.steps.some((s) => s.last_event === 'stage_error');
      if (hasFailure) tr.dataset.hasFailure = 'true';

      const nameTd = document.createElement('td');
      nameTd.className = 'ops-asset';
      nameTd.textContent = name;

      const acqTd = document.createElement('td');
      acqTd.textContent = info.acq ? formatDate(info.acq) : '—';

      const stepsTd = document.createElement('td');
      const stepsRow = document.createElement('div');
      stepsRow.className = 'ops-steps';
      const detail = document.createElement('div');
      detail.className = 'ops-detail';
      detail.hidden = true;

      // Steps are already ordered by first_ts (when the step ran), rendered
      // left-to-right as temporal columns.
      info.steps.forEach((s, i) => {
        const st = s.last_event === 'stage_complete' ? 'done'
          : s.last_event === 'stage_error' ? 'error'
          : 'running';
        const label = String(s.process_name ?? '').replace(/^aind-/, '');

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ops-step ops-step-${st}`;
        btn.innerHTML = `<span class="ops-step-name">`
          + `<span class="ops-step-num">${i + 1}</span>${escHtml(label)}</span>`
          + `<span class="ops-step-time">${escHtml(s.last_ts ? formatDatetime(s.last_ts) : '')}</span>`;

        btn.addEventListener('click', () => {
          const wasSelected = btn.classList.contains('is-selected');
          stepsRow.querySelectorAll('.ops-step.is-selected').forEach((el) => el.classList.remove('is-selected'));
          if (wasSelected) {
            detail.hidden = true;
            return;
          }
          btn.classList.add('is-selected');
          detail.hidden = false;
          detail.innerHTML = renderStepDetail(s, st);
        });

        stepsRow.appendChild(btn);
      });

      stepsTd.appendChild(stepsRow);
      stepsTd.appendChild(detail);
      tr.append(nameTd, acqTd, stepsTd);
      tbody.appendChild(tr);
    }

    containerEl.appendChild(table);

    const applyFilter = () => {
      const onlyErrors = filterState?.onlyErrors;
      for (const tr of tbody.querySelectorAll('tr')) {
        tr.hidden = onlyErrors && tr.dataset.hasFailure !== 'true';
      }
    };
    containerEl.__applyFilter = applyFilter;
    applyFilter();
  } catch (err) {
    if (!stillCurrent()) return;
    loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
    console.error('[PlatformOverview] operations query failed:', err);
  }
}

/** Build the expandable detail panel HTML for a single processing step. */
function renderStepDetail(s, st) {
  const statusLabel = st === 'done' ? 'Completed' : st === 'error' ? 'Failed' : 'In progress';
  const ran = s.last_ts ? formatDatetime(s.last_ts) : '—';
  const started = s.first_ts ? formatDatetime(s.first_ts) : '—';
  let html = `<div class="ops-detail-head"><strong>${escHtml(String(s.process_name ?? ''))}</strong>`
    + ` <span class="ops-step-${st}">${escHtml(statusLabel)}</span></div>`
    + `<div class="ops-detail-meta">Started ${escHtml(started)} · Last event ${escHtml(ran)}</div>`;
  if (st === 'error' && s.last_error) {
    html += `<pre class="ops-detail-error">${escHtml(String(s.last_error))}</pre>`;
  }
  return html;
}


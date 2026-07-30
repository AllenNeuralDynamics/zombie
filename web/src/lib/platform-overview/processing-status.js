/**
 * lib/platform-overview/processing-status.js — "Processing status" collapsible
 * dropdown for the platform overview.
 *
 * Shows, for a one-week window (default: last 7 days, navigable with prev/next),
 * each acquisition's pipeline stages as discrete steps ordered by when they ran,
 * with timestamps and captured error tracebacks for failures. One table column
 * per pipeline, so a step's pipeline is read off the column it sits in rather
 * than from a flat run of steps from several pipelines interleaved by time.
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
 * Column holding the pipeline a step belongs to, and the column holding the
 * step's CloudWatch log URL. Both were added to the operations cache after this
 * page was written and are not present in every cache version, so they are
 * resolved against the parquet schema at query time (see {@link resolveOptionalColumns})
 * rather than referenced unguarded — an older cache would otherwise fail the
 * whole query. Each list is tried in order; the first column that exists wins.
 */
const PIPELINE_COLUMNS = ['pipeline_name', 'pipeline'];
const LOG_URL_COLUMNS = [
  'cloudwatch_url', 'cloudwatch_logs_url', 'cloudwatch_log_url', 'log_url', 'logs_url',
];

/** Column header for steps whose pipeline is unknown (cache without a pipeline column). */
const UNKNOWN_PIPELINE_LABEL = 'Processing steps';

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

  // The view opens on failures only — that's what anyone opening "processing
  // status" is looking for, and a week of successful runs is a lot of rows to
  // scroll past to find them. Ticking the box widens it back to every asset.
  const showAllLabel = document.createElement('label');
  showAllLabel.className = 'ops-filter';
  const showAllToggle = document.createElement('input');
  showAllToggle.type = 'checkbox';
  showAllToggle.checked = false;
  showAllLabel.append(showAllToggle, document.createTextNode(' Show all assets'));

  controls.append(prevBtn, rangeLabel, nextBtn, showAllLabel);

  const body = document.createElement('div');
  body.className = 'ops-body';

  containerEl.append(controls, body);

  const filterState = { onlyErrors: !showAllToggle.checked };

  showAllToggle.addEventListener('change', () => {
    filterState.onlyErrors = !showAllToggle.checked;
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
    const readParquet = `read_parquet(${source}, hive_partitioning=true, union_by_name=true)`;

    const optional = await resolveOptionalColumns(coord, readParquet);
    if (!stillCurrent()) return;

    // A step's pipeline and log URL are attributes of the step, not something to
    // aggregate over, but the query groups by step — take the newest event's
    // value so a URL that appears only on the failing event still comes through.
    const pipelineExpr = optional.pipeline ? optional.pipeline : 'CAST(NULL AS VARCHAR)';
    const logUrlExpr = optional.logUrl
      ? `arg_max(${optional.logUrl}, timestamp)`
      : 'CAST(NULL AS VARCHAR)';
    const sql = `
      SELECT asset_name, process_name,
        ${pipelineExpr} AS pipeline,
        MIN(timestamp) AS first_ts,
        MAX(timestamp) AS last_ts,
        arg_max(event_type, timestamp) AS last_event,
        arg_max(error_info, timestamp) AS last_error,
        ${logUrlExpr} AS log_url
      FROM ${readParquet}
      GROUP BY asset_name, process_name, ${pipelineExpr}
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

    // Pipelines become table columns, ordered by when each first ran across the
    // whole window — the leftmost column is the earliest stage of the workflow,
    // which is also the order someone reading a single asset's row expects.
    const pipelineFirstTs = new Map();
    for (const r of rows) {
      const key = pipelineKey(r);
      const prev = pipelineFirstTs.get(key);
      if (prev == null || (r.first_ts != null && r.first_ts < prev)) {
        pipelineFirstTs.set(key, r.first_ts ?? prev ?? null);
      }
    }
    const pipelines = [...pipelineFirstTs.keys()].sort((a, b) => {
      const ta = pipelineFirstTs.get(a);
      const tb = pipelineFirstTs.get(b);
      if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
      if (ta && !tb) return -1;
      if (tb && !ta) return 1;
      return a.localeCompare(b);
    });

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
    thead.innerHTML = '<tr><th>Asset name</th><th>Acquired</th>'
      + pipelines.map((p) => `<th>${escHtml(p)}</th>`).join('')
      + '</tr>';
    const tbody = document.createElement('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);

    for (const [name, info] of ordered) {
      const tr = document.createElement('tr');
      tr.className = 'ops-asset-row';

      const hasFailure = info.steps.some((s) => s.last_event === 'stage_error');
      if (hasFailure) tr.dataset.hasFailure = 'true';

      const nameTd = document.createElement('td');
      nameTd.className = 'ops-asset';
      nameTd.textContent = name;

      const acqTd = document.createElement('td');
      acqTd.textContent = info.acq ? formatDate(info.acq) : '—';

      tr.append(nameTd, acqTd);

      // The detail panel is a full-width row under the asset's own row: with a
      // column per pipeline, a panel nested inside one narrow cell would either
      // squeeze the traceback or stretch that column past its steps.
      const detailRow = document.createElement('tr');
      detailRow.className = 'ops-detail-row';
      detailRow.hidden = true;
      const detailCell = document.createElement('td');
      detailCell.colSpan = 2 + pipelines.length;
      const detail = document.createElement('div');
      detail.className = 'ops-detail';
      detailCell.appendChild(detail);
      detailRow.appendChild(detailCell);

      const selectStep = (btn, s, st) => {
        const wasSelected = btn.classList.contains('is-selected');
        tr.querySelectorAll('.ops-step.is-selected').forEach((el) => el.classList.remove('is-selected'));
        if (wasSelected) {
          detailRow.hidden = true;
          return;
        }
        btn.classList.add('is-selected');
        detailRow.hidden = false;
        detail.innerHTML = renderStepDetail(s, st);
      };

      const stepsByPipeline = new Map();
      for (const s of info.steps) {
        const key = pipelineKey(s);
        if (!stepsByPipeline.has(key)) stepsByPipeline.set(key, []);
        stepsByPipeline.get(key).push(s);
      }

      for (const pipeline of pipelines) {
        const td = document.createElement('td');
        const steps = stepsByPipeline.get(pipeline) ?? [];
        if (!steps.length) {
          td.className = 'ops-cell-empty';
          td.textContent = '—';
          tr.appendChild(td);
          continue;
        }

        const stepsRow = document.createElement('div');
        stepsRow.className = 'ops-steps';

        // Steps arrive ordered by first_ts (when the step ran); within a
        // pipeline column they read left-to-right in that order, numbered from 1
        // per pipeline rather than continuing across pipelines.
        steps.forEach((s, i) => {
          const st = s.last_event === 'stage_complete' ? 'done'
            : s.last_event === 'stage_error' ? 'error'
            : 'running';
          const label = String(s.process_name ?? '').replace(/^aind-/, '');

          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `ops-step ops-step-${st}`;
          btn.innerHTML = '<span class="ops-step-name">'
            + `<span class="ops-step-num">${i + 1}</span>${escHtml(label)}</span>`
            + `<span class="ops-step-time">${escHtml(s.last_ts ? formatDatetime(s.last_ts) : '')}</span>`;

          btn.addEventListener('click', () => selectStep(btn, s, st));
          stepsRow.appendChild(btn);
        });

        td.appendChild(stepsRow);
        tr.appendChild(td);
      }

      tbody.append(tr, detailRow);
    }

    containerEl.appendChild(table);

    // Now that the default view is errors-only, an empty table is the *good*
    // outcome and needs saying so — otherwise a clean week is indistinguishable
    // from a broken query.
    const emptyNote = document.createElement('p');
    emptyNote.className = 'settings-loading-note';
    emptyNote.textContent = 'No errors for this week’s acquisitions.';
    emptyNote.hidden = true;
    containerEl.appendChild(emptyNote);

    const applyFilter = () => {
      const onlyErrors = filterState?.onlyErrors;
      let shownCount = 0;
      for (const tr of tbody.querySelectorAll('tr.ops-asset-row')) {
        const hide = Boolean(onlyErrors) && tr.dataset.hasFailure !== 'true';
        tr.hidden = hide;
        if (!hide) shownCount += 1;
        // The detail row follows its asset row and must never outlive it on
        // screen — a filtered-out asset's open traceback would otherwise sit
        // there with no row to belong to.
        const detailRow = tr.nextElementSibling;
        if (detailRow?.classList.contains('ops-detail-row')) {
          if (hide) {
            detailRow.hidden = true;
            tr.querySelectorAll('.ops-step.is-selected').forEach((el) => el.classList.remove('is-selected'));
          }
        }
      }
      emptyNote.hidden = shownCount > 0;
      table.hidden = shownCount === 0;
    };
    containerEl.__applyFilter = applyFilter;
    applyFilter();
  } catch (err) {
    if (!stillCurrent()) return;
    loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
    console.error('[PlatformOverview] operations query failed:', err);
  }
}

/** The pipeline column a step belongs to; steps without one share a single column. */
function pipelineKey(row) {
  const raw = row.pipeline == null ? '' : String(row.pipeline).trim();
  return raw || UNKNOWN_PIPELINE_LABEL;
}

/**
 * Which of the optional columns this cache version actually has. A single
 * DESCRIBE against the same parquet set the main query reads keeps the
 * page working on an older cache instead of failing on an unknown column.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coord
 * @param {string} readParquet - The `read_parquet(...)` expression to describe.
 * @returns {Promise<{pipeline: string|null, logUrl: string|null}>}
 */
async function resolveOptionalColumns(coord, readParquet) {
  try {
    const rows = await queryRows(coord, `DESCRIBE SELECT * FROM ${readParquet} LIMIT 0`);
    const names = new Set(rows.map((r) => String(r.column_name)));
    return {
      pipeline: PIPELINE_COLUMNS.find((c) => names.has(c)) ?? null,
      logUrl: LOG_URL_COLUMNS.find((c) => names.has(c)) ?? null,
    };
  } catch (err) {
    console.warn('[PlatformOverview] could not describe operations columns:', err?.message ?? err);
    return { pipeline: null, logUrl: null };
  }
}

/** Only http(s) log URLs are linked — anything else is not ours to hand to the browser. */
function safeLogUrl(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw;
}

/** Build the expandable detail panel HTML for a single processing step. */
function renderStepDetail(s, st) {
  const statusLabel = st === 'done' ? 'Completed' : st === 'error' ? 'Failed' : 'In progress';
  const ran = s.last_ts ? formatDatetime(s.last_ts) : '—';
  const started = s.first_ts ? formatDatetime(s.first_ts) : '—';
  const pipeline = s.pipeline == null ? '' : String(s.pipeline).trim();
  let html = `<div class="ops-detail-head"><strong>${escHtml(String(s.process_name ?? ''))}</strong>`
    + ` <span class="ops-step-${st}">${escHtml(statusLabel)}</span></div>`
    + '<div class="ops-detail-meta">'
    + (pipeline ? `Pipeline ${escHtml(pipeline)} · ` : '')
    + `Started ${escHtml(started)} · Last event ${escHtml(ran)}</div>`;
  if (st === 'error' && s.last_error) {
    html += `<pre class="ops-detail-error">${escHtml(String(s.last_error))}</pre>`;
  }
  // The captured traceback is usually a summary; CloudWatch has the full run
  // log, so a failure always offers the jump-off point when the cache has one.
  const logUrl = st === 'error' ? safeLogUrl(s.log_url) : null;
  if (logUrl) {
    html += `<a class="ops-detail-log" href="${escHtml(logUrl)}" target="_blank" rel="noopener noreferrer">`
      + 'View CloudWatch logs ↗</a>';
  }
  return html;
}


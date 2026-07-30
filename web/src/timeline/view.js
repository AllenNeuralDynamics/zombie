/**
 * timeline/view.js — "Asset timeline" dashboard.
 *
 * Shows, for every raw acquisition in a date window, how long it took to move
 * through the pipeline: acquisition → upload → processing → visible in the data
 * portal. The milestone semantics (and the 06:00-next-day portal release rule)
 * live in `timeline-model.js`; this module is query + DOM + chart only.
 *
 * Data sources:
 *   - `asset_basics` — acquisition times and `created` (the DocDB record is
 *     written on upload completion, so it stands in for upload time).
 *   - `source_data` — reverse-mapped to find each acquisition's newest derived
 *     asset, whose `processing_time` is "processing complete".
 *   - `platform_fib_operations` — optional per-stage detail for fiber
 *     photometry acquisitions, expanded on demand for a single row (the table
 *     is partitioned per asset, so it is never read in bulk here).
 *
 * @module
 */

import * as Plot from '@observablehq/plot';
import { queryRows } from '../lib/arrow.js';
import { ensureTable } from '../lib/registry.js';
import { getResolvedVersion } from '../lib/metadata.js';
import { escHtml, formatDatetime, downloadCsv } from '../lib/utils.js';
import { S3_BUCKET, S3_REGION } from '../constants.js';
import {
  PIPELINE_STAGES,
  STATUS_LABELS,
  buildAssetTimeline,
  countByStatus,
  formatDuration,
  median,
  percentile,
} from './timeline-model.js';

/** Window lengths offered by the range selector, in days. */
const WINDOW_OPTIONS = [
  { days: 7, label: '7 days' },
  { days: 14, label: '14 days' },
  { days: 30, label: '30 days' },
];

const HIST_BIN_COUNT = 16;

/**
 * Fixed x-axis range for every stage histogram, in hours. A shared, fixed
 * range (rather than one scaled to whatever the data happens to span) is what
 * makes the panels comparable at a glance — "processing" and "awaiting
 * release" are read on the same visual scale every time, not zoomed
 * differently window to window. Durations beyond this fold into the last bin
 * rather than being dropped (see buildStageHistogram).
 */
const HIST_MAX_HOURS = 24;

const DAY_MS = 864e5;

function esc(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Format a milestone as its elapsed offset from the *previous* milestone, e.g.
 * "+4:12" or "+1d 02:05" — the incremental time that single stage took, not
 * the running total from acquisition start. Absolute clock time is shown once,
 * in the "Acquired" column; every later column is this stage's own duration.
 *
 * @param {number|null} originMs - The previous milestone, epoch ms.
 * @param {number|null} ms - Milestone to format, epoch ms.
 * @returns {string}
 */
function formatOffset(originMs, ms) {
  if (ms == null || originMs == null) return '—';
  const diffMs = ms - originMs;
  const sign = diffMs < 0 ? '−' : '+';
  const totalMin = Math.round(Math.abs(diffMs) / 6e4);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const minutes = totalMin % 60;
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  return days > 0 ? `${sign}${days}d ${hh}:${mm}` : `${sign}${hh}:${mm}`;
}

/**
 * Resolve this render's actual colour values from CSS custom properties, so
 * light/dark mode each get their own already-chosen ink instead of a JS-side
 * duplicate of the palette.
 *
 * The histogram encodes one thing only: did the asset finish this stage or is
 * it still in it. "Done" is text ink (black on light surfaces, near-white on
 * dark ones — a bar in the page's own ink reads as the neutral baseline), and
 * "not done" is a light red that stands out against it without shouting.
 *
 * @param {HTMLElement} rootEl - Element to read computed custom properties from.
 */
function resolveColors(rootEl) {
  const styles = getComputedStyle(rootEl);
  const get = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    done: get('--timeline-done', '#111111'),
    pending: get('--timeline-pending', '#f0a3a0'),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Build the asset timeline view.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coord
 * @returns {HTMLElement}
 */
export function createTimelineView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view timeline-view';

  const header = document.createElement('div');
  header.className = 'assets-header';
  header.innerHTML = '<h2>Asset timeline</h2>';
  container.appendChild(header);

  const intro = document.createElement('p');
  intro.className = 'timeline-intro';
  intro.textContent =
    'Time from acquisition to visibility in the data portal, per raw acquisition. '
    + 'Assets become visible at the next 06:00 Pacific time after processing completes.';
  container.appendChild(intro);

  const controls = document.createElement('div');
  controls.className = 'timeline-controls';
  container.appendChild(controls);

  const notice = document.createElement('div');
  notice.className = 'timeline-notice';
  notice.hidden = true;
  container.appendChild(notice);

  const body = document.createElement('div');
  body.className = 'timeline-body';
  container.appendChild(body);

  const state = {
    windowDays: 14,
    end: new Date(),
    modality: '',
    project: '',
    timelines: [],
    reqId: 0,
  };

  buildControls(controls, state, () => reload());

  function reload() {
    const myReq = ++state.reqId;
    loadAndRender(coord, state, body, notice, controls, () => myReq === state.reqId);
  }

  reload();
  return container;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function buildControls(controls, state, onChange) {
  controls.innerHTML = '';

  // ── Window navigation ────────────────────────────────────────────────────
  const nav = document.createElement('div');
  nav.className = 'timeline-nav';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'settings-metric-btn';
  prevBtn.textContent = '‹ Earlier';

  const rangeLabel = document.createElement('span');
  rangeLabel.className = 'ops-range timeline-range';

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'settings-metric-btn';
  nextBtn.textContent = 'Later ›';

  nav.append(prevBtn, rangeLabel, nextBtn);

  const windowSel = document.createElement('select');
  windowSel.className = 'timeline-select';
  windowSel.setAttribute('aria-label', 'Window length');
  for (const opt of WINDOW_OPTIONS) {
    const o = document.createElement('option');
    o.value = String(opt.days);
    o.textContent = opt.label;
    if (opt.days === state.windowDays) o.selected = true;
    windowSel.appendChild(o);
  }

  // ── Filters ──────────────────────────────────────────────────────────────
  const modalitySel = document.createElement('select');
  modalitySel.className = 'timeline-select';
  modalitySel.setAttribute('aria-label', 'Modality');
  modalitySel.innerHTML = '<option value="">All modalities</option>';

  const projectSel = document.createElement('select');
  projectSel.className = 'timeline-select';
  projectSel.setAttribute('aria-label', 'Project');
  projectSel.innerHTML = '<option value="">All projects</option>';

  const csvBtn = document.createElement('button');
  csvBtn.type = 'button';
  csvBtn.className = 'settings-metric-btn timeline-csv';
  csvBtn.textContent = 'Download CSV';

  controls.append(nav, windowSel, modalitySel, projectSel, csvBtn);

  // The filter selects are repopulated from each query's results; the client
  // filters (modality, project) re-render without re-querying.
  state.els = { rangeLabel, nextBtn, modalitySel, projectSel };

  prevBtn.addEventListener('click', () => {
    state.end = new Date(state.end.getTime() - state.windowDays * DAY_MS);
    onChange();
  });
  nextBtn.addEventListener('click', () => {
    const next = new Date(state.end.getTime() + state.windowDays * DAY_MS);
    state.end = next > new Date() ? new Date() : next;
    onChange();
  });
  windowSel.addEventListener('change', () => {
    state.windowDays = Number(windowSel.value);
    onChange();
  });
  modalitySel.addEventListener('change', () => {
    state.modality = modalitySel.value;
    state.rerender?.();
  });
  projectSel.addEventListener('change', () => {
    state.project = projectSel.value;
    state.rerender?.();
  });
  csvBtn.addEventListener('click', () => exportCsv(state));
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Whether `asset_basics` carries the `created` (upload time) column yet. The
 * column was added to the cache after this page was written, so an older cache
 * version is served without it; referencing it unguarded would fail the whole
 * query.
 */
async function hasCreatedColumn(coord) {
  try {
    const rows = await queryRows(
      coord,
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'asset_basics' AND column_name = 'created'`,
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

function buildTimelineSql({ startIso, endIso, withCreated }) {
  // `created` is ISO-8601 text in the cache; TRY_CAST keeps a malformed value
  // from failing the whole query.
  const uploadedExpr = withCreated ? 'TRY_CAST(created AS TIMESTAMPTZ)' : 'CAST(NULL AS TIMESTAMPTZ)';
  const derivedUploadExpr = withCreated ? 'TRY_CAST(ab.created AS TIMESTAMPTZ)' : 'CAST(NULL AS TIMESTAMPTZ)';

  return `
    WITH raw AS (
      SELECT name, subject_id, project_name, modalities,
             acquisition_start_time AS acq_start,
             acquisition_end_time AS acq_end,
             ${uploadedExpr} AS uploaded
      FROM asset_basics
      WHERE data_level = 'raw'
        AND acquisition_start_time >= '${esc(startIso)}'
        AND acquisition_start_time < '${esc(endIso)}'
    ),
    -- source_data.source_data is a ", "-joined list of the raw assets a derived
    -- asset came from; split it so raw → derived becomes a plain equijoin.
    derived AS (
      SELECT unnest(string_split(sd.source_data, ', ')) AS raw_name,
             ab.name AS derived_name,
             COALESCE(TRY_CAST(sd.processing_time AS TIMESTAMPTZ), ${derivedUploadExpr}) AS processed
      FROM source_data sd
      JOIN asset_basics ab ON ab.name = sd.name
      WHERE ab.data_level = 'derived'
    ),
    -- Assets get reprocessed; the newest run is the one that governs release.
    latest AS (
      SELECT raw_name,
             MAX(processed) AS processed,
             arg_max(derived_name, processed) AS derived_name
      FROM derived
      WHERE processed IS NOT NULL
      GROUP BY raw_name
    )
    SELECT r.name, r.subject_id, r.project_name, r.modalities,
           CAST(epoch_ms(r.acq_start) AS DOUBLE) AS acq_start_ms,
           CAST(epoch_ms(r.acq_end)   AS DOUBLE) AS acq_end_ms,
           CAST(epoch_ms(r.uploaded)  AS DOUBLE) AS uploaded_ms,
           CAST(epoch_ms(l.processed) AS DOUBLE) AS processed_ms,
           l.derived_name
    FROM raw r
    LEFT JOIN latest l ON l.raw_name = r.name
    ORDER BY r.acq_start DESC
  `;
}

async function loadAndRender(coord, state, body, notice, controls, isCurrent) {
  const stillCurrent = () => (isCurrent ? isCurrent() : true);

  const start = new Date(state.end.getTime() - state.windowDays * DAY_MS);
  state.els.rangeLabel.textContent =
    `${start.toISOString().slice(0, 10)} – ${state.end.toISOString().slice(0, 10)}`;
  state.els.nextBtn.disabled = state.end.getTime() >= Date.now() - 6e4;

  body.innerHTML = '';
  const loadingEl = document.createElement('p');
  loadingEl.className = 'settings-loading-note';
  loadingEl.textContent = 'Loading…';
  body.appendChild(loadingEl);

  try {
    await ensureTable(coord, 'source_data');
    if (!stillCurrent()) return;

    const withCreated = await hasCreatedColumn(coord);
    if (!stillCurrent()) return;

    notice.hidden = withCreated;
    if (!withCreated) {
      notice.textContent =
        'Upload time is unavailable: this cache version of asset_basics has no '
        + '"created" column yet. Acquisition and processing milestones are shown; '
        + 'the upload milestone will appear once the cache is rebuilt.';
    }

    const rows = await queryRows(coord, buildTimelineSql({
      startIso: start.toISOString(),
      endIso: state.end.toISOString(),
      withCreated,
    }));
    if (!stillCurrent()) return;

    const nowMs = Date.now();
    state.timelines = rows.map((r) => buildAssetTimeline(r, { nowMs }));
    populateFilterOptions(state);

    loadingEl.remove();

    state.rerender = () => {
      if (!stillCurrent()) return;
      render(coord, state, body);
    };
    state.rerender();
  } catch (err) {
    if (!stillCurrent()) return;
    loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
    loadingEl.className = 'settings-loading-note error';
    console.error('[Timeline] query failed:', err);
  }
}

/** Refresh the modality/project selects from the loaded rows, keeping selections. */
function populateFilterOptions(state) {
  const { modalitySel, projectSel } = state.els;

  const modalities = [...new Set(state.timelines.flatMap((t) => t.modalities))].sort();
  const projects = [...new Set(state.timelines.map((t) => t.projectName).filter(Boolean))].sort();

  const fill = (sel, values, allLabel, selected) => {
    sel.innerHTML = `<option value="">${allLabel}</option>`;
    for (const v of values) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      if (v === selected) o.selected = true;
      sel.appendChild(o);
    }
    // A selection that no longer exists in this window falls back to "all".
    if (selected && !values.includes(selected)) sel.value = '';
  };

  fill(modalitySel, modalities, 'All modalities', state.modality);
  fill(projectSel, projects, 'All projects', state.project);
  state.modality = modalitySel.value;
  state.project = projectSel.value;
}

function visibleTimelines(state) {
  return state.timelines.filter((t) => {
    if (state.modality && !t.modalities.includes(state.modality)) return false;
    if (state.project && t.projectName !== state.project) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render(coord, state, body) {
  body.innerHTML = '';
  const shown = visibleTimelines(state);

  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'settings-loading-note';
    empty.textContent = 'No acquisitions match the current filters.';
    body.appendChild(empty);
    return;
  }

  body.appendChild(buildStageHistograms(body, shown));
  body.appendChild(buildTable(coord, shown));
}

/**
 * One histogram per pipeline stage, laid out left-to-right in pipeline order,
 * plus a fifth terminal card for "visible in portal" (a count, not a duration —
 * once visible there is nothing left to wait for). This is the *only* place
 * status counts appear: each stage panel carries how many acquisitions are
 * currently sitting in that stage right now, directly beside the histogram of
 * how long that stage has historically taken — one card tells both halves of
 * the story instead of a disconnected numbers strip above an unlabeled chart.
 *
 * All five cards share the row's full width and, for the four histograms, one
 * x-axis scale (same domain, same bin width) so bar widths and positions are
 * directly comparable across stages — a panel with a tighter spread is not
 * just zoomed in.
 *
 * This is a distribution of durations, not a per-asset timeline, so it stays a
 * fixed, compact height regardless of how many acquisitions are in view (the
 * per-asset detail lives in the table below).
 */
function buildStageHistograms(rootEl, timelines) {
  const wrap = document.createElement('div');
  wrap.className = 'timeline-histograms';
  const colors = resolveColors(rootEl);
  const statusCounts = countByStatus(timelines);

  // Each stage's "currently in this state" count, read off the same status
  // counts the table's badges use — see assetStatus in timeline-model.js.
  const liveCountByStage = { acquisition: null, upload: statusCounts.uploading,
    processing: statusCounts.processing, release: statusCounts['pending-release'] };

  // Two series per stage: assets that finished it (final duration) and assets
  // still in it (elapsed so far). Showing only one of the two is what made the
  // panels misleading — a stage can look fast simply because everything slow is
  // still stuck in it and therefore has no completed duration to plot.
  const finite = (h) => h != null && Number.isFinite(h);
  const hoursByStage = PIPELINE_STAGES.map((stage) => ({
    stage,
    done: timelines
      .map((t) => t.segments.find((s) => s.stage === stage.key)?.hours)
      .filter(finite),
    pending: timelines
      .map((t) => (t.pending?.stage === stage.key ? t.pending.hours : null))
      .filter(finite),
  }));

  const binWidth = HIST_MAX_HOURS / HIST_BIN_COUNT;

  for (const { stage, done, pending } of hoursByStage) {
    wrap.appendChild(buildStageHistogram(
      stage, { done, pending }, colors, { binWidth, liveCount: liveCountByStage[stage.key] },
    ));
  }
  wrap.appendChild(buildTerminalCard(statusCounts.visible, timelines.length));
  return wrap;
}

/** The pipeline's terminal state: a plain count, no histogram — nothing left to wait for. */
function buildTerminalCard(visibleCount, total) {
  const panel = document.createElement('div');
  panel.className = 'timeline-histogram-panel timeline-terminal-card';
  panel.innerHTML =
    '<div class="timeline-histogram-title">Visible in portal</div>'
    + `<div class="timeline-terminal-value">${visibleCount}</div>`
    + `<div class="timeline-histogram-stats">of ${total} acquisitions</div>`;
  return panel;
}

/**
 * One stage's histogram panel: label, live count, chart, and a median/p90/n
 * summary. Each bin holds two staggered (side-by-side, never stacked) bars —
 * completed assets in ink, still-in-this-stage assets in light red — so the
 * two counts can be read off independently instead of one hiding inside the
 * other's total.
 */
function buildStageHistogram(stage, { done, pending }, colors, { binWidth, liveCount }) {
  const panel = document.createElement('div');
  panel.className = 'timeline-histogram-panel';

  const title = document.createElement('div');
  title.className = 'timeline-histogram-title';
  title.innerHTML = escHtml(stage.label)
    + (liveCount != null ? `<span class="timeline-histogram-badge">${liveCount} now</span>` : '');
  panel.appendChild(title);

  if (!done.length && !pending.length) {
    const empty = document.createElement('p');
    empty.className = 'settings-loading-note';
    empty.textContent = 'No data in this window.';
    panel.appendChild(empty);
    return panel;
  }

  // Anything at or past the fixed range folds into the last bin rather than
  // being dropped — a stage with a long tail still accounts for every asset,
  // it just can't be resolved past HIST_MAX_HOURS on this shared scale.
  // Each bin is split in half: the completed series occupies the left half and
  // the still-pending series the right half, so the two are adjacent rather
  // than summed. Empty bars are dropped so hover only hits real bins.
  const seriesBins = (hours, side, fill, seriesLabel) => {
    const counts = new Array(HIST_BIN_COUNT).fill(0);
    for (const h of hours) {
      const i = Math.min(HIST_BIN_COUNT - 1, Math.floor(h / binWidth));
      counts[i] += 1;
    }
    const overflows = hours.some((h) => h >= HIST_MAX_HOURS);
    return counts.flatMap((count, i) => {
      if (!count) return [];
      const lo = i * binWidth;
      const hi = (i + 1) * binWidth;
      const mid = lo + binWidth / 2;
      return [{
        x1: side === 'left' ? lo : mid,
        x2: side === 'left' ? mid : hi,
        binLo: lo,
        binHi: hi,
        count,
        seriesLabel,
        fill,
        isOverflowBin: i === HIST_BIN_COUNT - 1 && overflows,
      }];
    });
  };

  const bins = [
    ...seriesBins(done, 'left', colors.done, 'made it through'),
    ...seriesBins(pending, 'right', colors.pending, 'still in this stage'),
  ];

  const plot = Plot.plot({
    // A fixed base size for Plot's own scale math; the SVG is then stretched
    // via CSS (viewBox scaling preserves the aspect ratio) so the four panels
    // fill whatever width the row actually has instead of a fixed pixel size.
    width: 260,
    height: 190,
    marginLeft: 34,
    marginRight: 6,
    marginTop: 20,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: '10px' },
    // Bar colours are pre-resolved literal CSS colours, not a category to scale.
    color: { type: 'identity' },
    // Fixed across every panel — see HIST_MAX_HOURS.
    x: { label: 'Hours →', domain: [0, HIST_MAX_HOURS] },
    y: { label: '↑ Assets', grid: true },
    marks: [
      Plot.rectY(bins, {
        x1: 'x1',
        x2: 'x2',
        y: 'count',
        fill: 'fill',
        // Hover shows both halves of a bin together: how long ("time in bin")
        // and how many ("# in bin") — the histogram bar is the third piece.
        title: (d) => `${d.isOverflowBin ? `${formatDuration(d.binLo)}+` : `${formatDuration(d.binLo)}–${formatDuration(d.binHi)}`}: `
          + `${d.count} asset${d.count === 1 ? '' : 's'} ${d.seriesLabel}`,
      }),
      Plot.ruleY([0]),
    ],
  });
  plot.style.width = '100%';
  plot.style.height = 'auto';
  panel.appendChild(plot);

  const legend = document.createElement('div');
  legend.className = 'timeline-histogram-legend';
  legend.innerHTML =
    `<span><span class="timeline-swatch" style="background:${colors.done}" aria-hidden="true"></span>`
    + `through (${done.length})</span>`
    + `<span><span class="timeline-swatch" style="background:${colors.pending}" aria-hidden="true"></span>`
    + `still here (${pending.length})</span>`;
  panel.appendChild(legend);

  // Stats describe the completed durations only — a median over elapsed-so-far
  // times would drift upward every minute the page stays open.
  const stats = document.createElement('div');
  stats.className = 'timeline-histogram-stats';
  stats.textContent = done.length
    ? `median ${formatDuration(median(done))} `
      + `[${formatDuration(percentile(done, 0.05))}, ${formatDuration(percentile(done, 0.95))}] · n=${done.length}`
    : 'no completed durations yet in this window';
  panel.appendChild(stats);

  return panel;
}

/** Milestone table with exact timestamps, expandable per row. */
function buildTable(coord, timelines) {
  const table = document.createElement('table');
  table.className = 'assets-table timeline-table';
  table.innerHTML =
    '<thead><tr>'
    + '<th>Asset name</th><th>Subject</th><th>Acquired</th><th>Upload Δ</th>'
    + '<th>Processing Δ</th><th>Release Δ</th><th>Total</th><th>Status</th>'
    + '</tr></thead>';
  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  const ts = (ms) => (ms == null ? '—' : formatDatetime(new Date(ms).toISOString()));

  for (const t of timelines) {
    const m = t.milestones;
    const tr = document.createElement('tr');
    tr.className = 'timeline-row';
    tr.innerHTML =
      `<td class="ops-asset">${escHtml(t.name)}</td>`
      + `<td>${escHtml(t.subjectId ?? '—')}</td>`
      + `<td>${escHtml(ts(m.acqStart))}</td>`
      // Each later column is the delta from the previous milestone (incremental
      // stage time), not from acquisition start — see formatOffset.
      + `<td>${escHtml(formatOffset(m.acqEnd, m.uploaded))}</td>`
      + `<td>${escHtml(formatOffset(m.uploaded, m.processed))}</td>`
      + `<td>${escHtml(formatOffset(m.processed, m.visible))}</td>`
      + `<td>${escHtml(formatDuration(t.totalHours))}</td>`
      + `<td><span class="timeline-badge timeline-status-${t.status}">`
      + `${escHtml(STATUS_LABELS[t.status])}</span></td>`;

    const detailRow = document.createElement('tr');
    detailRow.className = 'timeline-detail-row';
    detailRow.hidden = true;
    const detailCell = document.createElement('td');
    detailCell.colSpan = 8;
    detailRow.appendChild(detailCell);

    let loaded = false;
    tr.addEventListener('click', () => {
      detailRow.hidden = !detailRow.hidden;
      tr.classList.toggle('is-open', !detailRow.hidden);
      if (!detailRow.hidden && !loaded) {
        loaded = true;
        renderRowDetail(coord, t, detailCell);
      }
    });

    tbody.append(tr, detailRow);
  }
  return table;
}

/**
 * Per-row detail: the stage breakdown, plus fiber photometry pipeline steps when
 * the acquisition has an operations partition. The operations table is
 * partitioned per asset, so only this asset's partition is read.
 */
async function renderRowDetail(coord, timeline, cell) {
  // Swatches carry the same two-state encoding as the histograms: ink for a
  // stage this asset finished, light red for the one it is still sitting in.
  const stageList = PIPELINE_STAGES.map((stage) => {
    const seg = timeline.segments.find((s) => s.stage === stage.key);
    const isPending = timeline.pending?.stage === stage.key;
    const swatchVar = isPending ? '--timeline-pending' : '--timeline-done';
    return `<li><span class="timeline-swatch" style="background:var(${swatchVar})"`
      + ` aria-hidden="true"></span>${escHtml(stage.label)}: `
      + `<strong>${escHtml(formatDuration(seg?.hours ?? (isPending ? timeline.pending.hours : null)))}</strong>`
      + (isPending ? ' <span class="timeline-detail-pending">so far</span>' : '')
      + '</li>';
  }).join('');

  cell.innerHTML =
    `<div class="timeline-detail"><ul class="timeline-detail-stages">${stageList}</ul>`
    + (timeline.derivedName
      ? `<div class="timeline-detail-meta">Derived asset: <code>${escHtml(timeline.derivedName)}</code></div>`
      : '<div class="timeline-detail-meta">No derived asset found for this acquisition.</div>')
    + '<div class="timeline-detail-ops"></div></div>';

  const opsEl = cell.querySelector('.timeline-detail-ops');
  if (!timeline.modalities.includes('fib')) return;

  opsEl.textContent = 'Loading pipeline steps…';
  try {
    const url =
      `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/`
      + `data-asset-cache/${getResolvedVersion()}/platform_fib_operations/`
      + `asset_name=${encodeURIComponent(timeline.name)}/data.pqt`;
    const rows = await queryRows(coord, `
      SELECT process_name,
             MIN(timestamp) AS first_ts,
             MAX(timestamp) AS last_ts,
             arg_max(event_type, timestamp) AS last_event
      FROM read_parquet('${esc(url)}')
      GROUP BY process_name
      ORDER BY first_ts
    `);
    if (!rows.length) {
      opsEl.textContent = 'No pipeline steps recorded for this acquisition.';
      return;
    }
    opsEl.innerHTML =
      '<div class="ops-steps">'
      + rows.map((r, i) => {
        const st = r.last_event === 'stage_complete' ? 'done'
          : r.last_event === 'stage_error' ? 'error' : 'running';
        const label = String(r.process_name ?? '').replace(/^aind-/, '');
        return `<span class="ops-step ops-step-${st}">`
          + `<span class="ops-step-name"><span class="ops-step-num">${i + 1}</span>`
          + `${escHtml(label)}</span>`
          + `<span class="ops-step-time">${escHtml(r.last_ts ? formatDatetime(r.last_ts) : '')}</span>`
          + '</span>';
      }).join('')
      + '</div>';
  } catch {
    // A missing partition is the normal case for an acquisition the pipeline
    // never ran on — not worth an error box.
    opsEl.textContent = 'No pipeline step detail available for this acquisition.';
  }
}

function exportCsv(state) {
  const rows = visibleTimelines(state);
  const iso = (ms) => (ms == null ? '' : new Date(ms).toISOString());
  downloadCsv(
    'asset-timeline.csv',
    ['name', 'subject_id', 'project_name', 'modalities', 'acquisition_start',
      'acquisition_end', 'uploaded', 'processed', 'portal_visible', 'total_hours', 'status'],
    rows.map((t) => [
      t.name,
      t.subjectId ?? '',
      t.projectName ?? '',
      t.modalities.join(' '),
      iso(t.milestones.acqStart),
      iso(t.milestones.acqEnd),
      iso(t.milestones.uploaded),
      iso(t.milestones.processed),
      iso(t.milestones.visible),
      t.totalHours == null ? '' : t.totalHours.toFixed(2),
      t.status,
    ]),
  );
}

/**
 * dynamic-foraging-multi.js — the dynamic-foraging provider for the
 * multi-session harness (lib/behaviors/multi-session.js).
 *
 * Shown in place of the per-session Event Details when the user selects a
 * range (shift+click) or a scatter (ctrl/cmd+click) of foraging acquisitions.
 * It answers what the single-session view cannot: how did this animal change
 * across these sessions?
 *
 *   1. Across sessions — one small chart per session-level metric (foraging
 *      efficiency, finished trials, finished rate, naive bias) over the
 *      session dates, plus the same numbers as a table. Separate charts rather
 *      than one dual-axis chart.
 *   2. Session figures — the *same* interactive figure the single-session
 *      player draws (`createProbPlot`), one per session, oldest first. Sessions
 *      load one at a time so the first figure appears without waiting on the
 *      rest.
 *   3. Fiber photometry — when these acquisitions carry fib data, one
 *      event-aligned ΔF/F trace per session on shared axes, reusing the
 *      single-session PSTH pipeline (`loadFibSessionPsth`).
 *   4. Choice history — the pre-rendered upstream PNG per session, collapsed;
 *      it duplicates §2 but carries the upstream annotation.
 *
 * Metrics come from one `platform_dynamic_foraging_sessions` query covering
 * every selected date (the harness's shared `enrich` pass).
 */

import * as Plot from '@observablehq/plot';
import { AIND_COLORS } from '../../constants.js';
import { escHtml } from '../utils.js';
import {
  buildChoiceHistoryUrl,
  extractForagingSessionInfo,
  isForagingAcquisition,
} from './dynamic-foraging.js';
import { queryForagingSessionsByDates } from './foraging-metadata.js';
import { baselineSeries, buildPsthPlot, createBaselineControls } from '../psth.js';

/** Session-level metrics plotted across the selection, in display order. */
export const FORAGING_METRICS = [
  { key: 'foraging_eff',    label: 'Foraging efficiency', digits: 3 },
  { key: 'finished_trials', label: 'Finished trials',     digits: 0 },
  { key: 'finished_rate',   label: 'Finished rate',       digits: 3 },
  { key: 'bias_naive',      label: 'Bias (naive)',        digits: 3 },
];

const PSTH_PRE = -2;
const PSTH_POST = 5;

// Session traces are ordered, not categorical, so they take a single-hue ramp
// rather than cycled hues. Each theme gets its own endpoints: one band cannot
// clear 3:1 against both a white and a near-black surface.
const SESSION_RAMP_LIGHT = ['#3aa76d', '#08331d'];
const SESSION_RAMP_DARK = ['#1d8649', '#bdf0d2'];

// ---------------------------------------------------------------------------
// Pure helpers (Node-testable)
// ---------------------------------------------------------------------------

/**
 * Map one timeline event to a foraging session descriptor, or null.
 *
 * @param {object} event - Subject-timeline event.
 * @returns {{subject_id: string, session_date: string, nwb_suffix: string,
 *   assetName: string, modalities: string[]}|null}
 */
export function matchForagingSession(event) {
  if (!isForagingAcquisition(event)) return null;
  const info = extractForagingSessionInfo(event);
  if (!info) return null;
  return {
    ...info,
    assetName: event.data?._assetName ?? event.event ?? '',
    modalities: event.modalities ?? [],
  };
}

/**
 * Reduce a cached `session_date` to a `YYYY-MM-DD` key.
 *
 * The column is not a string everywhere in the cache: Arrow surfaces a DATE as
 * a `Date`, and a day/millisecond number depending on its width, so a plain
 * `String()` would never match the date parsed out of an asset name. The
 * `session_date_iso` cast from the query is preferred when present.
 *
 * @param {object} row - One platform_dynamic_foraging_sessions row.
 * @returns {string} ISO date, or '' when the row carries no usable date.
 */
export function rowSessionDate(row) {
  const raw = row?.session_date_iso ?? row?.session_date;
  if (raw == null) return '';
  if (typeof raw === 'string') return raw.slice(0, 10);
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? '' : raw.toISOString().slice(0, 10);
  }
  if (typeof raw === 'number' || typeof raw === 'bigint') {
    const num = Number(raw);
    if (!Number.isFinite(num)) return '';
    // Arrow DATE32 counts days since the epoch; anything larger is milliseconds.
    const ms = Math.abs(num) < 1e6 ? num * 86_400_000 : num;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
  return String(raw).slice(0, 10);
}

/**
 * Attach each session's metadata row, matching on date + nwb_suffix and falling
 * back to the date alone (older cache rows carry a normalized suffix that no
 * longer matches the asset name's start time).
 *
 * @param {Array<object>} sessions
 * @param {Array<object>} rows - Rows from platform_dynamic_foraging_sessions.
 * @returns {Array<object>} sessions with a `meta` field (row or null).
 */
export function joinSessionMetadata(sessions, rows) {
  const byDateAndSuffix = new Map();
  const byDate = new Map();
  for (const row of rows ?? []) {
    const date = rowSessionDate(row);
    const suffix = row.nwb_suffix == null ? '' : String(row.nwb_suffix);
    byDateAndSuffix.set(`${date}|${suffix}`, row);
    if (!byDate.has(date)) byDate.set(date, row);
  }
  return sessions.map((s) => ({
    ...s,
    meta: byDateAndSuffix.get(`${s.session_date}|${s.nwb_suffix}`)
      ?? byDate.get(s.session_date)
      ?? null,
  }));
}

/**
 * Build the {date, value} series for one metric, dropping sessions whose value
 * is missing or non-numeric.
 *
 * @param {Array<object>} joined - Sessions carrying `meta`.
 * @param {string} metricKey
 * @returns {Array<{date: Date, value: number, label: string}>}
 */
export function buildMetricSeries(joined, metricKey) {
  const series = [];
  for (const s of joined ?? []) {
    const raw = s.meta?.[metricKey];
    const value = raw == null ? NaN : Number(raw);
    if (!Number.isFinite(value)) continue;
    const date = new Date(`${s.session_date}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) continue;
    series.push({ date, value, label: s.session_date });
  }
  return series;
}

/**
 * Interpolate `n` colors across a two-stop ramp, in sRGB.
 *
 * @param {number} n
 * @param {[string, string]} [ramp] - Hex endpoints; defaults to the current theme's.
 * @returns {string[]}
 */
export function sessionColors(n, ramp = themeRamp()) {
  const [from, to] = ramp.map(hexToRgb);
  if (n <= 1) return [rgbToHex(from)];
  return Array.from({ length: n }, (_, i) => {
    const f = i / (n - 1);
    return rgbToHex(from.map((c, k) => Math.round(c + (to[k] - c) * f)));
  });
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
}

function themeRamp() {
  const attr = document.documentElement.getAttribute('data-theme');
  const dark = attr === 'dark'
    || (attr !== 'light' && (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false));
  return dark ? SESSION_RAMP_DARK : SESSION_RAMP_LIGHT;
}

function fmtMetric(value, digits) {
  if (value == null) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return num.toFixed(digits);
}

function placeholder(text) {
  const el = document.createElement('p');
  el.className = 'detail-placeholder';
  el.textContent = text;
  return el;
}

/** Canonical session start time: the cache's suffix wins over the asset name's. */
function sessionSuffix(session) {
  return session.meta?.nwb_suffix ?? session.nwb_suffix;
}

// ---------------------------------------------------------------------------
// Section 1 — metric trends + table
// ---------------------------------------------------------------------------

function buildMetricChart(series, metric, width) {
  return Plot.plot({
    width,
    height: 150,
    marginLeft: 46,
    marginRight: 12,
    marginTop: 10,
    marginBottom: 28,
    style: {
      background: 'transparent',
      fontFamily: 'inherit',
      fontSize: 10,
      color: 'var(--text-primary, #111111)',
    },
    x: { label: null, ticks: Math.min(series.length, 5), tickFormat: '%b %-d' },
    y: { label: metric.label, grid: true, nice: true },
    marks: [
      Plot.line(series, { x: 'date', y: 'value', stroke: AIND_COLORS.green, strokeWidth: 2 }),
      Plot.dot(series, {
        x: 'date',
        y: 'value',
        fill: AIND_COLORS.green,
        stroke: 'var(--surface-bg, #ffffff)',
        strokeWidth: 2,
        r: 4,
        tip: true,
        title: (d) => `${d.label}\n${metric.label}: ${fmtMetric(d.value, metric.digits)}`,
      }),
    ],
  });
}

function buildTrendsSection(joined) {
  const wrap = document.createElement('div');
  wrap.className = 'df-multi-trends';

  let plotted = 0;
  for (const metric of FORAGING_METRICS) {
    const series = buildMetricSeries(joined, metric.key);
    if (series.length < 2) continue; // a single point is not a trend
    const cell = document.createElement('div');
    cell.className = 'df-multi-trend-cell';
    cell.appendChild(buildMetricChart(series, metric, 300));
    wrap.appendChild(cell);
    plotted += 1;
  }

  if (!plotted) {
    const matched = joined.filter((s) => s.meta).length;
    wrap.className = 'detail-placeholder';
    // Say which half failed: no cache row at all, or rows without metrics.
    wrap.textContent = matched
      ? 'The selected sessions carry no comparable metrics in the foraging cache.'
      : 'No foraging cache rows found for the selected session dates.';
  }
  return wrap;
}

function buildSessionTable(joined) {
  const head = [
    '<th>Date</th>',
    '<th>Stage</th>',
    '<th>Task</th>',
    ...FORAGING_METRICS.map((m) => `<th>${escHtml(m.label)}</th>`),
  ].join('');

  const body = joined.map((s) => {
    const meta = s.meta ?? {};
    const cells = FORAGING_METRICS
      .map((m) => `<td>${escHtml(fmtMetric(meta[m.key], m.digits))}</td>`)
      .join('');
    return `<tr>
      <td>${escHtml(s.session_date)}</td>
      <td>${escHtml(meta.current_stage_actual ?? '—')}</td>
      <td>${escHtml(meta.task ?? '—')}</td>
      ${cells}
    </tr>`;
  }).join('');

  const wrap = document.createElement('div');
  wrap.className = 'df-multi-table-wrap';
  wrap.innerHTML = `<table class="detail-table df-multi-table">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
  return wrap;
}

function buildMetricsSection(sessions) {
  const wrap = document.createElement('div');
  wrap.append(buildTrendsSection(sessions), buildSessionTable(sessions));
  return wrap;
}

// ---------------------------------------------------------------------------
// Section 2 — the full session figure, one per session
// ---------------------------------------------------------------------------

function buildSessionPlotsSection(sessions, context = {}) {
  const coordinator = context.coordinator ?? null;
  if (!coordinator) return placeholder('No data connection available.');

  const wrap = document.createElement('div');
  wrap.className = 'df-multi-plots';

  const cards = sessions.map((session, index) => {
    const card = document.createElement('div');
    card.className = 'df-multi-plot-card';
    // Sessions run left to right, one boxed column each. Only the leftmost
    // carries the row-label gutter — the rows align across columns, so one
    // set of labels reads for all of them, and the extra width it needs is
    // added back here so every session gets the same plotting area.
    if (index === 0) card.classList.add('df-multi-plot-card--labelled');

    const caption = document.createElement('div');
    caption.className = 'df-multi-figure-caption';
    const stage = session.meta?.current_stage_actual;
    caption.textContent = stage ? `${session.session_date} · ${stage}` : session.session_date;

    const body = document.createElement('div');
    body.className = 'df-multi-plot-body';
    body.appendChild(placeholder('Queued…'));

    card.append(caption, body);
    wrap.appendChild(card);
    return { session, body, showRowLabels: index === 0 };
  });

  // One session at a time: every session reads the same two per-subject
  // parquets, so serial loads warm DuckDB's range cache instead of racing for
  // it, and the first figure appears without waiting on the rest.
  const disposers = [];
  (async () => {
    const { loadDfSession } = await import('../../dynamic_foraging/data-loader.js');
    const { createProbPlot } = await import('../../dynamic_foraging/prob-plot.js');
    for (const { session, body, showRowLabels } of cards) {
      if (context.signal?.aborted) return;
      body.replaceChildren(placeholder('Loading session…'));
      try {
        const data = await loadDfSession(coordinator, {
          subjectId: session.subject_id,
          sessionDate: session.session_date,
          nwbSuffix: sessionSuffix(session),
          signal: context.signal,
        });
        if (context.signal?.aborted) return;
        const plot = createProbPlot(data, { showRowLabels });
        disposers.push(plot.dispose);
        body.replaceChildren(plot.element);
      } catch (err) {
        if (context.signal?.aborted) return;
        console.warn('[DFMulti] session figure failed for', session.assetName, err);
        body.replaceChildren(placeholder('Session data not available in the foraging cache.'));
      }
    }
  })();

  // The harness replaces sections wholesale; give the caller a way to release
  // the brush/resize listeners each figure installs.
  wrap._dispose = () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch { /* already gone */ }
    }
    disposers.length = 0;
  };
  return wrap;
}

// ---------------------------------------------------------------------------
// Section 3 — fiber photometry across sessions
// ---------------------------------------------------------------------------

function hasFiberModality(session) {
  return (session.modalities ?? []).some((m) => /^fib/i.test(String(m)));
}

/**
 * Fiber photometry across sessions.
 *
 * Two layouts, because two different questions get asked:
 *   Columns — the single-session panel's per-fiber cards, one boxed column per
 *     session, laid out like the behavior figures. Every fiber and channel
 *     stays visible and sessions are read side by side against one shared
 *     y-axis.
 *   Overlay — one trace per session on shared axes, first fiber and channel
 *     only. Better for seeing drift across many sessions at once.
 *
 * The implant belongs to the subject rather than the session, so one implant
 * view sits beside the columns instead of repeating in each.
 */
function buildFiberSection(sessions, context = {}) {
  const coordinator = context.coordinator ?? null;
  const fibSessions = sessions.filter(hasFiberModality);
  // Nothing to say when these acquisitions carry no fiber data.
  if (!coordinator || fibSessions.length < 2) return null;

  const subjectId = context.subjectId ?? fibSessions[0].subject_id;

  const wrap = document.createElement('div');
  wrap.className = 'df-multi-fib';

  // ── Controls ──────────────────────────────────────────────────────────────
  const controls = document.createElement('div');
  controls.className = 'df-multi-fib-controls';

  const eventSel = document.createElement('select');
  eventSel.className = 'project-filter-select';
  eventSel.innerHTML = '<option value="">Loading events…</option>';
  const eventLabel = document.createElement('label');
  eventLabel.textContent = 'Align to ';
  eventLabel.appendChild(eventSel);

  const layoutSel = document.createElement('select');
  layoutSel.className = 'project-filter-select';
  for (const [value, text] of [['columns', 'Columns'], ['overlay', 'Overlay']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    layoutSel.appendChild(opt);
  }
  const layoutLabel = document.createElement('label');
  layoutLabel.textContent = 'Layout ';
  layoutLabel.appendChild(layoutSel);

  const baseline = createBaselineControls({ defaultOn: true, onChange: () => render() });

  controls.append(eventLabel, layoutLabel, baseline.element);

  const status = document.createElement('div');
  status.className = 'df-multi-fib-status';

  // ── Body: implant beside a horizontally-scrolled strip of session columns ──
  const body = document.createElement('div');
  body.className = 'df-multi-fib-body';

  const implantCol = document.createElement('div');
  implantCol.className = 'df-multi-fib-implant';
  const implantHeading = document.createElement('div');
  implantHeading.className = 'df-multi-figure-caption';
  implantHeading.textContent = 'Implant';
  implantCol.appendChild(implantHeading);

  const strip = document.createElement('div');
  strip.className = 'df-multi-fib-strip';

  body.append(implantCol, strip);
  wrap.append(controls, status, body);

  // [{ session_date, set }] — set is null for a session with no fiber traces.
  let loaded = [];
  let api = null;
  let generation = 0;

  function renderColumns() {
    const usable = loaded.filter((entry) => entry.set?.fibers?.length);
    if (!usable.length) {
      strip.replaceChildren(placeholder('No fiber traces available for these sessions.'));
      return;
    }
    // One y-axis across every fiber of every session, or the columns lie.
    const yDomain = api.fibPsthYDomain(usable.flatMap((e) => e.set.fibers.map((f) => f.series)));
    const baselineSec = baseline.getBaselineSec();

    strip.replaceChildren();
    for (const entry of usable) {
      const column = document.createElement('div');
      column.className = 'df-multi-fib-col';

      const caption = document.createElement('div');
      caption.className = 'df-multi-figure-caption';
      caption.textContent = entry.session_date;
      column.appendChild(caption);

      for (const fiberEntry of entry.set.fibers) {
        column.appendChild(api.buildFibPsthCard(fiberEntry, {
          yDomain,
          width: 300,
          baselineSec,
          pre: PSTH_PRE,
          post: PSTH_POST,
        }));
      }
      strip.appendChild(column);
    }
  }

  function renderOverlay() {
    const usable = loaded.filter((entry) => entry.set?.fibers?.length);
    if (!usable.length) {
      strip.replaceChildren(placeholder('No fiber traces available for these sessions.'));
      return;
    }
    // One fiber and one channel, so the session traces are comparable.
    const first = usable[0].set.fibers[0];
    const channel = first.series.channels?.[0] ?? null;
    const dates = usable.map((entry) => entry.session_date);
    const series = baselineSeries(
      usable.flatMap((entry) => (entry.set.fibers[0]?.series.allMean ?? [])
        .filter((d) => d.channel === channel)
        .map((d) => ({ t: d.t, mean: d.mean, session: entry.session_date }))),
      baseline.getBaselineSec(),
      { colorKey: 'session' },
    );
    strip.replaceChildren(buildPsthPlot(series, {
      pre: PSTH_PRE,
      post: PSTH_POST,
      width: Math.max(320, Math.floor(strip.clientWidth) - 8),
      height: 300,
      marginLeft: 60,
      xLabel: `Time rel. ${eventSel.selectedOptions[0]?.textContent ?? 'event'} (s)`,
      yLabel: `Mean ΔF/F — fiber ${first.fiber}${channel ? ` (${channel})` : ''}`,
      colorKey: 'session',
      colorDomain: dates,
      colorRange: sessionColors(dates.length),
      colorLegend: true,
      showArea: false,
      baselineSec: baseline.getBaselineSec(),
    }));
  }

  function render() {
    if (!loaded.length) return;
    if (layoutSel.value === 'overlay') renderOverlay();
    else renderColumns();
  }

  async function load() {
    const gen = ++generation;
    api = api ?? await import('../../fiber_photometry/fib-playback.js');
    if (context.signal?.aborted || gen !== generation) return;

    // The implant is subject-level: load it once, not on every event change.
    if (!implantCol.querySelector('.fib-3d-inset')) {
      implantCol.appendChild(api.createFibImplantPanel(String(subjectId)));
    }

    if (!eventSel.value) {
      const streams = await api.listFibEventStreams(coordinator, {
        subjectId,
        rawAssetName: fibSessions[0].assetName,
        platform: 'dynamic_foraging',
        signal: context.signal,
      });
      if (context.signal?.aborted || gen !== generation) return;
      if (!streams.length) {
        status.textContent = '';
        strip.replaceChildren(placeholder('No behavior events found to align these sessions on.'));
        return;
      }
      eventSel.replaceChildren(...streams.map(({ key, label }) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = label;
        return opt;
      }));
      // Go cue is the conventional foraging alignment when it exists.
      eventSel.value = streams.find((s) => s.key === 'go_cue')?.key ?? streams[0].key;
    }

    loaded = [];
    strip.replaceChildren(placeholder('Loading fiber traces…'));

    let done = 0;
    for (const session of fibSessions) {
      if (context.signal?.aborted || gen !== generation) return;
      status.textContent = `Loading fiber traces… ${done}/${fibSessions.length} sessions`;
      let set = null;
      try {
        set = await api.loadFibSessionPsthSet(coordinator, {
          subjectId,
          rawAssetName: session.assetName,
          eventKey: eventSel.value,
          platform: 'dynamic_foraging',
          pre: PSTH_PRE,
          post: PSTH_POST,
          signal: context.signal,
        });
      } catch (err) {
        console.warn('[DFMulti] fiber PSTH failed for', session.assetName, err);
      }
      done += 1;
      if (context.signal?.aborted || gen !== generation) return;
      loaded.push({ session_date: session.session_date, set });
      // Re-render as each session lands — the shared y-axis moves with it.
      render();
    }

    const withData = loaded.filter((entry) => entry.set?.fibers?.length).length;
    status.textContent =
      `${withData} of ${fibSessions.length} session${fibSessions.length === 1 ? '' : 's'} with fiber traces`;
  }

  eventSel.addEventListener('change', () => { load(); });
  layoutSel.addEventListener('change', render);
  load().catch((err) => {
    console.warn('[DFMulti] fiber section failed:', err);
    status.textContent = '';
    strip.replaceChildren(placeholder('Failed to load fiber photometry for these sessions.'));
  });

  return wrap;
}

// ---------------------------------------------------------------------------
// Section 4 — pre-rendered choice-history figures
// ---------------------------------------------------------------------------

function buildFigureCard(session) {
  const card = document.createElement('div');
  card.className = 'df-multi-figure';
  card.dataset.name = session.assetName ?? '';

  const caption = document.createElement('div');
  caption.className = 'df-multi-figure-caption';
  const stage = session.meta?.current_stage_actual;
  caption.textContent = stage
    ? `${session.session_date} · ${stage}`
    : session.session_date;
  card.appendChild(caption);

  const url = buildChoiceHistoryUrl(session.subject_id, session.session_date, sessionSuffix(session));

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';

  const img = document.createElement('img');
  img.src = url;
  img.className = 'df-multi-figure-img';
  img.alt = `Choice history for ${session.subject_id} on ${session.session_date}`;
  img.loading = 'lazy';
  img.onerror = () => {
    link.remove();
    card.appendChild(placeholder('Choice history plot not available for this session.'));
  };

  link.appendChild(img);
  card.appendChild(link);
  return card;
}

function buildChoiceHistorySection(sessions) {
  const details = document.createElement('details');
  details.className = 'df-multi-choice-history';
  const summary = document.createElement('summary');
  summary.textContent = `Pre-rendered figures (${sessions.length})`;
  details.appendChild(summary);

  const figures = document.createElement('div');
  figures.className = 'df-multi-figures';
  // Images load only once the block is opened.
  details.addEventListener('toggle', () => {
    if (!details.open || figures.childElementCount) return;
    for (const session of sessions) figures.appendChild(buildFigureCard(session));
  }, { once: false });
  details.appendChild(figures);
  return details;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const dynamicForagingProvider = {
  key: 'dynamic_foraging',
  label: 'dynamic foraging',
  matchSession: matchForagingSession,

  async enrich(sessions, context = {}) {
    const coordinator = context.coordinator ?? null;
    if (!coordinator) return sessions.map((s) => ({ ...s, meta: null }));
    const subjectId = context.subjectId ?? sessions[0]?.subject_id ?? '';
    const rows = await queryForagingSessionsByDates(
      coordinator, subjectId, sessions.map((s) => s.session_date),
    );
    const joined = joinSessionMetadata(sessions, rows);
    console.debug(
      '[DFMulti] metrics for', subjectId, '—', rows.length, 'cache rows,',
      joined.filter((s) => s.meta).length, 'of', sessions.length, 'sessions matched',
    );
    return joined;
  },

  sections: [
    { key: 'metrics', title: 'Across sessions', build: buildMetricsSection },
    { key: 'figures', title: 'Session figures', build: buildSessionPlotsSection },
    { key: 'fiber', title: 'Fiber photometry across sessions', build: buildFiberSection },
    { key: 'choice-history', title: 'Choice history', build: buildChoiceHistorySection },
  ],
};

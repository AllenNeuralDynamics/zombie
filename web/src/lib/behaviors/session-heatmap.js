/**
 * session-heatmap.js — "many sessions, one signal" aggregate view.
 *
 * Rows are sessions in date order, columns are time relative to the aligned
 * event, colour is the normalized response; a pooled mean ± SEM trace sits
 * below on the same time axis. This is the idiom for reading drift across a
 * run of sessions — separate per-session panels stop scaling at about three.
 *
 * Normalization is not cosmetic. Raw ΔF/F is not comparable across days
 * (bleaching, fiber coupling and expression all drift), so pooling raw traces
 * lets whichever session happened to have the largest signal dominate the
 * average. Every trace is therefore z-scored against its own pre-event
 * baseline before it is drawn or pooled; when that baseline is flat (σ ≈ 0)
 * the trace falls back to plain baseline subtraction, which is reported so the
 * caller can say so rather than showing a silently different unit.
 *
 * Nothing here is fiber- or foraging-specific: a caller supplies
 * `[{ label, points: [{t, mean}] }]` and gets the panel back, so ecephys can
 * reuse it for firing rates.
 */

import * as Plot from '@observablehq/plot';
import { buildPsthPlot } from '../psth.js';

/** Diverging scale: increases warm, decreases cool, neutral at zero. */
const HEATMAP_SCHEME = 'RdBu';

/**
 * Z-score one session's trace against its own pre-event baseline.
 *
 * @param {Array<{t: number, mean: number}>} points - Mean trace on the PSTH grid.
 * @param {object} [opts]
 * @param {number} [opts.baselineEnd=0] - End of the baseline window (seconds).
 * @returns {{points: Array<{t: number, z: number}>, scaled: boolean}} `scaled`
 *   is false when the baseline had no spread and only the mean was removed.
 */
export function zScoreSessionTrace(points, { baselineEnd = 0 } = {}) {
  const usable = (points ?? []).filter((d) => Number.isFinite(d?.t) && Number.isFinite(d?.mean));
  if (!usable.length) return { points: [], scaled: false };

  const pre = usable.filter((d) => d.t < baselineEnd);
  const base = pre.length ? pre : usable;
  const mu = base.reduce((sum, d) => sum + d.mean, 0) / base.length;
  const variance = base.length > 1
    ? base.reduce((sum, d) => sum + (d.mean - mu) ** 2, 0) / (base.length - 1)
    : 0;
  const sigma = Math.sqrt(variance);
  const scaled = sigma > 0 && Number.isFinite(sigma);

  return {
    points: usable.map((d) => ({ t: d.t, z: scaled ? (d.mean - mu) / sigma : d.mean - mu })),
    scaled,
  };
}

/**
 * Normalize every session and lay the traces out as heatmap rectangles.
 *
 * Row 0 is the oldest session, so time runs down the page as it runs left to
 * right everywhere else in the view.
 *
 * @param {Array<{label: string, points: Array<{t: number, mean: number}>}>} sessions
 * @param {object} [opts]
 * @param {number} [opts.baselineEnd=0]
 * @returns {{rects: Array<object>, labels: string[], allScaled: boolean}}
 */
export function buildHeatmapRects(sessions, { baselineEnd = 0 } = {}) {
  const rects = [];
  const labels = [];
  let allScaled = true;

  (sessions ?? []).forEach((session) => {
    const { points, scaled } = zScoreSessionTrace(session.points, { baselineEnd });
    if (!points.length) return;
    if (!scaled) allScaled = false;
    const row = labels.length;
    labels.push(session.label);

    // Each sample paints the slice up to the next one; the last reuses the
    // previous step so the row ends flush instead of with a gap.
    for (let i = 0; i < points.length; i++) {
      const t = points[i].t;
      const next = points[i + 1]?.t;
      const prev = points[i - 1]?.t;
      const step = (next != null ? next - t : (prev != null ? t - prev : 0)) || 0;
      rects.push({
        session: session.label,
        t,
        t0: t,
        t1: t + step,
        y0: row,
        y1: row + 1,
        z: points[i].z,
      });
    }
  });

  return { rects, labels, allScaled };
}

/**
 * Pool normalized traces across sessions: mean ± SEM at each time point.
 *
 * @param {Array<object>} rects - From buildHeatmapRects().
 * @returns {Array<{t: number, mean: number, lo: number, hi: number, n: number}>}
 */
export function poolHeatmapRects(rects) {
  const byTime = new Map();
  for (const rect of rects ?? []) {
    if (!Number.isFinite(rect?.t) || !Number.isFinite(rect?.z)) continue;
    if (!byTime.has(rect.t)) byTime.set(rect.t, []);
    byTime.get(rect.t).push(rect.z);
  }

  const pooled = [];
  for (const [t, values] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    let sem = 0;
    if (values.length > 1) {
      const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
      sem = Math.sqrt(variance / values.length);
    }
    pooled.push({ t, mean, lo: mean - sem, hi: mean + sem, n: values.length });
  }
  return pooled;
}

/** Symmetric colour domain, so zero sits at the neutral midpoint. */
function divergingDomain(rects) {
  let max = 0;
  for (const rect of rects) {
    const abs = Math.abs(rect.z);
    if (Number.isFinite(abs) && abs > max) max = abs;
  }
  return max > 0 ? [-max, max] : [-1, 1];
}

function buildHeatmapPlot(rects, labels, {
  pre, post, width, rowHeight, xLabel, colorLabel,
}) {
  const domain = divergingDomain(rects);
  return Plot.plot({
    width,
    height: Math.max(90, labels.length * rowHeight + 54),
    marginLeft: 92,
    marginRight: 12,
    marginTop: 8,
    marginBottom: 30,
    style: {
      background: 'transparent',
      fontFamily: 'inherit',
      fontSize: 10,
      color: 'var(--text-primary, #111111)',
    },
    x: { domain: [pre, post], label: xLabel },
    y: {
      // Oldest session on top; ticks sit mid-row and name the session.
      domain: [labels.length, 0],
      ticks: labels.map((_, i) => i + 0.5),
      tickFormat: (v) => labels[Math.floor(v)] ?? '',
      label: null,
    },
    color: {
      type: 'diverging',
      scheme: HEATMAP_SCHEME,
      reverse: true, // warm = increase
      domain,
      pivot: 0,
      label: colorLabel,
    },
    marks: [
      Plot.rect(rects, {
        x1: 't0', x2: 't1', y1: 'y0', y2: 'y1', fill: 'z',
        title: (d) => `${d.session}\n${d.t.toFixed(2)} s: ${d.z.toFixed(2)}`,
      }),
      Plot.ruleX([0], { stroke: 'currentColor', strokeOpacity: 0.7, strokeDasharray: '3,3' }),
    ],
  });
}

/**
 * Build the aggregate panel: a sessions × time heatmap above a pooled mean ± SEM.
 *
 * @param {Array<{label: string, points: Array<{t: number, mean: number}>}>} sessions
 * @param {object} [opts]
 * @param {number} [opts.pre] / @param {number} [opts.post] - Time window, seconds.
 * @param {number} [opts.width]
 * @param {number} [opts.rowHeight=14]
 * @param {string} [opts.xLabel]
 * @param {string} [opts.unitLabel='z-scored ΔF/F'] - What the colour and y mean.
 * @param {boolean} [opts.legend=true]
 * @returns {{element: HTMLElement, sessionCount: number, allScaled: boolean}}
 */
export function createSessionHeatmap(sessions, {
  pre = -2,
  post = 5,
  width = 420,
  rowHeight = 14,
  xLabel = 'Time rel. event (s)',
  unitLabel = 'z-scored ΔF/F',
  legend = true,
} = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'session-heatmap';

  const { rects, labels, allScaled } = buildHeatmapRects(sessions, { baselineEnd: 0 });
  if (!rects.length) {
    const empty = document.createElement('p');
    empty.className = 'detail-placeholder';
    empty.textContent = 'No traces to aggregate.';
    wrap.appendChild(empty);
    return { element: wrap, sessionCount: 0, allScaled: true };
  }

  const heatmap = buildHeatmapPlot(rects, labels, {
    pre, post, width, rowHeight, xLabel: null, colorLabel: unitLabel,
  });
  if (legend) {
    // The continuous ramp is drawn on a canvas, which not every environment
    // provides (tests, thumbnails); the panel reads fine without it.
    try {
      wrap.appendChild(heatmap.legend('color', { width: Math.min(260, width) }));
    } catch (err) {
      console.debug('[session-heatmap] colour legend unavailable:', err?.message);
    }
  }
  wrap.appendChild(heatmap);

  const pooled = poolHeatmapRects(rects);
  wrap.appendChild(buildPsthPlot(pooled, {
    pre,
    post,
    width,
    height: 150,
    marginLeft: 92,
    marginRight: 12,
    xLabel,
    yLabel: `Mean ${unitLabel}`,
    showArea: true,
    stroke: 'currentColor',
    fill: 'currentColor',
    fillOpacity: 0.15,
  }));

  return { element: wrap, sessionCount: labels.length, allScaled };
}

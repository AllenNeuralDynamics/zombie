/**
 * swdb/eye-view.js — DLC-derived eye tracking for one SWDB asset.
 *
 * The merged NWB carries `processing/behavior/eye_tracking`: ellipses fit, per
 * eye-camera frame, to three features tracked by DeepLabCut — the pupil, the eye
 * outline and the corneal reflection. That is ~460k frames per session, so the
 * traces are decimated for display and the raw frames are never all shipped: the
 * cache table is read one column group at a time (parquet column pruning), and
 * only the pupil/eye/CR centres and areas are requested.
 *
 * Two views of the same data: time-series traces (pupil area and gaze position over
 * the session) and a gaze scatter (pupil centre relative to the eye centre), which
 * is what reveals eye-movement structure that traces flatten out.
 */

import * as Plot from '@observablehq/plot';
import { loadEye } from './data.js';

/** Columns needed for both panels — one read serves the whole view. */
const EYE_COLUMNS = [
  'timestamps',
  'pupil_area',
  'pupil_center_x',
  'pupil_center_y',
  'pupil_is_bad_frame',
  'eye_center_x',
  'eye_center_y',
];

/** Target number of points per trace; ~460k frames cannot be drawn usefully. */
const MAX_POINTS = 3000;

/**
 * Decimate rows to at most `maxPoints` by uniform stride.
 *
 * Stride sampling (rather than averaging) is deliberate: pupil area contains
 * blink artefacts, and averaging across a blink boundary invents values that were
 * never measured.
 *
 * @param {object[]} rows
 * @param {number} [maxPoints]
 * @returns {object[]}
 */
export function decimate(rows, maxPoints = MAX_POINTS) {
  if (rows.length <= maxPoints) return rows;
  const stride = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += stride) out.push(rows[i]);
  return out;
}

/**
 * Drop frames whose pupil fit failed, and convert to plain numbers.
 *
 * @param {object[]} rows
 * @param {number} t0 - Session-clock time to subtract, aligning with the player.
 * @returns {object[]}
 */
export function cleanEyeRows(rows, t0 = 0) {
  // `Number(null)` is 0, so nullish fields are rejected before coercion — a missing
  // pupil area must not be plotted as a real measurement of zero.
  const num = (v) => (v == null ? NaN : Number(v));

  const out = [];
  for (const row of rows) {
    if (row.pupil_is_bad_frame) continue;
    const t = num(row.timestamps) - t0;
    const area = num(row.pupil_area);
    if (!Number.isFinite(t) || !Number.isFinite(area)) continue;
    out.push({
      t,
      pupil_area: area,
      // Gaze is the pupil centre relative to the eye centre, so head/camera offset
      // between sessions doesn't shift the scatter.
      gaze_x: num(row.pupil_center_x) - num(row.eye_center_x),
      gaze_y: num(row.pupil_center_y) - num(row.eye_center_y),
    });
  }
  return out;
}

/**
 * Build the eye-tracking panel for one SWDB asset.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {string} assetName
 * @param {object} [opts]
 * @param {number} [opts.t0] - Session-clock offset so times match the behavior player.
 * @returns {HTMLElement}
 */
export function createSwdbEyeView(coord, assetName, opts = {}) {
  const root = document.createElement('section');
  root.className = 'swdb-eye';
  root.innerHTML = '<div class="swdb-panel-status">Loading eye tracking…</div>';

  const ctrl = new AbortController();

  (async () => {
    try {
      const raw = await loadEye(coord, assetName, EYE_COLUMNS);
      if (ctrl.signal.aborted) return;

      const clean = cleanEyeRows(raw, opts.t0 ?? 0);
      const rows = decimate(clean);
      if (rows.length === 0) {
        root.innerHTML = '<div class="swdb-panel-status">No usable eye-tracking frames.</div>';
        return;
      }

      root.replaceChildren();
      root.appendChild(buildStatus(raw.length, rows.length, raw.length - clean.length));
      root.appendChild(buildTraces(rows));
      root.appendChild(buildGazeScatter(rows));
    } catch (err) {
      if (ctrl.signal.aborted) return;
      root.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'swdb-panel-status swdb-panel-status--error';
      msg.textContent = `Error loading eye tracking: ${err.message}`;
      root.appendChild(msg);
      console.error('[SWDB] eye load failed', err);
    }
  })();

  root._dispose = () => ctrl.abort();
  return root;
}

function buildStatus(nRaw, nShown, nDropped) {
  const el = document.createElement('div');
  el.className = 'swdb-panel-status';
  el.textContent =
    `${nRaw.toLocaleString()} eye-camera frames · ${nDropped.toLocaleString()} dropped as bad fits · `
    + `showing ${nShown.toLocaleString()} decimated points`;
  return el;
}

function buildTraces(rows) {
  const wrap = document.createElement('div');
  wrap.className = 'swdb-eye-traces';

  wrap.appendChild(
    Plot.plot({
      height: 150,
      marginLeft: 60,
      style: { background: 'transparent', fontFamily: 'inherit' },
      x: { label: 'time (s)' },
      y: { label: 'pupil area (px²)', grid: true },
      marks: [
        Plot.ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.2 }),
        Plot.lineY(rows, { x: 't', y: 'pupil_area', stroke: '#7c3aed', strokeWidth: 0.8 }),
      ],
    }),
  );

  wrap.appendChild(
    Plot.plot({
      height: 150,
      marginLeft: 60,
      color: { legend: true, domain: ['horizontal', 'vertical'], range: ['#2563eb', '#f59e0b'] },
      style: { background: 'transparent', fontFamily: 'inherit' },
      x: { label: 'time (s)' },
      y: { label: 'gaze offset (px)', grid: true },
      marks: [
        Plot.ruleY([0], { stroke: 'currentColor', strokeOpacity: 0.2 }),
        Plot.lineY(rows, { x: 't', y: 'gaze_x', stroke: () => 'horizontal', strokeWidth: 0.8 }),
        Plot.lineY(rows, { x: 't', y: 'gaze_y', stroke: () => 'vertical', strokeWidth: 0.8 }),
      ],
    }),
  );

  return wrap;
}

function buildGazeScatter(rows) {
  const wrap = document.createElement('div');
  wrap.className = 'swdb-eye-scatter';
  const caption = document.createElement('div');
  caption.className = 'swdb-panel-caption';
  caption.textContent = 'Gaze position (pupil centre relative to eye centre), coloured by session time';
  wrap.appendChild(caption);
  wrap.appendChild(
    Plot.plot({
      height: 320,
      width: 360,
      marginLeft: 55,
      aspectRatio: 1,
      color: { scheme: 'viridis', legend: true, label: 'time (s)' },
      style: { background: 'transparent', fontFamily: 'inherit' },
      x: { label: 'horizontal offset (px)', grid: true },
      y: { label: 'vertical offset (px)', grid: true },
      marks: [
        Plot.dot(rows, { x: 'gaze_x', y: 'gaze_y', fill: 't', r: 1.2, fillOpacity: 0.5 }),
      ],
    }),
  );
  return wrap;
}

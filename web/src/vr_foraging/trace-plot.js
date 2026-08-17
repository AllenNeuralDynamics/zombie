/**
 * vr_foraging/trace-plot.js — running-velocity session figure for the Patch /
 * VR Foraging playback tool.
 *
 * Three stacked, x-aligned panels sharing one time domain:
 *
 *   overview   patch-colour bands only (brushable zoom/pan strip)
 *   markers    Choices · Rewards · Licks event rows (above the trace)
 *   velocity   running velocity (cm/s) over patch-colour background bands
 *
 * Brushing the overview zooms the marker + velocity panels. A single CSS
 * playhead spans both lower panels; clicking anywhere in them seeks.
 *
 * Patch colours follow the ssvr / VR-Foraging dashboard theme: reward sites
 * take a per-patch colour from a Dark2-style colormap, interpatch/intersite
 * corridors are grey.
 */

import * as Plot from '@observablehq/plot';
import { createBrushOverview } from '../lib/behaviors/brush-overview.js';
import {
  CHOICE_COLOR, REWARD_COLOR, LICK_COLOR, VELOCITY_COLOR, VELOCITY_TRACE_COLOR,
  buildOdorPalette, odorBandColor,
} from './theme.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const MARGIN         = { left: 64, right: 16 };
const OVERVIEW_HEIGHT = 30;
const MARKER_HEIGHT   = 60;
const VEL_HEIGHT      = 300;
const VEL_MARGIN_TOP    = 22;
const VEL_MARGIN_BOTTOM = 34;
const MARKER_MARGIN_TOP    = 4;
const MARKER_MARGIN_BOTTOM = 4;
const MIN_PLOT_W     = 320;
const BRUSH_HANDLE_PX = 8;
const BAND_OPACITY   = 0.45;

// Marker rows (data-space, y-domain [0,3]; top → bottom).
const Y_CHOICE = 2.5;
const Y_REWARD = 1.5;
const Y_LICK   = 0.5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Seconds → "hh:mm:ss". */
function fmtHMS(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

/**
 * Reduce the raw position samples into an evenly-binned velocity trace.
 * v_bin = Δposition / Δtime over each bin; clamps small negatives to 0.
 *
 * @param {Float64Array|number[]} posT  session-relative sample times (s)
 * @param {Float64Array|number[]} posCm cumulative corridor position (cm)
 * @param {number} [binS=0.25]
 * @returns {{t:number, v:number}[]}
 */
export function computeVelocity(posT, posCm, binS = 0.25) {
  const out = [];
  const n = Math.min(posT?.length ?? 0, posCm?.length ?? 0);
  if (n < 2) return out;
  const t0 = posT[0];
  let binIdx = 0;
  let firstT = posT[0], firstP = posCm[0];
  let lastT = posT[0], lastP = posCm[0];
  for (let i = 0; i < n; i++) {
    const bi = Math.floor((posT[i] - t0) / binS);
    if (bi !== binIdx) {
      const dt = lastT - firstT;
      if (dt > 0) out.push({ t: firstT + dt / 2, v: (lastP - firstP) / dt });
      binIdx = bi;
      firstT = posT[i]; firstP = posCm[i];
    }
    lastT = posT[i]; lastP = posCm[i];
  }
  const dt = lastT - firstT;
  if (dt > 0) out.push({ t: firstT + dt / 2, v: (lastP - firstP) / dt });
  return out;
}

/** Build patch-colour bands (one per site) for the background. */
export function buildBands(sites) {
  const palette = buildOdorPalette(sites);
  const out = [];
  for (const s of sites) {
    const x1 = s.start_time_s;
    const x2 = s.stop_time_s;
    if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 <= x1) continue;
    out.push({ x1, x2, color: odorBandColor(s, palette) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the VR-foraging running-velocity plot for one session.
 *
 * @param {{sites:object[], traces:{pos_t:Float64Array, pos_cm:Float64Array, lick_t:number[]}}} data
 * @returns {{ element:HTMLElement, updatePlayhead:(t:number)=>void,
 *   setOnScrub:(cb:(t:number)=>void)=>void, dispose:()=>void }}
 */
export function createVrfTracePlot(data) {
  const { sites, traces } = data;

  const bands = buildBands(sites);
  const vel   = computeVelocity(traces.pos_t, traces.pos_cm);
  const licks = (traces.lick_t ?? [])
    .filter((t) => Number.isFinite(t))
    .map((t) => ({ t }));
  const rewards = sites
    .filter((s) => s.has_reward && Number.isFinite(s.reward_onset_time_s))
    .map((s) => ({ t: s.reward_onset_time_s }));
  const choices = sites
    .filter((s) => s.has_choice && Number.isFinite(s.choice_cue_time_s))
    .map((s) => ({ t: s.choice_cue_time_s }));

  const sessionEndS = Math.max(
    bands.length ? bands[bands.length - 1].x2 : 0,
    vel.length   ? vel[vel.length - 1].t      : 0,
  );

  let velMin = 0, velMax = 10;
  for (const d of vel) { if (d.v < velMin) velMin = d.v; if (d.v > velMax) velMax = d.v; }
  velMin = Math.floor(velMin / 10) * 10;
  velMax = Math.ceil(velMax / 10) * 10;

  // =========================================================================
  // DOM scaffold — the shared brush component (lib/behaviors/brush-overview.js)
  // owns the overview strip, brush (create/resize/pan), playheads and scrub.
  // This module only supplies the legend + the marks for each panel.
  // =========================================================================

  // ---- Legend -------------------------------------------------------------
  const legend = document.createElement('div');
  legend.className = 'vrf-trace-legend';
  legend.innerHTML = `
    <span class="vrf-trace-legend-item"><span class="vrf-lg-line"></span>Velocity</span>
    <span class="vrf-trace-legend-item"><span class="vrf-lg-square" style="background:${CHOICE_COLOR}"></span>Choices</span>
    <span class="vrf-trace-legend-item"><span class="vrf-lg-dot" style="background:${REWARD_COLOR}"></span>Rewards</span>
    <span class="vrf-trace-legend-item"><span class="vrf-lg-tick" style="background:${LICK_COLOR}"></span>Licks</span>
  `;

  // ---- Overview marks (patch-colour bands) --------------------------------
  const renderOverview = (holder, w) => {
    const p = Plot.plot({
      width: w, height: OVERVIEW_HEIGHT,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: 0, marginBottom: 0,
      style: { background: 'transparent', fontFamily: 'inherit', overflow: 'hidden' },
      x: { axis: null, domain: [0, sessionEndS] },
      y: { axis: null, domain: [0, 1] },
      marks: [
        Plot.rect(bands, { x1: 'x1', x2: 'x2', y1: 0, y2: 1,
          fill: 'color', stroke: 'none' }),
      ],
    });
    holder.replaceChildren(p);
  };

  // ---- Main marks (marker panel + velocity panel, stacked) ----------------
  const renderMain = (holder, w, [t0, t1]) => {
    const markerPlot = Plot.plot({
      width: w, height: MARKER_HEIGHT,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: MARKER_MARGIN_TOP, marginBottom: MARKER_MARGIN_BOTTOM,
      style: { background: 'transparent', fontFamily: 'inherit' },
      clip: true,
      x: { axis: null, domain: [t0, t1] },
      y: { axis: null, domain: [0, 3] },
      marks: [
        Plot.ruleX(licks, { x: 't', y1: Y_LICK - 0.32, y2: Y_LICK + 0.32,
          stroke: LICK_COLOR, strokeWidth: 0.8 }),
        Plot.dot(rewards, { x: 't', y: Y_REWARD, fill: REWARD_COLOR,
          symbol: 'circle', r: 3 }),
        Plot.dot(choices, { x: 't', y: Y_CHOICE, fill: CHOICE_COLOR,
          symbol: 'square', r: 3 }),
      ],
    });

    const velPlot = Plot.plot({
      width: w, height: VEL_HEIGHT,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: VEL_MARGIN_TOP, marginBottom: VEL_MARGIN_BOTTOM,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: {
        label: 'Time (hh:mm:ss)',
        domain: [t0, t1],
        grid: false,
        tickFormat: (t) => fmtHMS(t),
      },
      y: {
        label: 'Velocity (cm/s)',
        domain: [velMin, velMax],
        grid: false,
      },
      marks: [
        Plot.rect(bands, { x1: 'x1', x2: 'x2', y1: velMin, y2: velMax,
          fill: 'color', fillOpacity: BAND_OPACITY, stroke: 'none' }),
        Plot.lineY(vel, { x: 't', y: 'v', stroke: VELOCITY_TRACE_COLOR,
          strokeWidth: 1 }),
      ],
    });

    holder.replaceChildren(markerPlot, velPlot);
  };

  const bz = createBrushOverview({
    sessionEndS,
    margin: { left: MARGIN.left, right: MARGIN.right },
    overviewHeight: OVERVIEW_HEIGHT,
    minPlotW: MIN_PLOT_W,
    scrubInset: { top: 0, bottom: VEL_MARGIN_BOTTOM - 2 },
    playheadColor: VELOCITY_COLOR,
    wrapperClass: 'vrf-trace-wrap df-prob-plot-wrap',
    headerEl: legend,
    renderOverview,
    renderMain,
  });

  // Marker row labels (gutter overlay, aligned to the marker panel).
  const ROW_LABELS = [
    ['Choices', CHOICE_COLOR, Y_CHOICE],
    ['Rewards', REWARD_COLOR, Y_REWARD],
    ['Licks',   LICK_COLOR,   Y_LICK],
  ];
  const markerInnerH = MARKER_HEIGHT - MARKER_MARGIN_TOP - MARKER_MARGIN_BOTTOM;
  for (const [text, color, yData] of ROW_LABELS) {
    const topPx = MARKER_MARGIN_TOP + (1 - yData / 3) * markerInnerH;
    bz.mainWrap.appendChild(_makeRowLabel(text, color, MARGIN.left - 6, topPx));
  }

  return {
    element: bz.element,
    updatePlayhead: bz.updatePlayhead,
    setOnScrub: bz.setOnScrub,
    dispose: bz.dispose,
  };
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

function _makeRowLabel(text, color, widthPx, topPx) {
  const el = document.createElement('div');
  el.className = 'vrf-trace-row-label';
  el.textContent = text;
  Object.assign(el.style, {
    position: 'absolute', left: '0', width: `${widthPx}px`,
    top: `${topPx}px`, transform: 'translateY(-50%)',
    textAlign: 'right', paddingRight: '8px', fontSize: '10.5px',
    color, fontWeight: '600', pointerEvents: 'none',
    boxSizing: 'border-box', whiteSpace: 'nowrap',
  });
  return el;
}

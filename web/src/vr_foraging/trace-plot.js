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
import {
  CHOICE_COLOR, REWARD_COLOR, LICK_COLOR, VELOCITY_COLOR, siteColor,
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
  const out = [];
  for (const s of sites) {
    const x1 = s.start_time_s;
    const x2 = s.stop_time_s;
    if (!Number.isFinite(x1) || !Number.isFinite(x2) || x2 <= x1) continue;
    out.push({ x1, x2, color: siteColor(s.site_label, s.patch_index) });
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
  // DOM scaffold
  // =========================================================================

  const wrapper = document.createElement('div');
  wrapper.className = 'vrf-trace-wrap df-prob-plot-wrap';

  // ---- Legend -------------------------------------------------------------
  const legend = document.createElement('div');
  legend.className = 'vrf-trace-legend';
  legend.innerHTML = `
    <span class="vrf-trace-legend-item"><span class="vrf-lg-line"></span>Velocity</span>
    <span class="vrf-trace-legend-item"><span class="vrf-lg-square" style="background:${CHOICE_COLOR}"></span>Choices</span>
    <span class="vrf-trace-legend-item"><span class="vrf-lg-dot" style="background:${REWARD_COLOR}"></span>Rewards</span>
    <span class="vrf-trace-legend-item"><span class="vrf-lg-tick" style="background:${LICK_COLOR}"></span>Licks</span>
  `;
  wrapper.appendChild(legend);

  // ---- Overview (brushable zoom strip: bands only) ------------------------
  const overviewWrap = document.createElement('div');
  overviewWrap.className = 'df-prob-overview-wrap';
  wrapper.appendChild(overviewWrap);

  const overviewHolder = document.createElement('div');
  overviewHolder.className = 'df-prob-overview-holder';
  overviewWrap.appendChild(overviewHolder);

  const dimLeft  = document.createElement('div');
  const dimRight = document.createElement('div');
  dimLeft.className  = 'df-brush-dim';
  dimRight.className = 'df-brush-dim';
  overviewWrap.appendChild(dimLeft);
  overviewWrap.appendChild(dimRight);

  const overviewInteract = document.createElement('div');
  overviewInteract.className = 'df-brush-interact';
  overviewInteract.title = 'Drag to zoom · double-click to reset';
  overviewWrap.appendChild(overviewInteract);

  const overviewPlayhead = document.createElement('div');
  Object.assign(overviewPlayhead.style, {
    position: 'absolute', top: '0', bottom: '0', width: '1.5px',
    background: '#555', pointerEvents: 'none',
    transform: 'translateX(-0.75px)', left: '0', display: 'none',
  });
  overviewWrap.appendChild(overviewPlayhead);

  // ---- Main (marker + velocity panels + playhead) -------------------------
  const mainWrap = document.createElement('div');
  mainWrap.style.position = 'relative';
  wrapper.appendChild(mainWrap);

  const markerHolder = document.createElement('div');
  markerHolder.className = 'vrf-trace-marker-holder';
  mainWrap.appendChild(markerHolder);

  const velHolder = document.createElement('div');
  velHolder.className = 'vrf-trace-vel-holder';
  mainWrap.appendChild(velHolder);

  // Marker row labels (gutter overlay, aligned to the marker panel).
  const ROW_LABELS = [
    ['Choices', CHOICE_COLOR, Y_CHOICE],
    ['Rewards', REWARD_COLOR, Y_REWARD],
    ['Licks',   LICK_COLOR,   Y_LICK],
  ];
  const markerInnerH = MARKER_HEIGHT - MARKER_MARGIN_TOP - MARKER_MARGIN_BOTTOM;
  for (const [text, color, yData] of ROW_LABELS) {
    const topPx = MARKER_MARGIN_TOP + (1 - yData / 3) * markerInnerH;
    mainWrap.appendChild(_makeRowLabel(text, color, MARGIN.left - 6, topPx));
  }

  // Playhead spanning marker + velocity panels.
  const playhead = document.createElement('div');
  Object.assign(playhead.style, {
    position: 'absolute', top: '0px',
    bottom: `${VEL_MARGIN_BOTTOM - 2}px`, width: '1.5px',
    background: VELOCITY_COLOR, pointerEvents: 'none',
    transform: 'translateX(-0.75px)', left: '0', display: 'none',
    boxShadow: '0 0 0 0.5px rgba(255,255,255,0.6)',
  });
  mainWrap.appendChild(playhead);

  const scrubOverlay = document.createElement('div');
  Object.assign(scrubOverlay.style, {
    position: 'absolute', top: '0px',
    bottom: `${VEL_MARGIN_BOTTOM - 2}px`,
    left: `${MARGIN.left}px`, right: `${MARGIN.right}px`,
    cursor: 'crosshair',
  });
  mainWrap.appendChild(scrubOverlay);

  // =========================================================================
  // State
  // =========================================================================

  let innerWidth = 0;
  let overviewInnerWidth = 0;
  let scrubCb = null;
  let lastT = 0;
  let lastW = 0;
  let brushT0 = 0;
  let brushT1 = sessionEndS;
  let dragState = null;
  let pendingRebuild = false;

  // =========================================================================
  // Overview
  // =========================================================================

  function _pxToTime(px) {
    return Math.max(0, Math.min(sessionEndS, (px / overviewInnerWidth) * sessionEndS));
  }

  function _brushEdgePx() {
    return {
      left:  (brushT0 / sessionEndS) * overviewInnerWidth,
      right: (brushT1 / sessionEndS) * overviewInnerWidth,
    };
  }

  function _updateBrushVisual() {
    if (overviewInnerWidth <= 0) return;
    const x0 = (brushT0 / sessionEndS) * overviewInnerWidth;
    const x1 = (brushT1 / sessionEndS) * overviewInnerWidth;
    Object.assign(dimLeft.style,  { left: `${MARGIN.left}px`, width: `${Math.max(0, x0)}px` });
    Object.assign(dimRight.style, {
      left:  `${MARGIN.left + x1}px`,
      width: `${Math.max(0, overviewInnerWidth - x1)}px`,
    });
  }

  function _placeOverviewPlayhead() {
    if (sessionEndS <= 0 || overviewInnerWidth <= 0) return;
    const frac = Math.max(0, Math.min(1, lastT / sessionEndS));
    overviewPlayhead.style.left    = `${MARGIN.left + frac * overviewInnerWidth}px`;
    overviewPlayhead.style.display = '';
  }

  function _rebuildOverview(width) {
    const w = Math.max(MIN_PLOT_W, Math.floor(width));
    overviewInnerWidth = w - MARGIN.left - MARGIN.right;
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
    overviewHolder.replaceChildren(p);
    Object.assign(overviewInteract.style, {
      position: 'absolute', top: '0', bottom: '0',
      left: `${MARGIN.left}px`, width: `${overviewInnerWidth}px`,
    });
    _updateBrushVisual();
    _placeOverviewPlayhead();
  }

  // =========================================================================
  // Marker + velocity panels
  // =========================================================================

  function _placePlayhead() {
    const range = brushT1 - brushT0;
    if (range <= 0 || innerWidth <= 0) { playhead.style.display = 'none'; return; }
    const frac = (lastT - brushT0) / range;
    if (frac < 0 || frac > 1) { playhead.style.display = 'none'; return; }
    playhead.style.left    = `${MARGIN.left + frac * innerWidth}px`;
    playhead.style.display = '';
  }

  function _rebuild(width) {
    const w = Math.max(MIN_PLOT_W, Math.floor(width));
    innerWidth = w - MARGIN.left - MARGIN.right;

    const markerPlot = Plot.plot({
      width: w, height: MARKER_HEIGHT,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: MARKER_MARGIN_TOP, marginBottom: MARKER_MARGIN_BOTTOM,
      style: { background: 'transparent', fontFamily: 'inherit' },
      clip: true,
      x: { axis: null, domain: [brushT0, brushT1] },
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
    markerHolder.replaceChildren(markerPlot);

    const velPlot = Plot.plot({
      width: w, height: VEL_HEIGHT,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: VEL_MARGIN_TOP, marginBottom: VEL_MARGIN_BOTTOM,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: {
        label: 'Time (hh:mm:ss)',
        domain: [brushT0, brushT1],
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
        Plot.lineY(vel, { x: 't', y: 'v', stroke: VELOCITY_COLOR,
          strokeWidth: 1 }),
      ],
    });
    velHolder.replaceChildren(velPlot);

    _placePlayhead();
  }

  // =========================================================================
  // Scrub (click in main panels → seek within zoomed range)
  // =========================================================================

  scrubOverlay.addEventListener('click', (ev) => {
    if (!scrubCb || innerWidth <= 0) return;
    const rect = scrubOverlay.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    scrubCb(brushT0 + frac * (brushT1 - brushT0));
  });

  // =========================================================================
  // Brush interaction on the overview strip
  // =========================================================================

  overviewInteract.addEventListener('pointermove', (ev) => {
    const rect = overviewInteract.getBoundingClientRect();
    const px   = ev.clientX - rect.left;
    const t    = _pxToTime(px);

    if (dragState) {
      if (dragState.type === 'new') {
        brushT0 = Math.min(t, dragState.startT);
        brushT1 = Math.max(t, dragState.startT);
      } else if (dragState.type === 'left' || dragState.type === 'right') {
        brushT0 = Math.min(t, dragState.anchor);
        brushT1 = Math.max(t, dragState.anchor);
      } else if (dragState.type === 'move') {
        const span  = dragState.origT1 - dragState.origT0;
        const delta = t - dragState.anchorT;
        brushT0 = Math.max(0, Math.min(sessionEndS - span, dragState.origT0 + delta));
        brushT1 = brushT0 + span;
      }
      _updateBrushVisual();
      if (!pendingRebuild) {
        pendingRebuild = true;
        requestAnimationFrame(() => { pendingRebuild = false; _rebuild(lastW); });
      }
    } else {
      const { left: bL, right: bR } = _brushEdgePx();
      if (Math.abs(px - bL) <= BRUSH_HANDLE_PX || Math.abs(px - bR) <= BRUSH_HANDLE_PX) {
        overviewInteract.style.cursor = 'ew-resize';
      } else if (px >= bL && px <= bR && (brushT0 > 0 || brushT1 < sessionEndS - 0.5)) {
        overviewInteract.style.cursor = 'grab';
      } else {
        overviewInteract.style.cursor = 'crosshair';
      }
    }
  });

  overviewInteract.addEventListener('pointerdown', (ev) => {
    overviewInteract.setPointerCapture(ev.pointerId);
    const rect = overviewInteract.getBoundingClientRect();
    const px   = ev.clientX - rect.left;
    const t    = _pxToTime(px);
    const { left: bL, right: bR } = _brushEdgePx();

    if (Math.abs(px - bL) <= BRUSH_HANDLE_PX) {
      dragState = { type: 'left',  anchor: brushT1 };
    } else if (Math.abs(px - bR) <= BRUSH_HANDLE_PX) {
      dragState = { type: 'right', anchor: brushT0 };
    } else if (px >= bL && px <= bR && (brushT0 > 0 || brushT1 < sessionEndS - 0.5)) {
      dragState = { type: 'move', anchorT: t, origT0: brushT0, origT1: brushT1 };
      overviewInteract.style.cursor = 'grabbing';
    } else {
      dragState = { type: 'new', startT: t };
      brushT0 = t; brushT1 = t;
      _updateBrushVisual();
    }
    ev.preventDefault();
  });

  overviewInteract.addEventListener('pointerup', () => {
    if (!dragState) return;
    dragState = null;
    if (brushT1 - brushT0 < 2) { brushT0 = 0; brushT1 = sessionEndS; }
    overviewInteract.style.cursor = 'crosshair';
    _updateBrushVisual();
    _rebuild(lastW);
  });

  overviewInteract.addEventListener('dblclick', () => {
    brushT0 = 0; brushT1 = sessionEndS;
    _updateBrushVisual();
    _rebuild(lastW);
  });

  // =========================================================================
  // Resize
  // =========================================================================

  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.max(MIN_PLOT_W, Math.floor(e.contentRect.width));
      if (w !== lastW) { lastW = w; _rebuildOverview(w); _rebuild(w); }
    }
  });
  ro.observe(wrapper);

  queueMicrotask(() => {
    const w = Math.max(MIN_PLOT_W, wrapper.clientWidth || 600);
    if (w !== lastW) { lastW = w; _rebuildOverview(w); _rebuild(w); }
  });

  return {
    element: wrapper,
    updatePlayhead(t) { lastT = t; _placePlayhead(); _placeOverviewPlayhead(); },
    setOnScrub(cb)    { scrubCb = cb; },
    dispose()         { ro.disconnect(); },
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

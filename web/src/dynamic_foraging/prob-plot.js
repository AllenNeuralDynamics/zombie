/**
 * dynamic_foraging/prob-plot.js — reward-probability trace + raster, with a
 * moving CSS playhead overlay and a brushable overview strip for zoom/pan.
 *
 * Layout (top → bottom, inside the main Observable Plot):
 *   1.21 ┌─────────────────────────────────────────────────  Rewards row (cyan)
 *   1.13 ├─────────────────────────────────────────────────  R-lick row (red)
 *   1.06 ├─────────────────────────────────────────────────  L-lick row (blue)
 *   1.00 ├─────────────────────────────────────────────────  100 %
 *        │  pL (blue) and pR (red) step-after lines
 *   0.00 └─────────────────────────────────────────────────   0 %
 *
 * Above the main plot sits a compact overview strip (same data, no axes) that
 * has a draggable brush selection — changing the selection zooms the main plot.
 * Double-click the overview to reset to the full range.
 *
 * Row gutter labels ("Rewards" / "Licks") are rendered as overlay HTML so we
 * can keep the SVG plain.
 */

import * as Plot from '@observablehq/plot';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLOT_HEIGHT      = 260;
const OVERVIEW_HEIGHT  = 34;    // compact context-chart strip
const COLOR_L          = '#2563eb';     // blue (left) spout
const COLOR_R          = '#dc2626';     // red (right) spout

const MARGIN           = { left: 76, right: 14, top: 28, bottom: 34 };

// Row band y-coordinates (in extended data-space).
// Lick rows are slightly taller than before to comfortably hold the droplet images.
const Y_DOMAIN_MAX     = 1.24;
const Y_LICK_L_BOT     = 1.02;
const Y_LICK_L_TOP     = 1.08;
const Y_LICK_R_BOT     = 1.11;
const Y_LICK_R_TOP     = 1.17;
const Y_REW_BOT        = 1.20;
const Y_REW_TOP        = 1.23;

// Mid-points used for the gutter labels.
const Y_LABEL_REW      = (Y_REW_BOT + Y_REW_TOP) / 2;          // ≈ 1.215
const Y_LABEL_LICKS    = (Y_LICK_L_TOP + Y_LICK_R_BOT) / 2;    // between L & R lick rows

const COLOR_REWARD     = '#06b6d4';

const MIN_PLOT_W       = 320;

const BRUSH_HANDLE_PX  = 8;    // px within which to grab a brush edge

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the probability + raster plot for one session.
 *
 * @param {{trials:object[], licks:{t,side}, rewards:{t,side}, goCues, sessionEndS:number}} data
 * @returns {{ element: HTMLElement, updatePlayhead:(t:number)=>void, setOnScrub:(cb:(t:number)=>void)=>void, dispose:()=>void }}
 */
export function createProbPlot(data) {
  const { trials, licks, rewards, sessionEndS } = data;
  const stepData = _buildStepData(trials, sessionEndS);
  const { lickL, lickR } = _splitLicks(licks);
  const rewardEvents     = _eventsToObjects(rewards?.t);
  const trialSpans = trials
    .filter((tr) => Number.isFinite(tr.goCue_t))
    .map((tr, i, arr) => ({
      x1: tr.goCue_t,
      x2: i + 1 < arr.length ? arr[i + 1].goCue_t : sessionEndS,
      even: i % 2 === 0,
    }));

  // ===========================================================================
  // Outer wrapper
  // ===========================================================================

  const wrapper = document.createElement('div');
  wrapper.className = 'df-prob-plot-wrap';

  // ===========================================================================
  // Overview strip (context chart + brush)
  // ===========================================================================

  const overviewWrap = document.createElement('div');
  overviewWrap.className = 'df-prob-overview-wrap';
  wrapper.appendChild(overviewWrap);

  const overviewHolder = document.createElement('div');
  overviewHolder.className = 'df-prob-overview-holder';
  overviewWrap.appendChild(overviewHolder);

  // Dim overlays for the unselected (left/right of brush) regions.
  const dimLeft  = document.createElement('div');
  const dimRight = document.createElement('div');
  dimLeft.className  = 'df-brush-dim';
  dimRight.className = 'df-brush-dim';
  overviewWrap.appendChild(dimLeft);
  overviewWrap.appendChild(dimRight);

  // Pointer-events layer — sits on top of everything in the overview.
  const overviewInteract = document.createElement('div');
  overviewInteract.className = 'df-brush-interact';
  overviewInteract.title = 'Drag to zoom · double-click to reset';
  overviewWrap.appendChild(overviewInteract);

  // Playhead inside the overview (shows absolute position in the session).
  const overviewPlayhead = document.createElement('div');
  Object.assign(overviewPlayhead.style, {
    position: 'absolute',
    top: '0', bottom: '0',
    width: '1.5px',
    background: '#555',
    pointerEvents: 'none',
    transform: 'translateX(-0.75px)',
    left: '0',
    display: 'none',
  });
  overviewWrap.appendChild(overviewPlayhead);

  // ===========================================================================
  // Main plot container  (separate so absolute overlays stay relative to it)
  // ===========================================================================

  const mainWrap = document.createElement('div');
  mainWrap.style.position = 'relative';
  wrapper.appendChild(mainWrap);

  const plotHolder = document.createElement('div');
  plotHolder.className = 'df-prob-plot-holder';
  mainWrap.appendChild(plotHolder);

  // Row-label overlays positioned in the gutter.
  const innerH      = PLOT_HEIGHT - MARGIN.top - MARGIN.bottom;
  const yToPx       = (yData) => MARGIN.top + (1 - yData / Y_DOMAIN_MAX) * innerH;
  const rewardLabel = _makeRowLabel('Rewards', COLOR_REWARD, MARGIN.left - 6, yToPx(Y_LABEL_REW));
  const licksLabel  = _makeRowLabel('Licks',   '#444',       MARGIN.left - 6, yToPx(Y_LABEL_LICKS));
  mainWrap.appendChild(rewardLabel);
  mainWrap.appendChild(licksLabel);

  // Playhead — vertical bar across the main plot area.
  const playhead = document.createElement('div');
  playhead.className = 'df-playhead';
  Object.assign(playhead.style, {
    position: 'absolute',
    top:    `${MARGIN.top - 6}px`,
    bottom: `${MARGIN.bottom - 4}px`,
    width: '1.5px',
    background: '#222',
    pointerEvents: 'none',
    transform: 'translateX(-0.75px)',
    left: '0',
    display: 'none',
  });
  mainWrap.appendChild(playhead);

  // Click-to-scrub overlay (covers the inner plot area).
  const scrubOverlay = document.createElement('div');
  scrubOverlay.className = 'df-prob-scrub-overlay';
  Object.assign(scrubOverlay.style, {
    position: 'absolute',
    top:    `${MARGIN.top - 6}px`,
    bottom: `${MARGIN.bottom - 4}px`,
    left: '0', right: '0',
    cursor: 'crosshair',
  });
  mainWrap.appendChild(scrubOverlay);

  // ===========================================================================
  // State
  // ===========================================================================

  let innerLeft          = MARGIN.left;
  let innerWidth         = 0;
  let overviewInnerWidth = 0;
  let scrubCb            = null;
  let lastT              = 0;
  let lastW              = 0;
  let brushT0            = 0;
  let brushT1            = sessionEndS;
  let dragState          = null;
  let pendingRebuild     = false;

  // ===========================================================================
  // Overview helpers
  // ===========================================================================

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

  // ===========================================================================
  // Main-plot playhead
  // ===========================================================================

  function _placePlayhead() {
    const range = brushT1 - brushT0;
    if (range <= 0 || innerWidth <= 0) return;
    const frac = (lastT - brushT0) / range;
    if (frac < 0 || frac > 1) { playhead.style.display = 'none'; return; }
    playhead.style.left    = `${innerLeft + frac * innerWidth}px`;
    playhead.style.display = '';
  }

  // ===========================================================================
  // Overview rebuild
  // ===========================================================================

  function _rebuildOverview(width) {
    const w = Math.max(MIN_PLOT_W, Math.floor(width));
    overviewInnerWidth = w - MARGIN.left - MARGIN.right;

    const plot = Plot.plot({
      width: w,
      height: OVERVIEW_HEIGHT,
      marginLeft:   MARGIN.left,
      marginRight:  MARGIN.right,
      marginTop:    3,
      marginBottom: 3,
      style: { background: 'transparent', fontFamily: 'inherit', overflow: 'hidden' },
      x: { axis: null, domain: [0, sessionEndS] },
      y: { axis: null, domain: [0, 1] },
      marks: [
        Plot.lineY(stepData, { x: 't', y: 'pL', stroke: COLOR_L,
          strokeWidth: 1.5, curve: 'step-after' }),
        Plot.lineY(stepData, { x: 't', y: 'pR', stroke: COLOR_R,
          strokeWidth: 1.5, curve: 'step-after' }),
      ],
    });
    overviewHolder.replaceChildren(plot);

    // Position the interact overlay over the inner area.
    Object.assign(overviewInteract.style, {
      position: 'absolute', top: '0', bottom: '0',
      left:  `${MARGIN.left}px`,
      width: `${overviewInnerWidth}px`,
    });

    _updateBrushVisual();
    _placeOverviewPlayhead();
  }

  // ===========================================================================
  // Main plot rebuild  (uses current brush range as x domain)
  // ===========================================================================

  function _rebuild(width) {
    const w = Math.max(MIN_PLOT_W, Math.floor(width));
    const plot = Plot.plot({
      width: w,
      height: PLOT_HEIGHT,
      marginLeft:   MARGIN.left,
      marginRight:  MARGIN.right,
      marginTop:    MARGIN.top,
      marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: {
        label: 'time (s) →',
        domain: [brushT0, brushT1],
        grid: false,
      },
      y: {
        label: 'reward probability',
        domain: [0, Y_DOMAIN_MAX],
        ticks: [0, 0.25, 0.5, 0.75, 1],
        tickFormat: (d) => (d > 1 + 1e-9 ? '' : `${Math.round(d * 100)}%`),
        grid: true,
      },
      marks: [
        // Trial span bands (alternating very-light grey)
        Plot.rect(trialSpans, { x1: 'x1', x2: 'x2', y1: 0, y2: Y_DOMAIN_MAX,
          fill: (d) => d.even ? '#fafafa' : '#f2f2f2', stroke: 'none' }),

        // 100 % reference (dashed)
        Plot.ruleY([1], { stroke: '#bbb', strokeOpacity: 0.7, strokeDasharray: '2,3' }),

        // Raster rows
        Plot.ruleX(lickL, { x: 't', y1: Y_LICK_L_BOT, y2: Y_LICK_L_TOP,
          stroke: COLOR_L, strokeOpacity: 0.55, strokeWidth: 0.8 }),
        Plot.ruleX(lickR, { x: 't', y1: Y_LICK_R_BOT, y2: Y_LICK_R_TOP,
          stroke: COLOR_R, strokeOpacity: 0.55, strokeWidth: 0.8 }),
        Plot.ruleX(rewardEvents, { x: 't', y1: Y_REW_BOT, y2: Y_REW_TOP,
          stroke: COLOR_REWARD, strokeOpacity: 0.95, strokeWidth: 1.1 }),

        // Probability step lines
        Plot.lineY(stepData, { x: 't', y: 'pL', stroke: COLOR_L,
          strokeWidth: 1.8, curve: 'step-after' }),
        Plot.lineY(stepData, { x: 't', y: 'pR', stroke: COLOR_R,
          strokeWidth: 1.8, curve: 'step-after' }),
      ],
    });
    plotHolder.replaceChildren(plot);
    innerLeft  = MARGIN.left;
    innerWidth = w - MARGIN.left - MARGIN.right;
    _placePlayhead();
  }

  // ===========================================================================
  // Scrub in main plot (maps click to time within the zoomed range)
  // ===========================================================================

  scrubOverlay.addEventListener('click', (ev) => {
    if (!scrubCb || innerWidth <= 0) return;
    const rect = scrubOverlay.getBoundingClientRect();
    const x    = ev.clientX - rect.left - innerLeft;
    const frac = Math.max(0, Math.min(1, x / innerWidth));
    scrubCb(brushT0 + frac * (brushT1 - brushT0));
  });

  // ===========================================================================
  // Brush interaction on the overview strip
  // ===========================================================================

  overviewInteract.addEventListener('pointermove', (ev) => {
    const rect = overviewInteract.getBoundingClientRect();
    const px   = ev.clientX - rect.left;
    const t    = _pxToTime(px);

    if (dragState) {
      // --- Dragging ---
      if (dragState.type === 'new') {
        brushT0 = Math.min(t, dragState.startT);
        brushT1 = Math.max(t, dragState.startT);
      } else if (dragState.type === 'left') {
        brushT0 = Math.min(t, dragState.anchor);
        brushT1 = Math.max(t, dragState.anchor);
      } else if (dragState.type === 'right') {
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
      // --- Hover: update cursor ---
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
      overviewInteract.style.cursor = 'ew-resize';
    } else if (Math.abs(px - bR) <= BRUSH_HANDLE_PX) {
      dragState = { type: 'right', anchor: brushT0 };
      overviewInteract.style.cursor = 'ew-resize';
    } else if (px >= bL && px <= bR && (brushT0 > 0 || brushT1 < sessionEndS - 0.5)) {
      dragState = { type: 'move', anchorT: t, origT0: brushT0, origT1: brushT1 };
      overviewInteract.style.cursor = 'grabbing';
    } else {
      dragState = { type: 'new', startT: t };
      brushT0   = t;
      brushT1   = t;
      _updateBrushVisual();
      overviewInteract.style.cursor = 'crosshair';
    }
    ev.preventDefault();
  });

  overviewInteract.addEventListener('pointerup', () => {
    if (!dragState) return;
    dragState = null;
    // Selection too small → snap back to full range.
    if (brushT1 - brushT0 < 2) { brushT0 = 0; brushT1 = sessionEndS; }
    overviewInteract.style.cursor = 'crosshair';
    _updateBrushVisual();
    _rebuild(lastW);
  });

  // Double-click → reset to full range.
  overviewInteract.addEventListener('dblclick', () => {
    brushT0 = 0;
    brushT1 = sessionEndS;
    _updateBrushVisual();
    _rebuild(lastW);
  });

  // ===========================================================================
  // ResizeObserver
  // ===========================================================================

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
// Helpers
// ---------------------------------------------------------------------------

function _makeRowLabel(text, color, rightPx, topPx) {
  const el = document.createElement('div');
  el.className = 'df-row-label';
  el.textContent = text;
  Object.assign(el.style, {
    position: 'absolute',
    right: 'auto',
    left: '0',
    width: `${rightPx}px`,
    top: `${topPx}px`,
    transform: 'translateY(-50%)',
    textAlign: 'right',
    paddingRight: '8px',
    fontSize: '10.5px',
    color,
    fontWeight: '600',
    pointerEvents: 'none',
    boxSizing: 'border-box',
    whiteSpace: 'nowrap',
  });
  return el;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Convert per-trial reward_probability[L|R] into step data keyed on goCue time.
 * Adds a sentinel at sessionEndS so the lines extend to the end of the plot.
 *
 * @param {object[]} trials
 * @param {number}   sessionEndS
 * @returns {{t:number, pL:number, pR:number}[]}
 */
export function _buildStepData(trials, sessionEndS) {
  const out = [];
  for (const tr of trials) {
    if (!Number.isFinite(tr.goCue_t) || !Number.isFinite(tr.pL) || !Number.isFinite(tr.pR)) continue;
    out.push({ t: tr.goCue_t, pL: tr.pL, pR: tr.pR });
  }
  if (out.length > 0) {
    const last = out[out.length - 1];
    out.push({ t: sessionEndS, pL: last.pL, pR: last.pR });
  }
  return out;
}

/**
 * Split typed-array lick events into per-side arrays of { t } objects
 * suitable for Observable Plot rule marks.
 *
 * @param {{t:Float64Array|number[], side:Uint8Array|number[]}} licks
 * @returns {{lickL:{t:number}[], lickR:{t:number}[]}}
 */
export function _splitLicks(licks) {
  const lickL = [];
  const lickR = [];
  const n = Math.min(licks.t.length, licks.side.length);
  for (let i = 0; i < n; i++) {
    const t = licks.t[i];
    if (!Number.isFinite(t)) continue;
    if (licks.side[i] === 0) lickL.push({ t });
    else if (licks.side[i] === 1) lickR.push({ t });
  }
  return { lickL, lickR };
}

/**
 * Split typed-array reward events into per-side arrays of { t } objects.
 * Side 0 = left spout, side 1 = right spout.
 *
 * @param {{t:Float64Array|number[], side:Uint8Array|number[]}|null|undefined} rewards
 * @returns {{rewardL:{t:number}[], rewardR:{t:number}[]}}
 */
export function _splitRewards(rewards) {
  const rewardL = [];
  const rewardR = [];
  if (!rewards) return { rewardL, rewardR };
  const n = Math.min(rewards.t.length, rewards.side.length);
  for (let i = 0; i < n; i++) {
    const t = rewards.t[i];
    if (!Number.isFinite(t)) continue;
    if (rewards.side[i] === 0) rewardL.push({ t });
    else if (rewards.side[i] === 1) rewardR.push({ t });
  }
  return { rewardL, rewardR };
}

/**
 * Convert a (possibly typed) array of event timestamps into [{t}] rows.
 * Drops non-finite values.
 *
 * @param {Float64Array|number[]|null|undefined} ts
 * @returns {{t:number}[]}
 */
export function _eventsToObjects(ts) {
  if (!ts) return [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const v = ts[i];
    if (Number.isFinite(v)) out.push({ t: v });
  }
  return out;
}

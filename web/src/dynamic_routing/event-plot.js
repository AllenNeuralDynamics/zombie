/**
 * dynamic_routing/event-plot.js — block-aware event plot for the DR session
 * player. Mirrors the layout style of the dynamic-foraging prob-plot, with:
 *
 *   - An overview strip at the top showing the block structure, with a
 *     drag-to-zoom brush (double-click to reset).
 *   - The main plot below shows (in extended y-space):
 *       * Reward delivery ticks (top row)
 *       * Lick ticks (one row below)
 *       * Stimulus-onset ticks colored by category (vis/aud × target/nontarget,
 *         plus catch)
 *       * Block bands (background, colored by rewarded modality)
 *       * Step-after lines for per-block performance:
 *           - solid green: response rate to the currently-rewarded target
 *           - dashed red:  response rate to the currently-unrewarded target
 *             (cross-modal "false alarm")
 *   - A moving CSS playhead overlay tied to the animation transport.
 *
 * Public API mirrors prob-plot.js so it can be a drop-in replacement.
 */

import * as Plot from '@observablehq/plot';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLOT_HEIGHT     = 280;
const OVERVIEW_HEIGHT = 36;

const COLOR_VIS       = '#7c3aed';   // purple — visual rule
const COLOR_AUD       = '#f59e0b';   // amber  — auditory rule
const COLOR_VIS_TGT   = '#1e40af';   // deep blue — vis target stim
const COLOR_VIS_NTG   = '#60a5fa';   // light blue — vis nontarget
const COLOR_AUD_TGT   = '#b91c1c';   // dark red — aud target stim
const COLOR_AUD_NTG   = '#fca5a5';   // pink — aud nontarget
const COLOR_CATCH     = '#9ca3af';   // gray
const COLOR_REWARD    = '#06b6d4';   // cyan — water
const COLOR_RESP      = '#374151';   // dark slate — trial responses (first lick in window)
const COLOR_TGT_RATE  = '#16a34a';   // green — target response rate
const COLOR_FA_RATE   = '#dc2626';   // red — cross-modal FA rate

const MARGIN          = { left: 84, right: 14, top: 28, bottom: 34 };

const Y_DOMAIN_MAX    = 1.34;
const Y_STIM_BOT      = 1.02;
const Y_STIM_TOP      = 1.08;
const Y_RESP_BOT      = 1.12;
const Y_RESP_TOP      = 1.18;
const Y_REW_BOT       = 1.22;
const Y_REW_TOP       = 1.30;

const Y_LABEL_STIM    = (Y_STIM_BOT + Y_STIM_TOP) / 2;
const Y_LABEL_RESP    = (Y_RESP_BOT + Y_RESP_TOP) / 2;
const Y_LABEL_REW     = (Y_REW_BOT + Y_REW_TOP) / 2;

const MIN_PLOT_W      = 320;
const BRUSH_HANDLE_PX = 8;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the event plot for one DR session.
 *
 * @param {{trials, blocks, stims, responses, rewards, sessionEndS}} data
 * @returns {{element, updatePlayhead, setOnScrub, dispose}}
 */
export function createEventPlot(data) {
  const { blocks, stims, responses, rewards, sessionEndS } = data;

  const blockSpans   = _buildBlockSpans(blocks, sessionEndS);
  const targetSteps  = _buildRateSteps(blocks, sessionEndS, 'target');
  const faSteps      = _buildRateSteps(blocks, sessionEndS, 'fa');
  const stimEvents   = stims.map((s) => ({ t: s.t, kind: s.kind }));
  const respEvents   = _arrayToRows(responses?.t);
  const rewardEvents = _arrayToRows(rewards?.t);

  // ===========================================================================
  // Outer wrapper
  // ===========================================================================

  const wrapper = document.createElement('div');
  wrapper.className = 'dr-evt-plot-wrap';

  // -- Overview ----------------------------------------------------------
  const overviewWrap = document.createElement('div');
  overviewWrap.className = 'dr-evt-overview-wrap';
  wrapper.appendChild(overviewWrap);

  const overviewHolder = document.createElement('div');
  overviewHolder.className = 'dr-evt-overview-holder';
  overviewWrap.appendChild(overviewHolder);

  const dimLeft  = document.createElement('div');
  const dimRight = document.createElement('div');
  dimLeft.className  = 'dr-brush-dim';
  dimRight.className = 'dr-brush-dim';
  overviewWrap.appendChild(dimLeft);
  overviewWrap.appendChild(dimRight);

  const overviewInteract = document.createElement('div');
  overviewInteract.className = 'dr-brush-interact';
  overviewInteract.title = 'Drag to zoom · double-click to reset';
  overviewWrap.appendChild(overviewInteract);

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

  // -- Main plot ---------------------------------------------------------
  const mainWrap = document.createElement('div');
  mainWrap.style.position = 'relative';
  wrapper.appendChild(mainWrap);

  const plotHolder = document.createElement('div');
  plotHolder.className = 'dr-evt-plot-holder';
  mainWrap.appendChild(plotHolder);

  // Gutter labels
  const innerH = PLOT_HEIGHT - MARGIN.top - MARGIN.bottom;
  const yToPx = (yData) => MARGIN.top + (1 - yData / Y_DOMAIN_MAX) * innerH;
  mainWrap.appendChild(_makeRowLabel('Rewards',  COLOR_REWARD, MARGIN.left - 6, yToPx(Y_LABEL_REW)));
  mainWrap.appendChild(_makeRowLabel('Response', COLOR_RESP,   MARGIN.left - 6, yToPx(Y_LABEL_RESP)));
  mainWrap.appendChild(_makeRowLabel('Stim',     '#444',       MARGIN.left - 6, yToPx(Y_LABEL_STIM)));

  // Playhead
  const playhead = document.createElement('div');
  playhead.className = 'dr-playhead';
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

  // Click-to-scrub overlay
  const scrubOverlay = document.createElement('div');
  scrubOverlay.className = 'dr-evt-scrub-overlay';
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

  let innerLeft = MARGIN.left;
  let innerWidth = 0;
  let overviewInnerWidth = 0;
  let scrubCb = null;
  let lastT = 0;
  let lastW = 0;
  let brushT0 = 0;
  let brushT1 = sessionEndS;
  let dragState = null;
  let pendingRebuild = false;

  // ===========================================================================
  // Helpers
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
    overviewPlayhead.style.left = `${MARGIN.left + frac * overviewInnerWidth}px`;
    overviewPlayhead.style.display = '';
  }

  function _placePlayhead() {
    const range = brushT1 - brushT0;
    if (range <= 0 || innerWidth <= 0) return;
    const frac = (lastT - brushT0) / range;
    if (frac < 0 || frac > 1) { playhead.style.display = 'none'; return; }
    playhead.style.left = `${innerLeft + frac * innerWidth}px`;
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
        Plot.rect(blockSpans, {
          x1: 'x1', x2: 'x2', y1: 0, y2: 1,
          fill: (d) => d.rewardedMod === 'aud' ? COLOR_AUD : COLOR_VIS,
          fillOpacity: 0.45,
          stroke: 'none',
        }),
      ],
    });
    overviewHolder.replaceChildren(plot);

    Object.assign(overviewInteract.style, {
      position: 'absolute', top: '0', bottom: '0',
      left:  `${MARGIN.left}px`,
      width: `${overviewInnerWidth}px`,
    });

    _updateBrushVisual();
    _placeOverviewPlayhead();
  }

  // ===========================================================================
  // Main plot rebuild
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
        label: 'response rate',
        domain: [0, Y_DOMAIN_MAX],
        ticks: [0, 0.25, 0.5, 0.75, 1],
        tickFormat: (d) => (d > 1 + 1e-9 ? '' : `${Math.round(d * 100)}%`),
        grid: true,
      },
      marks: [
        // Block bands (background)
        Plot.rect(blockSpans, {
          x1: 'x1', x2: 'x2', y1: 0, y2: Y_DOMAIN_MAX,
          fill: (d) => d.rewardedMod === 'aud' ? COLOR_AUD : COLOR_VIS,
          fillOpacity: 0.10,
          stroke: 'none',
        }),
        // Block boundaries
        Plot.ruleX(blockSpans.map((b) => b.x1), {
          stroke: '#888', strokeOpacity: 0.45, strokeDasharray: '2,3',
        }),
        // 100 % reference
        Plot.ruleY([1], { stroke: '#bbb', strokeOpacity: 0.7, strokeDasharray: '2,3' }),

        // Stim ticks colored by category
        Plot.ruleX(stimEvents, {
          x: 't', y1: Y_STIM_BOT, y2: Y_STIM_TOP,
          stroke: (d) => _stimColor(d.kind),
          strokeOpacity: 0.9,
          strokeWidth: 1.2,
        }),
        // Lick ticks
        Plot.ruleX(respEvents, {
          x: 't', y1: Y_RESP_BOT, y2: Y_RESP_TOP,
          stroke: COLOR_RESP, strokeOpacity: 0.6, strokeWidth: 0.9,
        }),
        // Reward ticks
        Plot.ruleX(rewardEvents, {
          x: 't', y1: Y_REW_BOT, y2: Y_REW_TOP,
          stroke: COLOR_REWARD, strokeOpacity: 0.95, strokeWidth: 1.3,
        }),

        // Per-block target response rate (green step line)
        Plot.lineY(targetSteps, {
          x: 't', y: 'rate',
          stroke: COLOR_TGT_RATE,
          strokeWidth: 2,
          curve: 'step-after',
        }),
        // Per-block cross-modal FA rate (red step line)
        Plot.lineY(faSteps, {
          x: 't', y: 'rate',
          stroke: COLOR_FA_RATE,
          strokeWidth: 2,
          strokeDasharray: '4,3',
          curve: 'step-after',
        }),
      ],
    });
    plotHolder.replaceChildren(plot);
    innerLeft  = MARGIN.left;
    innerWidth = w - MARGIN.left - MARGIN.right;
    _placePlayhead();
  }

  // ===========================================================================
  // Scrub
  // ===========================================================================

  scrubOverlay.addEventListener('click', (ev) => {
    if (!scrubCb || innerWidth <= 0) return;
    const rect = scrubOverlay.getBoundingClientRect();
    const x = ev.clientX - rect.left - innerLeft;
    const frac = Math.max(0, Math.min(1, x / innerWidth));
    scrubCb(brushT0 + frac * (brushT1 - brushT0));
  });

  // ===========================================================================
  // Brush interactions
  // ===========================================================================

  overviewInteract.addEventListener('pointermove', (ev) => {
    const rect = overviewInteract.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const t = _pxToTime(px);

    if (dragState) {
      if (dragState.type === 'new') {
        brushT0 = Math.min(t, dragState.startT);
        brushT1 = Math.max(t, dragState.startT);
      } else if (dragState.type === 'left' || dragState.type === 'right') {
        brushT0 = Math.min(t, dragState.anchor);
        brushT1 = Math.max(t, dragState.anchor);
      } else if (dragState.type === 'move') {
        const span = dragState.origT1 - dragState.origT0;
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
    const px = ev.clientX - rect.left;
    const t = _pxToTime(px);
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

  // ===========================================================================
  // Sizing
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
    setOnScrub(cb) { scrubCb = cb; },
    dispose() { ro.disconnect(); },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

function _stimColor(kind) {
  switch (kind) {
    case 'vis_target':    return COLOR_VIS_TGT;
    case 'vis_nontarget': return COLOR_VIS_NTG;
    case 'aud_target':    return COLOR_AUD_TGT;
    case 'aud_nontarget': return COLOR_AUD_NTG;
    case 'catch':         return COLOR_CATCH;
    default:              return '#000';
  }
}

/**
 * Build per-block rectangles with the time range each block covers. The last
 * block extends to sessionEndS. Exported for tests.
 */
export function _buildBlockSpans(blocks, sessionEndS) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const x1 = Number.isFinite(b.start_t) ? b.start_t : 0;
    const x2 = i + 1 < blocks.length
      ? blocks[i + 1].start_t
      : Math.max(sessionEndS, Number.isFinite(b.stop_t) ? b.stop_t : x1);
    out.push({ x1, x2, rewardedMod: b.rewardedMod, block: b.block });
  }
  return out;
}

/**
 * Step-after data for per-block rates.
 * kind:
 *   'target' → n_hit / n_target (response rate to the rewarded-modality target)
 *   'fa'     → n_fa / n_nontarget (response rate to a nontarget — cross-modal
 *              for switches, intra-modal for the rewarded modality's distractor)
 *
 * The final point doubles the last block's rate at sessionEndS so the line
 * extends to the end of the plot.
 *
 * Exported for tests.
 */
export function _buildRateSteps(blocks, sessionEndS, kind) {
  const out = [];
  for (const b of blocks) {
    const rate = kind === 'target'
      ? (b.n_target > 0 ? b.n_hit / b.n_target : null)
      : (b.n_nontarget > 0 ? b.n_fa / b.n_nontarget : null);
    if (rate == null || !Number.isFinite(b.start_t)) continue;
    out.push({ t: b.start_t, rate });
  }
  if (out.length > 0) {
    const last = out[out.length - 1];
    out.push({ t: sessionEndS, rate: last.rate });
  }
  return out;
}

/**
 * Convert a typed-array of timestamps into [{t}] rows for Plot rule marks.
 * Exported for tests.
 */
export function _arrayToRows(ts) {
  if (!ts) return [];
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const v = ts[i];
    if (Number.isFinite(v)) out.push({ t: v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function _makeRowLabel(text, color, rightPx, topPx) {
  const el = document.createElement('div');
  el.className = 'dr-row-label';
  el.textContent = text;
  Object.assign(el.style, {
    position: 'absolute',
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

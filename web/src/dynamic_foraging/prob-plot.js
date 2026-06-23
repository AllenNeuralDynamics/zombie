/**
 * dynamic_foraging/prob-plot.js — reward-probability trace + raster, with a
 * moving CSS playhead overlay and a brushable overview strip for zoom/pan.
 *
 * Two modes toggled by a tab strip:
 *   • "Time"  — lick/reward rasters keyed on real time (seconds)
 *   • "Trial" — choice/reward rasters keyed on trial number, with pL/pR filled areas
 *
 * Time-mode layout (top → bottom, inside the main Observable Plot):
 *   1.21 ┌─── Rewards row (cyan)
 *   1.13 ├─── R-lick row (red)
 *   1.06 ├─── L-lick row (blue)
 *   1.00 ├─── 100 %
 *        │  pL (blue) and pR (red) step-after lines
 *   0.00 └─── 0 %
 *
 * Trial-mode layout (top → bottom):
 *   1.35 ┌─── Ignored (purple ticks)
 *   1.23 ├─── R Reward (black ticks)
 *   1.13 ├─── R Choice (grey rects)
 *   1.00 ├─── 100 %
 *        │  pR (red fill) and pL (blue fill) step-after areas
 *   0.00 ├─── 0 %
 *  -0.09 ├─── L Choice (grey rects)
 *  -0.19 └─── L Reward (blue ticks)
 */

import * as Plot from '@observablehq/plot';

// ── Shared constants ─────────────────────────────────────────────────────────

const PLOT_HEIGHT_TIME  = 260;
const PLOT_HEIGHT_TRIAL = 290;
const OVERVIEW_HEIGHT   = 34;
const COLOR_L           = '#2563eb';
const COLOR_R           = '#dc2626';
const COLOR_IGN         = '#7c3aed';
const COLOR_REWARD      = '#06b6d4';
const MARGIN            = { left: 76, right: 14, top: 28, bottom: 34 };
const MIN_PLOT_W        = 320;
const BRUSH_HANDLE_PX   = 8;

// ── Time-mode y layout ────────────────────────────────────────────────────────

const Y_DOMAIN_MAX   = 1.24;
const Y_LICK_L_BOT   = 1.02, Y_LICK_L_TOP = 1.08;
const Y_LICK_R_BOT   = 1.11, Y_LICK_R_TOP = 1.17;
const Y_REW_BOT      = 1.20, Y_REW_TOP    = 1.23;
const Y_LABEL_REW    = (Y_REW_BOT + Y_REW_TOP) / 2;
const Y_LABEL_LICKS  = (Y_LICK_L_TOP + Y_LICK_R_BOT) / 2;

// ── Trial-mode y layout ───────────────────────────────────────────────────────

const Y_TR_MAX        = 1.40;
const Y_TR_MIN        = -0.22;
const Y_IGN_BOT       = 1.33, Y_IGN_TOP     = 1.37;
const Y_RREW_BOT      = 1.22, Y_RREW_TOP    = 1.27;
const Y_RCHOICE_BOT   = 1.09, Y_RCHOICE_TOP = 1.19;
const Y_LCHOICE_BOT   = -0.09, Y_LCHOICE_TOP = 0.00;
const Y_LREW_BOT      = -0.21, Y_LREW_TOP   = -0.11;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {{trials:object[], licks:{t,side}, rewards:{t,side}, goCues, sessionEndS:number}} data
 * @returns {{ element:HTMLElement, updatePlayhead:(t:number)=>void, setOnScrub:(cb:(t:number)=>void)=>void, dispose:()=>void }}
 */
export function createProbPlot(data) {
  const { trials, licks, rewards, sessionEndS } = data;

  // Time-mode data
  const stepData    = _buildStepData(trials, sessionEndS);
  const { lickL, lickR } = _splitLicks(licks);
  const rewardEvents = _eventsToObjects(rewards?.t);
  const trialSpans   = trials
    .filter(tr => Number.isFinite(tr.goCue_t))
    .map((tr, i, arr) => ({
      x1: tr.goCue_t,
      x2: i + 1 < arr.length ? arr[i + 1].goCue_t : sessionEndS,
      even: i % 2 === 0,
    }));

  // Trial-mode data
  const nTrials       = trials.length;
  const stepDataTrial = _buildStepDataTrial(trials);
  const { choiceL, choiceR, ignored, rewardL, rewardR } = _buildTrialEventData(trials);

  // ── Outer wrapper ─────────────────────────────────────────────────────────

  const wrapper = document.createElement('div');
  wrapper.className = 'df-prob-plot-wrap';

  // ── Mode toggle ───────────────────────────────────────────────────────────

  const toggleBar = document.createElement('div');
  toggleBar.className = 'df-mode-toggle';
  const btnTime  = _makeToggleBtn('Time',  true);
  const btnTrial = _makeToggleBtn('Trial', false);
  toggleBar.append(btnTime, btnTrial);
  wrapper.appendChild(toggleBar);

  // ── Overview strip (context chart + brush) ────────────────────────────────

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
    position: 'absolute', top: '0', bottom: '0',
    width: '1.5px', background: '#555', pointerEvents: 'none',
    transform: 'translateX(-0.75px)', left: '0', display: 'none',
  });
  overviewWrap.appendChild(overviewPlayhead);

  // ── Main plot container ───────────────────────────────────────────────────

  const mainWrap = document.createElement('div');
  mainWrap.style.position = 'relative';
  wrapper.appendChild(mainWrap);

  const plotHolder = document.createElement('div');
  plotHolder.className = 'df-prob-plot-holder';
  mainWrap.appendChild(plotHolder);

  // Time-mode row labels
  const innerHTime  = PLOT_HEIGHT_TIME  - MARGIN.top - MARGIN.bottom;
  const yToPxTime   = y => MARGIN.top + (1 - y / Y_DOMAIN_MAX)        * innerHTime;
  const rewardLabel = _makeRowLabel('Rewards', COLOR_REWARD, MARGIN.left - 6, yToPxTime(Y_LABEL_REW));
  const licksLabel  = _makeRowLabel('Licks',   '#444',       MARGIN.left - 6, yToPxTime(Y_LABEL_LICKS));
  mainWrap.appendChild(rewardLabel);
  mainWrap.appendChild(licksLabel);

  // Trial-mode row labels (initially hidden)
  const innerHTrial = PLOT_HEIGHT_TRIAL - MARGIN.top - MARGIN.bottom;
  const yToPxTrial  = y => MARGIN.top + (1 - (y - Y_TR_MIN) / (Y_TR_MAX - Y_TR_MIN)) * innerHTrial;
  const trialRowLabels = [
    _makeRowLabel('Ignored',  COLOR_IGN, MARGIN.left - 6, yToPxTrial((Y_IGN_BOT + Y_IGN_TOP) / 2)),
    _makeRowLabel('R Reward', COLOR_R,   MARGIN.left - 6, yToPxTrial((Y_RREW_BOT + Y_RREW_TOP) / 2)),
    _makeRowLabel('R Choice', COLOR_R,   MARGIN.left - 6, yToPxTrial((Y_RCHOICE_BOT + Y_RCHOICE_TOP) / 2)),
    _makeRowLabel('p(R)',     COLOR_R,   MARGIN.left - 6, yToPxTrial(0.75)),
    _makeRowLabel('p(L)',     COLOR_L,   MARGIN.left - 6, yToPxTrial(0.25)),
    _makeRowLabel('L Choice', COLOR_L,   MARGIN.left - 6, yToPxTrial((Y_LCHOICE_BOT + Y_LCHOICE_TOP) / 2)),
    _makeRowLabel('L Reward', COLOR_L,   MARGIN.left - 6, yToPxTrial((Y_LREW_BOT + Y_LREW_TOP) / 2)),
  ];
  trialRowLabels.forEach(l => { l.style.display = 'none'; mainWrap.appendChild(l); });

  // Playhead (time mode only)
  const playhead = document.createElement('div');
  playhead.className = 'df-playhead';
  Object.assign(playhead.style, {
    position: 'absolute',
    top: `${MARGIN.top - 6}px`, bottom: `${MARGIN.bottom - 4}px`,
    width: '1.5px', background: '#222', pointerEvents: 'none',
    transform: 'translateX(-0.75px)', left: '0', display: 'none',
  });
  mainWrap.appendChild(playhead);

  // Click-to-scrub overlay (time mode only)
  const scrubOverlay = document.createElement('div');
  scrubOverlay.className = 'df-prob-scrub-overlay';
  Object.assign(scrubOverlay.style, {
    position: 'absolute',
    top: `${MARGIN.top - 6}px`, bottom: `${MARGIN.bottom - 4}px`,
    left: '0', right: '0', cursor: 'crosshair',
  });
  mainWrap.appendChild(scrubOverlay);

  // ── State ─────────────────────────────────────────────────────────────────

  let mode               = 'time';
  let innerLeft          = MARGIN.left;
  let innerWidth         = 0;
  let overviewInnerWidth = 0;
  let scrubCb            = null;
  let lastT              = 0;
  let lastW              = 0;
  let brushLo            = 0;
  let brushHi            = sessionEndS;
  let dragState          = null;
  let pendingRebuild     = false;

  function _brushDomain() {
    return mode === 'time'
      ? { min: 0,  max: sessionEndS }
      : { min: 1,  max: nTrials };
  }

  // ── Overview helpers ──────────────────────────────────────────────────────

  function _pxToDomain(px) {
    const { min, max } = _brushDomain();
    return min + Math.max(0, Math.min(1, px / overviewInnerWidth)) * (max - min);
  }

  function _brushEdgePx() {
    const { min, max } = _brushDomain();
    const span = max - min;
    return {
      left:  (brushLo - min) / span * overviewInnerWidth,
      right: (brushHi - min) / span * overviewInnerWidth,
    };
  }

  function _updateBrushVisual() {
    if (overviewInnerWidth <= 0) return;
    const { left: x0, right: x1 } = _brushEdgePx();
    Object.assign(dimLeft.style,  { left: `${MARGIN.left}px`, width: `${Math.max(0, x0)}px` });
    Object.assign(dimRight.style, {
      left:  `${MARGIN.left + x1}px`,
      width: `${Math.max(0, overviewInnerWidth - x1)}px`,
    });
  }

  function _placeOverviewPlayhead() {
    if (mode !== 'time' || sessionEndS <= 0 || overviewInnerWidth <= 0) {
      overviewPlayhead.style.display = 'none';
      return;
    }
    const frac = Math.max(0, Math.min(1, lastT / sessionEndS));
    overviewPlayhead.style.left    = `${MARGIN.left + frac * overviewInnerWidth}px`;
    overviewPlayhead.style.display = '';
  }

  // ── Main-plot playhead ────────────────────────────────────────────────────

  function _placePlayhead() {
    if (mode !== 'time') { playhead.style.display = 'none'; return; }
    const range = brushHi - brushLo;
    if (range <= 0 || innerWidth <= 0) return;
    const frac = (lastT - brushLo) / range;
    if (frac < 0 || frac > 1) { playhead.style.display = 'none'; return; }
    playhead.style.left    = `${innerLeft + frac * innerWidth}px`;
    playhead.style.display = '';
  }

  // ── Overview rebuild ──────────────────────────────────────────────────────

  function _rebuildOverview(width) {
    const w = Math.max(MIN_PLOT_W, Math.floor(width));
    overviewInnerWidth = w - MARGIN.left - MARGIN.right;

    const isTrial = mode === 'trial';
    const { min, max } = _brushDomain();

    const plot = Plot.plot({
      width: w, height: OVERVIEW_HEIGHT,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: 3, marginBottom: 3,
      style: { background: 'transparent', fontFamily: 'inherit', overflow: 'hidden' },
      x: { axis: null, domain: [min, max] },
      y: { axis: null, domain: [0, 1] },
      marks: isTrial ? [
        Plot.areaY(stepDataTrial, { x: 'trial', y1: 0, y2: 'pL',
          fill: COLOR_L, fillOpacity: 0.3, curve: 'step-after' }),
        Plot.areaY(stepDataTrial, { x: 'trial', y1: 0, y2: 'pR',
          fill: COLOR_R, fillOpacity: 0.3, curve: 'step-after' }),
      ] : [
        Plot.lineY(stepData, { x: 't', y: 'pL', stroke: COLOR_L, strokeWidth: 1.5, curve: 'step-after' }),
        Plot.lineY(stepData, { x: 't', y: 'pR', stroke: COLOR_R, strokeWidth: 1.5, curve: 'step-after' }),
      ],
    });
    overviewHolder.replaceChildren(plot);

    Object.assign(overviewInteract.style, {
      position: 'absolute', top: '0', bottom: '0',
      left: `${MARGIN.left}px`, width: `${overviewInnerWidth}px`,
    });

    _updateBrushVisual();
    _placeOverviewPlayhead();
  }

  // ── Main plot rebuild — time mode ─────────────────────────────────────────

  function _rebuildTime(width) {
    const w = Math.max(MIN_PLOT_W, Math.floor(width));
    const plot = Plot.plot({
      width: w, height: PLOT_HEIGHT_TIME,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: MARGIN.top, marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: { label: 'time (s) →', domain: [brushLo, brushHi], grid: false },
      y: {
        label: 'reward probability',
        domain: [0, Y_DOMAIN_MAX],
        ticks: [0, 0.25, 0.5, 0.75, 1],
        tickFormat: d => d > 1 + 1e-9 ? '' : `${Math.round(d * 100)}%`,
        grid: true,
      },
      marks: [
        Plot.rect(trialSpans, { x1: 'x1', x2: 'x2', y1: 0, y2: Y_DOMAIN_MAX,
          fill: d => d.even ? '#fafafa' : '#f2f2f2', stroke: 'none' }),
        Plot.ruleY([1], { stroke: '#bbb', strokeOpacity: 0.7, strokeDasharray: '2,3' }),
        Plot.ruleX(lickL, { x: 't', y1: Y_LICK_L_BOT, y2: Y_LICK_L_TOP,
          stroke: COLOR_L, strokeOpacity: 0.55, strokeWidth: 0.8 }),
        Plot.ruleX(lickR, { x: 't', y1: Y_LICK_R_BOT, y2: Y_LICK_R_TOP,
          stroke: COLOR_R, strokeOpacity: 0.55, strokeWidth: 0.8 }),
        Plot.ruleX(rewardEvents, { x: 't', y1: Y_REW_BOT, y2: Y_REW_TOP,
          stroke: COLOR_REWARD, strokeOpacity: 0.95, strokeWidth: 1.1 }),
        Plot.lineY(stepData, { x: 't', y: 'pL', stroke: COLOR_L, strokeWidth: 1.8, curve: 'step-after' }),
        Plot.lineY(stepData, { x: 't', y: 'pR', stroke: COLOR_R, strokeWidth: 1.8, curve: 'step-after' }),
      ],
    });
    plotHolder.replaceChildren(plot);
    innerLeft  = MARGIN.left;
    innerWidth = w - MARGIN.left - MARGIN.right;
    _placePlayhead();
  }

  // ── Main plot rebuild — trial mode ────────────────────────────────────────

  function _rebuildTrial(width) {
    const w = Math.max(MIN_PLOT_W, Math.floor(width));
    const plot = Plot.plot({
      width: w, height: PLOT_HEIGHT_TRIAL,
      marginLeft: MARGIN.left, marginRight: MARGIN.right,
      marginTop: MARGIN.top, marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: { label: 'trial →', domain: [brushLo - 0.5, brushHi + 0.5], grid: false },
      y: {
        label: 'reward probability',
        domain: [Y_TR_MIN, Y_TR_MAX],
        ticks: [0, 0.25, 0.5, 0.75, 1],
        tickFormat: d => d < 0 || d > 1 + 1e-9 ? '' : `${Math.round(d * 100)}%`,
        grid: true,
      },
      marks: [
        // 100% reference line
        Plot.ruleY([1], { stroke: '#bbb', strokeOpacity: 0.6, strokeDasharray: '2,3' }),

        // pL and pR filled step areas
        Plot.areaY(stepDataTrial, { x: 'trial', y1: 0, y2: 'pL',
          fill: COLOR_L, fillOpacity: 0.28, curve: 'step-after' }),
        Plot.areaY(stepDataTrial, { x: 'trial', y1: 0, y2: 'pR',
          fill: COLOR_R, fillOpacity: 0.28, curve: 'step-after' }),
        Plot.lineY(stepDataTrial, { x: 'trial', y: 'pL',
          stroke: COLOR_L, strokeWidth: 1.5, curve: 'step-after' }),
        Plot.lineY(stepDataTrial, { x: 'trial', y: 'pR',
          stroke: COLOR_R, strokeWidth: 1.5, curve: 'step-after' }),

        // R Choice: grey rects above probability band
        Plot.rect(choiceR, {
          x1: d => d.trial - 0.5, x2: d => d.trial + 0.5,
          y1: Y_RCHOICE_BOT, y2: Y_RCHOICE_TOP, fill: '#999',
        }),
        // L Choice: grey rects below probability band
        Plot.rect(choiceL, {
          x1: d => d.trial - 0.5, x2: d => d.trial + 0.5,
          y1: Y_LCHOICE_BOT, y2: Y_LCHOICE_TOP, fill: '#999',
        }),

        // R Reward: black ticks
        Plot.ruleX(rewardR, { x: 'trial', y1: Y_RREW_BOT, y2: Y_RREW_TOP,
          stroke: '#111', strokeWidth: 1 }),
        // L Reward: blue ticks
        Plot.ruleX(rewardL, { x: 'trial', y1: Y_LREW_BOT, y2: Y_LREW_TOP,
          stroke: COLOR_L, strokeWidth: 1 }),

        // Ignored: purple ticks at top
        Plot.ruleX(ignored, { x: 'trial', y1: Y_IGN_BOT, y2: Y_IGN_TOP,
          stroke: COLOR_IGN, strokeWidth: 1 }),
      ],
    });
    plotHolder.replaceChildren(plot);
    innerLeft  = MARGIN.left;
    innerWidth = w - MARGIN.left - MARGIN.right;
  }

  // ── Dispatch rebuild ──────────────────────────────────────────────────────

  function _rebuild(width) {
    if (mode === 'time') _rebuildTime(width);
    else _rebuildTrial(width);
  }

  // ── Mode switch ───────────────────────────────────────────────────────────

  function _switchMode(newMode) {
    if (newMode === mode) return;
    mode = newMode;

    const { min, max } = _brushDomain();
    brushLo = min;
    brushHi = max;

    rewardLabel.style.display = mode === 'time'  ? '' : 'none';
    licksLabel.style.display  = mode === 'time'  ? '' : 'none';
    trialRowLabels.forEach(l => { l.style.display = mode === 'trial' ? '' : 'none'; });

    scrubOverlay.style.display = mode === 'time' ? '' : 'none';
    playhead.style.display = 'none';

    btnTime.classList.toggle('active',  mode === 'time');
    btnTrial.classList.toggle('active', mode === 'trial');

    _rebuildOverview(lastW);
    _rebuild(lastW);
  }

  btnTime.addEventListener('click',  () => _switchMode('time'));
  btnTrial.addEventListener('click', () => _switchMode('trial'));

  // ── Scrub in main plot (time mode) ────────────────────────────────────────

  scrubOverlay.addEventListener('click', ev => {
    if (!scrubCb || innerWidth <= 0) return;
    const rect = scrubOverlay.getBoundingClientRect();
    const x    = ev.clientX - rect.left - innerLeft;
    const frac = Math.max(0, Math.min(1, x / innerWidth));
    scrubCb(brushLo + frac * (brushHi - brushLo));
  });

  // ── Brush interaction on the overview strip ───────────────────────────────

  overviewInteract.addEventListener('pointermove', ev => {
    const rect = overviewInteract.getBoundingClientRect();
    const px   = ev.clientX - rect.left;
    const d    = _pxToDomain(px);

    if (dragState) {
      if (dragState.type === 'new') {
        brushLo = Math.min(d, dragState.startD);
        brushHi = Math.max(d, dragState.startD);
      } else if (dragState.type === 'left') {
        brushLo = Math.min(d, dragState.anchor);
        brushHi = Math.max(d, dragState.anchor);
      } else if (dragState.type === 'right') {
        brushLo = Math.min(d, dragState.anchor);
        brushHi = Math.max(d, dragState.anchor);
      } else if (dragState.type === 'move') {
        const { min, max } = _brushDomain();
        const span  = dragState.origHi - dragState.origLo;
        const delta = d - dragState.anchorD;
        brushLo = Math.max(min, Math.min(max - span, dragState.origLo + delta));
        brushHi = brushLo + span;
      }
      _updateBrushVisual();
      if (!pendingRebuild) {
        pendingRebuild = true;
        requestAnimationFrame(() => { pendingRebuild = false; _rebuild(lastW); });
      }
    } else {
      const { left: bL, right: bR } = _brushEdgePx();
      const { min, max } = _brushDomain();
      if (Math.abs(px - bL) <= BRUSH_HANDLE_PX || Math.abs(px - bR) <= BRUSH_HANDLE_PX)
        overviewInteract.style.cursor = 'ew-resize';
      else if (px >= bL && px <= bR && (brushLo > min || brushHi < max - 0.5))
        overviewInteract.style.cursor = 'grab';
      else
        overviewInteract.style.cursor = 'crosshair';
    }
  });

  overviewInteract.addEventListener('pointerdown', ev => {
    overviewInteract.setPointerCapture(ev.pointerId);
    const rect = overviewInteract.getBoundingClientRect();
    const px   = ev.clientX - rect.left;
    const d    = _pxToDomain(px);
    const { left: bL, right: bR } = _brushEdgePx();
    const { min, max } = _brushDomain();

    if (Math.abs(px - bL) <= BRUSH_HANDLE_PX) {
      dragState = { type: 'left', anchor: brushHi };
      overviewInteract.style.cursor = 'ew-resize';
    } else if (Math.abs(px - bR) <= BRUSH_HANDLE_PX) {
      dragState = { type: 'right', anchor: brushLo };
      overviewInteract.style.cursor = 'ew-resize';
    } else if (px >= bL && px <= bR && (brushLo > min || brushHi < max - 0.5)) {
      dragState = { type: 'move', anchorD: d, origLo: brushLo, origHi: brushHi };
      overviewInteract.style.cursor = 'grabbing';
    } else {
      dragState = { type: 'new', startD: d };
      brushLo = d; brushHi = d;
      _updateBrushVisual();
      overviewInteract.style.cursor = 'crosshair';
    }
    ev.preventDefault();
  });

  overviewInteract.addEventListener('pointerup', () => {
    if (!dragState) return;
    dragState = null;
    if (brushHi - brushLo < 2) {
      const { min, max } = _brushDomain();
      brushLo = min;
      brushHi = max;
    }
    overviewInteract.style.cursor = 'crosshair';
    _updateBrushVisual();
    _rebuild(lastW);
  });

  overviewInteract.addEventListener('dblclick', () => {
    const { min, max } = _brushDomain();
    brushLo = min;
    brushHi = max;
    _updateBrushVisual();
    _rebuild(lastW);
  });

  // ── ResizeObserver ────────────────────────────────────────────────────────

  const ro = new ResizeObserver(entries => {
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

// ── Private helpers ───────────────────────────────────────────────────────────

function _makeToggleBtn(label, active) {
  const btn = document.createElement('button');
  btn.className = 'df-mode-btn' + (active ? ' active' : '');
  btn.textContent = label;
  return btn;
}

function _makeRowLabel(text, color, rightPx, topPx) {
  const el = document.createElement('div');
  el.className = 'df-row-label';
  el.textContent = text;
  Object.assign(el.style, {
    position: 'absolute', right: 'auto', left: '0',
    width: `${rightPx}px`, top: `${topPx}px`,
    transform: 'translateY(-50%)', textAlign: 'right',
    paddingRight: '8px', fontSize: '10.5px', color,
    fontWeight: '600', pointerEvents: 'none',
    boxSizing: 'border-box', whiteSpace: 'nowrap',
  });
  return el;
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Build time-keyed step data for the probability lines/overview.
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
 * Build trial-number-keyed step data for the trial-mode probability fills.
 */
export function _buildStepDataTrial(trials) {
  const out = [];
  for (const tr of trials) {
    if (!Number.isFinite(tr.trial) || !Number.isFinite(tr.pL) || !Number.isFinite(tr.pR)) continue;
    out.push({ trial: tr.trial, pL: tr.pL, pR: tr.pR });
  }
  return out;
}

/**
 * Split trial rows into per-row raster arrays for the trial-mode view.
 * response: 0=L, 1=R, 2=ignore; earned: 1 if reward was delivered.
 */
export function _buildTrialEventData(trials) {
  const choiceL = [], choiceR = [], ignored = [], rewardL = [], rewardR = [];
  for (const tr of trials) {
    if (!Number.isFinite(tr.trial)) continue;
    const t = { trial: tr.trial };
    if (tr.response === 2 || tr.response == null) {
      ignored.push(t);
    } else if (tr.response === 0) {
      choiceL.push(t);
      if (tr.earned) rewardL.push(t);
    } else if (tr.response === 1) {
      choiceR.push(t);
      if (tr.earned) rewardR.push(t);
    }
  }
  return { choiceL, choiceR, ignored, rewardL, rewardR };
}

/**
 * Split typed-array lick events into per-side arrays of { t } objects.
 */
export function _splitLicks(licks) {
  const lickL = [], lickR = [];
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
 */
export function _splitRewards(rewards) {
  const rewardL = [], rewardR = [];
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

/**
 * dynamic_foraging/prob-plot.js — stacked per-trial event raster styled after
 * the canonical dynamic-foraging session figure, with a moving CSS playhead
 * overlay and a brushable overview strip for zoom/pan.
 *
 * Rows (top → bottom, inside the main Observable Plot):
 *   Ignored   purple ticks at the go-cue of ignored trials
 *   R Reward  black ticks at right-spout reward deliveries
 *   R Choice  grey blocks spanning trials where the animal chose right
 *   p(R)      red step-area filling upward from the centre line
 *   ──────────────────────────────────────────────────────── centre line
 *   p(L)      blue step-area filling downward from the centre line
 *   L Choice  grey blocks spanning trials where the animal chose left
 *   L Reward  black ticks at left-spout reward deliveries
 *
 * Above the main plot sits a compact overview strip (same data, no axes) that
 * has a draggable brush selection — changing the selection zooms the main plot.
 * Double-click the overview to reset to the full range.
 *
 * Row gutter labels are rendered as overlay HTML so we keep the SVG plain.
 */

import * as Plot from '@observablehq/plot';
import { createBrushOverview } from '../lib/behaviors/brush-overview.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLOT_HEIGHT      = 320;
const OVERVIEW_HEIGHT  = 34;    // compact context-chart strip
const COLOR_L          = '#2563eb';     // blue (left) spout
const COLOR_R          = '#dc2626';     // red (right) spout
const COLOR_IGNORED    = '#9333ea';     // purple — ignored trials
const COLOR_EVENT      = 'var(--text-primary, #111111)'; // black in light / white in dark — reward deliveries
const COLOR_CHOICE     = '#8a8a8a';     // grey — choice blocks

const MARGIN           = { left: 88, right: 14, top: 18, bottom: 34 };

// Stacked-row band y-coordinates (bottom → top, in data space). p(L) and p(R)
// share the centre line Y_CENTER and fan out by Y_PROB_SPAN at probability 1.
const Y_CENTER         = 2.95;
const Y_PROB_SPAN      = 1.45;

const Y_LREW_BOT  = 0.00, Y_LREW_TOP  = 0.55;   // L Reward ticks
const Y_LCHO_BOT  = 0.65, Y_LCHO_TOP  = 1.45;   // L Choice blocks
const Y_PL_BOT    = 1.50, Y_PL_TOP    = Y_CENTER;               // p(L) band
const Y_PR_BOT    = Y_CENTER, Y_PR_TOP = Y_CENTER + Y_PROB_SPAN; // p(R) band
const Y_RCHO_BOT  = 4.45, Y_RCHO_TOP  = 5.25;   // R Choice blocks
const Y_RREW_BOT  = 5.35, Y_RREW_TOP  = 5.90;   // R Reward ticks
const Y_IGN_BOT   = 6.00, Y_IGN_TOP   = 6.55;   // Ignored ticks

const Y_DOMAIN_MAX = 6.70;

// Mid-points used for the gutter labels.
const Y_LABEL_IGN  = (Y_IGN_BOT  + Y_IGN_TOP)  / 2;
const Y_LABEL_RREW = (Y_RREW_BOT + Y_RREW_TOP) / 2;
const Y_LABEL_RCHO = (Y_RCHO_BOT + Y_RCHO_TOP) / 2;
const Y_LABEL_PR   = Y_CENTER + Y_PROB_SPAN / 2;
const Y_LABEL_PL   = Y_CENTER - Y_PROB_SPAN / 2;
const Y_LABEL_LCHO = (Y_LCHO_BOT + Y_LCHO_TOP) / 2;
const Y_LABEL_LREW = (Y_LREW_BOT + Y_LREW_TOP) / 2;

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
  const { trials, rewards, sessionEndS } = data;
  const stepData = _buildStepData(trials, sessionEndS);
  const { rewardL, rewardR } = _splitRewards(rewards);
  const ignoredTicks         = _ignoredTrialTicks(trials);
  const { choiceL, choiceR } = _choiceSpans(trials, sessionEndS);

  // Sorted go-cue times for trial-number x-axis labels.
  const trialTimes = trials
    .filter((tr) => Number.isFinite(tr.goCue_t))
    .sort((a, b) => a.goCue_t - b.goCue_t)
    .map((tr) => tr.goCue_t);
  function _trialAtTime(t) {
    let lo = 0, hi = trialTimes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (trialTimes[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  }

  const trialSpans = trials
    .filter((tr) => Number.isFinite(tr.goCue_t))
    .map((tr, i, arr) => ({
      x1: tr.goCue_t,
      x2: i + 1 < arr.length ? arr[i + 1].goCue_t : sessionEndS,
      even: i % 2 === 0,
    }));

  // ===========================================================================
  // Plot builders (marks only — the shared brush component owns the scaffold,
  // zoom/pan brush, playheads and scrubbing).
  // ===========================================================================

  const innerH = PLOT_HEIGHT - MARGIN.top - MARGIN.bottom;
  const yToPx  = (yData) => MARGIN.top + (1 - yData / Y_DOMAIN_MAX) * innerH;

  let xMode = 'time';

  const renderOverview = (holder, w) => {
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
    holder.replaceChildren(plot);
  };

  const renderMain = (holder, w, [t0, t1]) => {
    const plot = Plot.plot({
      width: w,
      height: PLOT_HEIGHT,
      marginLeft:   MARGIN.left,
      marginRight:  MARGIN.right,
      marginTop:    MARGIN.top,
      marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px', color: 'var(--text-primary, #111111)' },
      clip: true,
      x: {
        label: xMode === 'time' ? 'time (s) →' : 'trial →',
        domain: [t0, t1],
        grid: false,
        ...(xMode === 'trials' && trialTimes.length ? { tickFormat: (t) => String(_trialAtTime(t)) } : {}),
      },
      y: {
        axis: null,
        domain: [0, Y_DOMAIN_MAX],
      },
      marks: [
        // Trial span bands (alternating very-light grey)
        Plot.rect(trialSpans, { x1: 'x1', x2: 'x2', y1: 0, y2: Y_DOMAIN_MAX,
          fill: (d) => d.even ? 'var(--df-band-even, #fafafa)' : 'var(--df-band-odd, #f2f2f2)', stroke: 'none' }),

        // Centre reference line shared by p(L) / p(R)
        Plot.ruleY([Y_CENTER], { stroke: '#999', strokeOpacity: 0.6 }),

        // --- Left side (bottom) ---
        Plot.ruleX(rewardL, { x: 't', y1: Y_LREW_BOT, y2: Y_LREW_TOP,
          stroke: COLOR_EVENT, strokeWidth: 1 }),
        Plot.rect(choiceL, { x1: 'x1', x2: 'x2', y1: Y_LCHO_BOT, y2: Y_LCHO_TOP,
          fill: COLOR_CHOICE, fillOpacity: 0.85, stroke: 'none' }),
        Plot.areaY(stepData, { x: 't', y1: Y_PL_TOP,
          y2: (d) => Y_PL_TOP - d.pL * Y_PROB_SPAN,
          curve: 'step-after', fill: COLOR_L, fillOpacity: 0.35 }),
        Plot.lineY(stepData, { x: 't',
          y: (d) => Y_PL_TOP - d.pL * Y_PROB_SPAN,
          stroke: COLOR_L, strokeWidth: 1.4, curve: 'step-after' }),

        // --- Right side (top) ---
        Plot.areaY(stepData, { x: 't', y1: Y_PR_BOT,
          y2: (d) => Y_PR_BOT + d.pR * Y_PROB_SPAN,
          curve: 'step-after', fill: COLOR_R, fillOpacity: 0.35 }),
        Plot.lineY(stepData, { x: 't',
          y: (d) => Y_PR_BOT + d.pR * Y_PROB_SPAN,
          stroke: COLOR_R, strokeWidth: 1.4, curve: 'step-after' }),
        Plot.rect(choiceR, { x1: 'x1', x2: 'x2', y1: Y_RCHO_BOT, y2: Y_RCHO_TOP,
          fill: COLOR_CHOICE, fillOpacity: 0.85, stroke: 'none' }),
        Plot.ruleX(rewardR, { x: 't', y1: Y_RREW_BOT, y2: Y_RREW_TOP,
          stroke: COLOR_EVENT, strokeWidth: 1 }),

        // Ignored trials (top)
        Plot.ruleX(ignoredTicks, { x: 't', y1: Y_IGN_BOT, y2: Y_IGN_TOP,
          stroke: COLOR_IGNORED, strokeWidth: 1.2 }),
      ],
    });
    holder.replaceChildren(plot);
  };

  const bz = createBrushOverview({
    sessionEndS,
    margin: { left: MARGIN.left, right: MARGIN.right },
    overviewHeight: OVERVIEW_HEIGHT,
    minPlotW: MIN_PLOT_W,
    scrubInset: { top: MARGIN.top - 6, bottom: MARGIN.bottom - 4 },
    wrapperClass: 'df-prob-plot-wrap',
    renderOverview,
    renderMain,
  });

  // Overview hint overlay (kept from the original DF look).
  const overviewHint = document.createElement('div');
  overviewHint.className = 'df-brush-hint';
  overviewHint.innerHTML = 'Click + drag<br>to zoom';
  bz.overviewWrap.appendChild(overviewHint);

  // Row-label overlays positioned in the gutter.
  const ROW_LABELS = [
    ['Ignored',  COLOR_IGNORED, Y_LABEL_IGN],
    ['R Reward', COLOR_R,       Y_LABEL_RREW],
    ['R Choice', COLOR_R,       Y_LABEL_RCHO],
    ['p(R)',     COLOR_R,       Y_LABEL_PR],
    ['p(L)',     COLOR_L,       Y_LABEL_PL],
    ['L Choice', COLOR_L,       Y_LABEL_LCHO],
    ['L Reward', COLOR_L,       Y_LABEL_LREW],
  ];
  for (const [text, color, yData] of ROW_LABELS) {
    bz.mainWrap.appendChild(_makeRowLabel(text, color, MARGIN.left - 6, yToPx(yData)));
  }

  // X-axis mode toggle — returned so the caller can place it wherever it likes.
  const xToggle = document.createElement('div');
  xToggle.className = 'df-x-toggle';
  const _xBtns = {};
  for (const mode of ['time', 'trials']) {
    const btn = document.createElement('button');
    btn.className = 'df-x-toggle-btn' + (mode === 'time' ? ' df-x-toggle-btn--active' : '');
    btn.textContent = mode === 'time' ? 'Time' : 'Trials';
    btn.addEventListener('click', () => {
      if (xMode === mode) return;
      xMode = mode;
      _xBtns.time.classList.toggle('df-x-toggle-btn--active', mode === 'time');
      _xBtns.trials.classList.toggle('df-x-toggle-btn--active', mode === 'trials');
      bz.redrawMain();
    });
    _xBtns[mode] = btn;
    xToggle.appendChild(btn);
  }

  return {
    element: bz.element,
    toggleEl: xToggle,
    updatePlayhead: bz.updatePlayhead,
    setOnScrub: bz.setOnScrub,
    dispose: bz.dispose,
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

/**
 * Build per-trial choice spans for the L/R "choice" raster rows. Each trial is
 * drawn as a block from its go-cue to the next trial's go-cue (or sessionEndS
 * for the final trial). Trials with no response (ignore) contribute nothing.
 *
 * @param {object[]} trials   normalized trial rows (response: 0=L, 1=R, 2=ignore)
 * @param {number}   sessionEndS
 * @returns {{choiceL:{x1:number,x2:number}[], choiceR:{x1:number,x2:number}[]}}
 */
export function _choiceSpans(trials, sessionEndS) {
  const cues = trials
    .filter((tr) => Number.isFinite(tr.goCue_t))
    .sort((a, b) => a.goCue_t - b.goCue_t);
  const choiceL = [];
  const choiceR = [];
  for (let i = 0; i < cues.length; i++) {
    const tr = cues[i];
    const x1 = tr.goCue_t;
    const x2 = i + 1 < cues.length ? cues[i + 1].goCue_t : sessionEndS;
    if (tr.response === 0) choiceL.push({ x1, x2 });
    else if (tr.response === 1) choiceR.push({ x1, x2 });
  }
  return { choiceL, choiceR };
}

/**
 * Timestamps (at the go-cue) of trials the animal ignored (response === 2).
 *
 * @param {object[]} trials
 * @returns {{t:number}[]}
 */
export function _ignoredTrialTicks(trials) {
  const out = [];
  for (const tr of trials) {
    if (tr.response === 2 && Number.isFinite(tr.goCue_t)) out.push({ t: tr.goCue_t });
  }
  return out;
}

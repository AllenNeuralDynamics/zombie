/**
 * dynamic_foraging/prob-plot.js — reward-probability trace + raster, with a
 * moving CSS playhead overlay.
 *
 * Layout (top → bottom, inside one Observable Plot):
 *   1.21 ┌─────────────────────────────────────────────────  Rewards row (cyan)
 *   1.13 ├─────────────────────────────────────────────────  R-lick row (red)
 *   1.06 ├─────────────────────────────────────────────────  L-lick row (blue)
 *   1.00 ├─────────────────────────────────────────────────  100 %
 *        │  pL (blue) and pR (red) step-after lines
 *   0.00 └─────────────────────────────────────────────────   0 %
 *
 * The y-axis only labels the 0 %–100 % band — the three raster rows above sit
 * in an extended domain but don't get tick labels (axis filter on `<= 1`).
 *
 * Row gutter labels ("Rewards" / "Licks") are rendered as overlay HTML so we
 * can keep the SVG plain.
 */

import * as Plot from '@observablehq/plot';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLOT_HEIGHT      = 260;
const COLOR_L          = '#2563eb';     // matches the blue (left) spout
const COLOR_R          = '#dc2626';     // matches the red (right) spout
const COLOR_REWARD     = '#06b6d4';     // light blue (cyan) for reward deliveries

const MARGIN           = { left: 76, right: 14, top: 28, bottom: 34 };

// Row band y-coordinates (in extended data-space).
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

const MIN_PLOT_W       = 320;

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
  const rewardEvents = _eventsToObjects(rewards?.t);

  const wrapper = document.createElement('div');
  wrapper.className = 'df-prob-plot-wrap';

  const plotHolder = document.createElement('div');
  plotHolder.className = 'df-prob-plot-holder';
  wrapper.appendChild(plotHolder);

  // Row-label overlays — positioned in pixel space so they sit in the gutter.
  const innerH = PLOT_HEIGHT - MARGIN.top - MARGIN.bottom;
  const yToPx = (yData) => MARGIN.top + (1 - yData / Y_DOMAIN_MAX) * innerH;

  const rewardLabel = _makeRowLabel('Rewards', COLOR_REWARD, MARGIN.left - 6, yToPx(Y_LABEL_REW));
  const licksLabel  = _makeRowLabel('Licks',   '#444',       MARGIN.left - 6, yToPx(Y_LABEL_LICKS));
  wrapper.appendChild(rewardLabel);
  wrapper.appendChild(licksLabel);

  // Playhead — vertical bar across the entire plot area.
  const playhead = document.createElement('div');
  playhead.className = 'df-playhead';
  Object.assign(playhead.style, {
    position: 'absolute',
    top: `${MARGIN.top - 6}px`,
    bottom: `${MARGIN.bottom - 4}px`,
    width: '1.5px',
    background: '#222',
    pointerEvents: 'none',
    transform: 'translateX(-0.75px)',
    left: '0',
    display: 'none',
  });
  wrapper.appendChild(playhead);

  // Click-to-scrub overlay covering the plot area.
  const scrubOverlay = document.createElement('div');
  scrubOverlay.className = 'df-prob-scrub-overlay';
  Object.assign(scrubOverlay.style, {
    position: 'absolute',
    top: `${MARGIN.top - 6}px`,
    bottom: `${MARGIN.bottom - 4}px`,
    left: '0',
    right: '0',
    cursor: 'crosshair',
  });
  wrapper.appendChild(scrubOverlay);

  let innerLeft  = MARGIN.left;
  let innerWidth = 0;
  let scrubCb    = null;
  let lastT      = 0;

  function _placePlayhead() {
    if (sessionEndS <= 0 || innerWidth <= 0) return;
    const frac = Math.max(0, Math.min(1, lastT / sessionEndS));
    playhead.style.left = `${innerLeft + frac * innerWidth}px`;
    playhead.style.display = '';
  }

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
      x: {
        label: 'time (s) →',
        domain: [0, sessionEndS],
        grid: false,
      },
      y: {
        label: 'reward probability',
        domain: [0, Y_DOMAIN_MAX],
        ticks: [0, 0.25, 0.5, 0.75, 1],
        // Format as percent; suppress any tick that Plot might place above 1.
        tickFormat: (d) => (d > 1 + 1e-9 ? '' : `${Math.round(d * 100)}%`),
        grid: true,
      },
      marks: [
        // 100 % reference (dashed)
        Plot.ruleY([1], { stroke: '#bbb', strokeOpacity: 0.7, strokeDasharray: '2,3' }),

        // Raster rows — draw BEFORE the probability lines so the lines paint
        // over any vertical overlap inside the [0, 1] band (shouldn't happen,
        // but cheap safety).
        Plot.ruleX(lickL, { x: 't', y1: Y_LICK_L_BOT, y2: Y_LICK_L_TOP,
          stroke: COLOR_L, strokeOpacity: 0.55, strokeWidth: 0.8 }),
        Plot.ruleX(lickR, { x: 't', y1: Y_LICK_R_BOT, y2: Y_LICK_R_TOP,
          stroke: COLOR_R, strokeOpacity: 0.55, strokeWidth: 0.8 }),
        Plot.ruleX(rewardEvents, { x: 't', y1: Y_REW_BOT, y2: Y_REW_TOP,
          stroke: COLOR_REWARD, strokeOpacity: 0.95, strokeWidth: 1.1 }),

        // Step lines
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

  scrubOverlay.addEventListener('click', (ev) => {
    if (!scrubCb || innerWidth <= 0) return;
    const rect = scrubOverlay.getBoundingClientRect();
    const x = ev.clientX - rect.left - innerLeft;
    const frac = Math.max(0, Math.min(1, x / innerWidth));
    scrubCb(frac * sessionEndS);
  });

  // Resize observer — rebuilds the plot when the container width changes.
  let lastW = 0;
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.max(MIN_PLOT_W, Math.floor(e.contentRect.width));
      if (w !== lastW) { lastW = w; _rebuild(w); }
    }
  });
  ro.observe(wrapper);

  queueMicrotask(() => {
    const w = Math.max(MIN_PLOT_W, wrapper.clientWidth || 600);
    if (w !== lastW) { lastW = w; _rebuild(w); }
  });

  return {
    element: wrapper,
    updatePlayhead(t) { lastT = t; _placePlayhead(); },
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
    right: `auto`,
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
 * Split typed-array lick events into per-side arrays of `{ t }` objects
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
 * Convert a (possibly typed) array of event timestamps into `[{t}]` rows.
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

/**
 * mfish/event-plot.js — session event plot for the Learning mFISH player.
 *
 * Uses the shared zoomable overview + brush strip (lib/behaviors/brush-overview
 * .js) — the same component the other behavior playback plots use — so zoom /
 * resize / pan / cursors all behave identically. This module only supplies the
 * marks: an overview strip (stimulus bands + change ticks) and a main event
 * plot with one row per stream: rewards, licks, stimulus changes, stimuli
 * (coloured by orientation for gratings), and a de-emphasized running trace
 * (the running wheel is incidental to the task).
 *
 * Public API mirrors dynamic_routing/event-plot.js:
 *   createMfishEventPlot(data) → { element, updatePlayhead, setOnScrub, dispose }
 */

import * as Plot from '@observablehq/plot';
import { oriColor } from './animation.js';
import { createBrushOverview } from '../lib/behaviors/brush-overview.js';

const OVERVIEW_HEIGHT = 34;
const PLOT_HEIGHT = 232;
const MARGIN = { left: 74, right: 14, top: 14, bottom: 30 };
const MIN_PLOT_W = 320;

// Row bands in the main plot's [0,1] y-space (top → bottom).
const ROWS = {
  reward:  { lo: 0.88, hi: 0.99, color: '#06b6d4', label: 'Reward' },
  lick:    { lo: 0.72, hi: 0.83, color: '#374151', label: 'Lick' },
  change:  { lo: 0.56, hi: 0.67, color: '#db2777', label: 'Change' },
  stim:    { lo: 0.34, hi: 0.50, color: '#6366f1', label: 'Stimulus' },
  running: { lo: 0.02, hi: 0.26, color: '#9ca3af', label: 'Running' },
};
const Y_DOMAIN = [0, 1];

export function createMfishEventPlot(data) {
  const { stimuli, changes, running, rewards, licks, sessionEndS } = data;
  const isGratingStage = (data.stageMode ?? data.variant) === 'gratings';

  // -- Data shaping ------------------------------------------------------
  const stimBands = stimuli
    .filter((s) => !s.omitted)
    .map((s) => ({
      x1: s.t,
      x2: Math.max(s.tEnd, s.t + 0.05),
      ori: isGratingStage ? s.ori : null,
    }));
  const changeRows = Array.from(changes, (t) => ({ t }));
  const rewardRows = Array.from(rewards, (t) => ({ t }));
  const lickRows = licks ? Array.from(licks, (t) => ({ t })) : [];

  // Running is de-emphasized: scaled into its own small bottom band.
  let vMin = 0, vMax = 1;
  for (let i = 0; i < running.v.length; i++) {
    const v = running.v[i];
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  const vSpan = vMax - vMin || 1;
  const runRows = [];
  for (let i = 0; i < running.t.length; i++) {
    const y = ROWS.running.lo + ((running.v[i] - vMin) / vSpan) * (ROWS.running.hi - ROWS.running.lo);
    runRows.push({ t: running.t[i], y });
  }

  const hasLicks = lickRows.length > 0;

  // -- Overview marks (bands + change ticks) -----------------------------
  const renderOverview = (holder, w) => {
    const plot = Plot.plot({
      width: w,
      height: OVERVIEW_HEIGHT,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      marginTop: 3,
      marginBottom: 3,
      style: { background: 'transparent', fontFamily: 'inherit', overflow: 'hidden' },
      x: { axis: null, domain: [0, sessionEndS] },
      y: { axis: null, domain: [0, 1] },
      marks: [
        Plot.rect(stimBands, { x1: 'x1', x2: 'x2', y1: 0, y2: 1, fill: (d) => (d.ori != null ? oriColor(d.ori) : '#6366f1'), fillOpacity: 0.25, stroke: 'none' }),
        Plot.ruleX(changeRows, { x: 't', y1: 0, y2: 1, stroke: ROWS.change.color, strokeOpacity: 0.55, strokeWidth: 0.6 }),
      ],
    });
    holder.replaceChildren(plot);
  };

  // -- Main event-row marks ----------------------------------------------
  const renderMain = (holder, w, [t0, t1]) => {
    const marks = [
      // Stimuli (coloured by orientation for gratings; single hue for images).
      Plot.rect(stimBands, {
        x1: 'x1', x2: 'x2', y1: ROWS.stim.lo, y2: ROWS.stim.hi,
        fill: (d) => (d.ori != null ? oriColor(d.ori) : '#6366f1'), fillOpacity: 0.6, stroke: 'none',
      }),
      // Change onsets (faint full-height for cross-row alignment + a solid row tick).
      Plot.ruleX(changeRows, { x: 't', y1: Y_DOMAIN[0], y2: Y_DOMAIN[1], stroke: ROWS.change.color, strokeOpacity: 0.12, strokeWidth: 0.8 }),
      Plot.ruleX(changeRows, { x: 't', y1: ROWS.change.lo, y2: ROWS.change.hi, stroke: ROWS.change.color, strokeWidth: 1 }),
      // Rewards.
      Plot.ruleX(rewardRows, { x: 't', y1: ROWS.reward.lo, y2: ROWS.reward.hi, stroke: ROWS.reward.color, strokeWidth: 1.2 }),
      // Running (faint, de-emphasized).
      Plot.line(runRows, { x: 't', y: 'y', stroke: ROWS.running.color, strokeWidth: 0.6, strokeOpacity: 0.7 }),
    ];
    if (hasLicks) {
      marks.push(Plot.ruleX(lickRows, { x: 't', y1: ROWS.lick.lo, y2: ROWS.lick.hi, stroke: ROWS.lick.color, strokeOpacity: 0.5, strokeWidth: 0.5 }));
    }
    const plot = Plot.plot({
      width: w,
      height: PLOT_HEIGHT,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      marginTop: MARGIN.top,
      marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: { label: 'time (s) →', domain: [t0, t1], grid: false },
      y: { axis: null, domain: Y_DOMAIN },
      marks,
    });
    holder.replaceChildren(plot);
  };

  const bz = createBrushOverview({
    sessionEndS,
    margin: { left: MARGIN.left, right: MARGIN.right },
    overviewHeight: OVERVIEW_HEIGHT,
    minPlotW: MIN_PLOT_W,
    scrubInset: { top: MARGIN.top - 4, bottom: MARGIN.bottom - 4 },
    wrapperClass: 'mfish-evt-plot-wrap',
    renderOverview,
    renderMain,
  });

  // Row labels in the main gutter.
  const innerH = PLOT_HEIGHT - MARGIN.top - MARGIN.bottom;
  const yToPx = (y) => MARGIN.top + (1 - y) * innerH;
  for (const key of ['reward', 'lick', 'change', 'stim', 'running']) {
    if (key === 'lick' && !hasLicks) continue;
    const r = ROWS[key];
    const el = document.createElement('div');
    el.textContent = r.label;
    Object.assign(el.style, {
      position: 'absolute', left: '0', width: `${MARGIN.left - 8}px`, textAlign: 'right',
      top: `${yToPx((r.lo + r.hi) / 2) - 7}px`,
      fontSize: '10px', color: r.color, pointerEvents: 'none', fontWeight: '600',
    });
    bz.mainWrap.appendChild(el);
  }

  return {
    element: bz.element,
    updatePlayhead: bz.updatePlayhead,
    setOnScrub: bz.setOnScrub,
    dispose: bz.dispose,
  };
}

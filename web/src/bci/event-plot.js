/**
 * bci/event-plot.js — standard zoomable BCI event plot.
 *
 * The plot deliberately uses the same brush/overview primitive as the other
 * behavior players. The overview is the context row; dragging a range there
 * rebuilds the detailed event panel below it, while the main-panel overlay
 * scrubs the shared playback transport.
 */

import * as Plot from '@observablehq/plot';
import { createBrushOverview } from '../lib/behaviors/brush-overview.js';

const OVERVIEW_HEIGHT = 34;
const PLOT_HEIGHT = 238;
const MARGIN = { left: 86, right: 14, top: 14, bottom: 32 };
const MIN_PLOT_W = 320;

const ROWS = {
  trial: { lo: 0.84, hi: 0.98, color: '#22c55e', label: 'Trial' },
  goCue: { lo: 0.69, hi: 0.78, color: '#64748b', label: 'Go cue' },
  steps: { lo: 0.54, hi: 0.63, color: '#0ea5e9', label: 'Spout steps' },
  threshold: { lo: 0.39, hi: 0.48, color: '#16a34a', label: 'Threshold' },
  lick: { lo: 0.24, hi: 0.33, color: '#db2777', label: 'Lick' },
  reward: { lo: 0.09, hi: 0.18, color: '#0284c7', label: 'Reward' },
};
const Y_DOMAIN = [0, 1];

function eventRows(data) {
  return {
    goCues: data.goCues ?? [],
    zaberSteps: data.zaberSteps ?? [],
    thresholdCrossings: data.thresholdCrossings ?? [],
    licks: data.licks ?? [],
    rewards: data.rewards ?? [],
  };
}

export function createBciEventPlot(data) {
  const { goCues, zaberSteps, thresholdCrossings, licks, rewards } = eventRows(data);
  const trials = data.trials ?? [];

  const renderOverview = (holder, width) => {
    const plot = Plot.plot({
      width,
      height: OVERVIEW_HEIGHT,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      marginTop: 3,
      marginBottom: 3,
      style: { background: 'transparent', fontFamily: 'inherit', overflow: 'hidden' },
      x: { axis: null, domain: [0, data.sessionEnd] },
      y: { axis: null, domain: Y_DOMAIN },
      marks: [
        Plot.ruleX(goCues, { x: 't', y1: 0.68, y2: 0.79, stroke: ROWS.goCue.color, strokeOpacity: 0.7 }),
      ],
    });
    holder.replaceChildren(plot);
  };

  const renderMain = (holder, width, [t0, t1]) => {
    const plot = Plot.plot({
      width,
      height: PLOT_HEIGHT,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      marginTop: MARGIN.top,
      marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: { label: 'session time (s) →', domain: [t0, t1], grid: true },
      y: { axis: null, domain: Y_DOMAIN },
      marks: [
        Plot.rect(trials, {
          x1: 'start', x2: 'stop', y1: ROWS.trial.lo, y2: ROWS.trial.hi,
          fill: (trial) => trial.hit ? '#bbf7d0' : '#e2e8f0',
          fillOpacity: 0.8,
          stroke: 'none',
        }),
        Plot.ruleX(goCues, { x: 't', y1: ROWS.goCue.lo, y2: ROWS.goCue.hi, stroke: ROWS.goCue.color, strokeWidth: 1.2 }),
        Plot.ruleX(zaberSteps, { x: 't', y1: ROWS.steps.lo, y2: ROWS.steps.hi, stroke: ROWS.steps.color, strokeWidth: 1.2 }),
        Plot.ruleX(thresholdCrossings, { x: 't', y1: ROWS.threshold.lo, y2: ROWS.threshold.hi, stroke: ROWS.threshold.color, strokeWidth: 1.8 }),
        Plot.ruleX(licks, { x: 't', y1: ROWS.lick.lo, y2: ROWS.lick.hi, stroke: ROWS.lick.color, strokeOpacity: 0.7, strokeWidth: 1 }),
        Plot.ruleX(rewards, { x: 't', y1: ROWS.reward.lo, y2: ROWS.reward.hi, stroke: ROWS.reward.color, strokeWidth: 1.6 }),
      ],
    });
    holder.replaceChildren(plot);
  };

  const brush = createBrushOverview({
    sessionEndS: data.sessionEnd,
    margin: { left: MARGIN.left, right: MARGIN.right },
    overviewHeight: OVERVIEW_HEIGHT,
    minPlotW: MIN_PLOT_W,
    scrubInset: { top: MARGIN.top, bottom: MARGIN.bottom },
    playheadColor: '#dc2626',
    wrapperClass: 'bci-evt-plot-wrap',
    renderOverview,
    renderMain,
  });

  const hint = document.createElement('div');
  hint.className = 'bci-brush-hint';
  hint.innerHTML = 'Click + drag<br>to zoom';
  brush.overviewWrap.appendChild(hint);

  const innerHeight = PLOT_HEIGHT - MARGIN.top - MARGIN.bottom;
  const yToPx = (value) => MARGIN.top + (1 - value) * innerHeight;
  for (const row of Object.values(ROWS)) {
    const label = document.createElement('div');
    label.className = 'bci-row-label';
    label.textContent = row.label;
    Object.assign(label.style, {
      top: `${yToPx((row.lo + row.hi) / 2) - 7}px`,
      color: row.color,
    });
    brush.mainWrap.appendChild(label);
  }

  return {
    element: brush.element,
    updatePlayhead: brush.updatePlayhead,
    setOnScrub: brush.setOnScrub,
    dispose: brush.dispose,
  };
}

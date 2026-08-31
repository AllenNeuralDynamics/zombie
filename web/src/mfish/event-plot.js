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
 * An optional cell-subclass mean-activity row can be added below Running via
 * `setSubclassActivity` (or the `subclassActivity` constructor option) — used
 * by the Visual Learning SWDB page once its dF/F reads resolve, which happen
 * after this plot is already built. It lives in negative y-space below the
 * fixed five rows, so every other caller of createMfishEventPlot (e.g. the
 * subject-timeline Event Details panel) that never supplies it renders
 * pixel-identically to before.
 *
 * Public API mirrors dynamic_routing/event-plot.js:
 *   createMfishEventPlot(data) → { element, updatePlayhead, setOnScrub,
 *   setOnDomainChange, setDomain, setSubclassActivity, dispose }
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

// Extra row for per-cell-subclass mean activity, below Running in negative
// y-space (so the fixed rows above never need to be renumbered).
const SUBCLASS_ROW_GAP = 0.10;
const SUBCLASS_ROW_HEIGHT = 0.32;
const SUBCLASS_ROW = {
  lo: -(SUBCLASS_ROW_GAP + SUBCLASS_ROW_HEIGHT),
  hi: -SUBCLASS_ROW_GAP,
  label: 'Cell activity',
};
const SUBCLASS_PALETTE = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

export function createMfishEventPlot(data, { onDomainChange = null, subclassActivity = null } = {}) {
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

  // -- Optional cell-subclass activity row --------------------------------
  let currentSubclassActivity = subclassActivity;
  let subclasses = [];
  let subclassColor = new Map();
  let subclassLineRows = [];
  let yDomain = Y_DOMAIN;
  let plotHeight = PLOT_HEIGHT;

  function recomputeSubclassLayout() {
    const rows = currentSubclassActivity?.rows ?? [];
    subclasses = (currentSubclassActivity?.subclasses ?? [])
      .filter((subclass) => rows.some((row) => row.cell_subclass === subclass));
    subclassColor = new Map(subclasses.map((subclass, index) => [subclass, SUBCLASS_PALETTE[index % SUBCLASS_PALETTE.length]]));
    subclassLineRows = [];
    if (subclasses.length) {
      const bySubclass = new Map(subclasses.map((subclass) => [subclass, []]));
      for (const row of rows) bySubclass.get(row.cell_subclass)?.push(row);
      for (const [subclass, subclassRows] of bySubclass) {
        if (!subclassRows.length) continue;
        let lo = Infinity, hi = -Infinity;
        for (const row of subclassRows) {
          if (row.activity < lo) lo = row.activity;
          if (row.activity > hi) hi = row.activity;
        }
        const span = (hi - lo) || 1;
        for (const row of subclassRows) {
          const y = SUBCLASS_ROW.lo + ((row.activity - lo) / span) * (SUBCLASS_ROW.hi - SUBCLASS_ROW.lo);
          subclassLineRows.push({ t: row.t, y, subclass });
        }
      }
    }
    yDomain = subclasses.length ? [SUBCLASS_ROW.lo, Y_DOMAIN[1]] : Y_DOMAIN;
    const domainSpanRatio = (yDomain[1] - yDomain[0]) / (Y_DOMAIN[1] - Y_DOMAIN[0]);
    const innerHBase = PLOT_HEIGHT - MARGIN.top - MARGIN.bottom;
    plotHeight = subclasses.length ? MARGIN.top + MARGIN.bottom + innerHBase * domainSpanRatio : PLOT_HEIGHT;
  }
  recomputeSubclassLayout();

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
      Plot.ruleX(changeRows, { x: 't', y1: yDomain[0], y2: yDomain[1], stroke: ROWS.change.color, strokeOpacity: 0.12, strokeWidth: 0.8 }),
      Plot.ruleX(changeRows, { x: 't', y1: ROWS.change.lo, y2: ROWS.change.hi, stroke: ROWS.change.color, strokeWidth: 1 }),
      // Rewards.
      Plot.ruleX(rewardRows, { x: 't', y1: ROWS.reward.lo, y2: ROWS.reward.hi, stroke: ROWS.reward.color, strokeWidth: 1.2 }),
      // Running (faint, de-emphasized).
      Plot.line(runRows, { x: 't', y: 'y', stroke: ROWS.running.color, strokeWidth: 0.6, strokeOpacity: 0.7 }),
    ];
    if (hasLicks) {
      marks.push(Plot.ruleX(lickRows, { x: 't', y1: ROWS.lick.lo, y2: ROWS.lick.hi, stroke: ROWS.lick.color, strokeOpacity: 0.5, strokeWidth: 0.5 }));
    }
    if (subclasses.length) {
      marks.push(Plot.ruleY([SUBCLASS_ROW.hi], { stroke: '#d1d5db', strokeOpacity: 0.5, strokeWidth: 0.5 }));
      marks.push(Plot.line(subclassLineRows, { x: 't', y: 'y', z: 'subclass', stroke: 'subclass', strokeWidth: 1 }));
    }
    const plotConfig = {
      width: w,
      height: plotHeight,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      marginTop: MARGIN.top,
      marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: { label: 'time (s) →', domain: [t0, t1], grid: false },
      y: { axis: null, domain: yDomain },
      marks,
    };
    if (subclasses.length) {
      plotConfig.color = { domain: subclasses, range: subclasses.map((subclass) => subclassColor.get(subclass)) };
    }
    const plot = Plot.plot(plotConfig);
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
  if (onDomainChange) bz.setOnDomainChange(onDomainChange);

  // Row labels (+ a compact subclass color key) in the main gutter. Rebuilt
  // in full whenever the subclass row appears/disappears, since every fixed
  // row's pixel offset shifts along with the taller/shorter plot height.
  let rowLabelEls = [];
  function renderRowLabels() {
    rowLabelEls.forEach((el) => el.remove());
    rowLabelEls = [];
    const innerH = plotHeight - MARGIN.top - MARGIN.bottom;
    const yToPx = (y) => MARGIN.top + ((yDomain[1] - y) / (yDomain[1] - yDomain[0])) * innerH;
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
      rowLabelEls.push(el);
    }
    if (subclasses.length) {
      const label = document.createElement('div');
      label.textContent = SUBCLASS_ROW.label;
      Object.assign(label.style, {
        position: 'absolute', left: '0', width: `${MARGIN.left - 8}px`, textAlign: 'right',
        top: `${yToPx(SUBCLASS_ROW.hi) - 7}px`,
        fontSize: '10px', color: '#4b5563', pointerEvents: 'none', fontWeight: '600',
      });
      bz.mainWrap.appendChild(label);
      rowLabelEls.push(label);

      const legend = document.createElement('div');
      Object.assign(legend.style, {
        position: 'absolute', left: `${MARGIN.left}px`, right: `${MARGIN.right}px`,
        top: `${yToPx(SUBCLASS_ROW.hi) - 7}px`,
        display: 'flex', flexWrap: 'wrap', gap: '0.5rem', pointerEvents: 'none', fontSize: '9px',
      });
      subclasses.forEach((subclass) => {
        const swatch = document.createElement('span');
        swatch.textContent = subclass;
        swatch.style.color = subclassColor.get(subclass);
        swatch.style.fontWeight = '600';
        legend.appendChild(swatch);
      });
      bz.mainWrap.appendChild(legend);
      rowLabelEls.push(legend);
    }
  }
  renderRowLabels();

  return {
    element: bz.element,
    updatePlayhead: bz.updatePlayhead,
    setOnScrub: bz.setOnScrub,
    setOnDomainChange: bz.setOnDomainChange,
    setDomain: bz.setDomain,
    /** Add/replace the per-cell-subclass mean-activity row below Running. */
    setSubclassActivity(series) {
      currentSubclassActivity = series;
      recomputeSubclassLayout();
      renderRowLabels();
      bz.redrawMain();
    },
    dispose: bz.dispose,
  };
}

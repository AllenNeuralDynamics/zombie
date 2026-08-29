/**
 * swdb/dr-switch-plot.js — trial-timing plot for the block-switch replay.
 *
 * Mirrors the visual language of the behavior playback plots (dynamic_routing's
 * event-plot.js: block bands, event ticks, a moving playhead, click/drag-to-
 * scrub) but deliberately skips the zoomable overview strip those use — the
 * window here is exactly 5 trials, always shown in full, so a zoom/pan brush
 * has nothing useful to do.
 *
 * The x-axis is the shared *template* position (see `platform_swdb_dr_switch.py`):
 * every one of the 5 block-switch trials is linearly time-warped onto its own
 * unit-width slot, so trial boundaries always sit at integers 0..5 regardless
 * of real trial duration. The 5 trials are drawn as 5 visually distinct panels
 * (alternating shading, a solid divider at every boundary, and each panel
 * titled with its own trial name) — never collapsed onto a single continuous
 * axis, which would smear together events that land at different real times in
 * different instances. There is no numeric x-axis: the panel titles and
 * dividers are the only position reference, so nothing competes with them for
 * "where am I" the way an axis tick placed at a panel's center previously did
 * (it read as another event, easily confused with the real stim/response/
 * reward ticks inside that panel). Within each panel, a small blue box marks
 * the (warped) stimulus epoch and ticks mark response/reward events from
 * `platform_swdb_dr_switch_markers`, plus the population-mean firing rate of
 * whatever units are currently loaded.
 */

import * as Plot from '@observablehq/plot';

const COLOR_VIS = '#7c3aed'; // purple — visual rule (matches dynamic_routing/event-plot.js)
const COLOR_AUD = '#f59e0b'; // amber — auditory rule
const COLOR_STIM = '#1e40af'; // stimulus epoch
const COLOR_RESP = '#374151'; // response tick
const COLOR_REWARD = '#06b6d4'; // reward tick
const COLOR_MEAN_RATE = '#111827';
const COLOR_SWITCH_RULE = '#111';
const COLOR_TRIAL_RULE = '#555';

const N_TRIALS = 5;
const SWITCH_SLOT = 2; // trial_offset 0 (the switch trial) occupies slot 2
// Alternating panel-shading opacity, indexed by slot 0..4 — makes each of the
// 5 trials read as its own panel rather than 2 undifferentiated blocks.
const PANEL_OPACITY = [0.16, 0.06, 0.2, 0.06, 0.16];

const MARGIN = { left: 52, right: 14, top: 10, bottom: 8 };
const HEIGHT = 190;
const MIN_WIDTH = 280;

// Everything above the actual rate line lives in a headroom band, scaled to
// whatever range the loaded units' rates span (this axis is real Hz, not the
// 0..1 fraction event-plot.js's response-rate plot uses, so rows can't sit at
// a fixed y like [1.02, 1.08]). Bottom to top: stim epoch, response, reward,
// then the panel title above all of them.
const RATE_HEADROOM = 1.6;
const Y_STIM = [1.05, 1.12];
const Y_RESP = [1.16, 1.23];
const Y_REWARD = [1.27, 1.34];
const Y_LABEL = 1.5;

function modalityColor(mod) {
  return mod === 'aud' ? COLOR_AUD : COLOR_VIS;
}

function panelTitle(offset) {
  return offset === 0 ? 'SWITCH TRIAL' : `trial ${offset > 0 ? '+' : ''}${offset}`;
}

/** Population mean rate per bin, across whatever units are currently loaded. */
function meanRateSeries(activityRows) {
  const byBin = new Map();
  for (const row of activityRows) {
    const t = Number(row.template_x);
    const rate = Number(row.mean_rate_hz);
    const entry = byBin.get(t);
    if (entry) { entry.sum += rate; entry.n += 1; }
    else byBin.set(t, { sum: rate, n: 1 });
  }
  return [...byBin.entries()]
    .map(([t, { sum, n }]) => ({ t, rate: sum / n }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Build the trial-timing + activity plot.
 *
 * @param {object} params
 * @param {string} params.direction - 'vis_to_aud' | 'aud_to_vis'
 * @param {object[]} params.markers - rows from loadSwdbDrSwitchMarkers, one per trial_offset.
 * @param {object[]} params.activityRows - rows from loadSwdbDrSwitchActivity.
 * @returns {{element: HTMLElement, domain: [number, number], updatePlayhead: Function, setOnScrub: Function, dispose: Function}}
 */
export function createDrSwitchPlot({ direction, markers, activityRows }) {
  const [oldMod, newMod] = direction.split('_to_');
  const sorted = [...markers].sort((a, b) => a.trial_offset - b.trial_offset);
  const domain = [0, N_TRIALS];

  const bands = sorted.map((marker, i) => {
    const slot = marker.trial_offset + SWITCH_SLOT;
    return {
      x1: slot, x2: slot + 1,
      mod: marker.trial_offset < 0 ? oldMod : newMod,
      opacity: PANEL_OPACITY[i] ?? 0.1,
    };
  });
  const meanSeries = meanRateSeries(activityRows);
  const stimSpans = sorted.map((m) => ({ x1: m.stim_on_x, x2: m.stim_off_x }));
  const responses = sorted.filter((m) => m.response_frac > 0).map((m) => ({ x: m.response_x, frac: m.response_frac }));
  const rewards = sorted.filter((m) => m.reward_frac > 0).map((m) => ({ x: m.reward_x, frac: m.reward_frac }));
  const titles = sorted.map((m) => ({ x: m.trial_offset + SWITCH_SLOT + 0.5, offset: m.trial_offset }));

  const peakRate = Math.max(1e-6, ...meanSeries.map((d) => d.rate));
  const yDomainMax = peakRate * RATE_HEADROOM;
  const [yStim, yResp, yRew] = [Y_STIM, Y_RESP, Y_REWARD].map(([lo, hi]) => [peakRate * lo, peakRate * hi]);
  const yLabel = peakRate * Y_LABEL;

  const element = document.createElement('div');
  element.className = 'swdb-dr-switch-plot';

  const legend = document.createElement('div');
  legend.className = 'swdb-dr-switch-legend';
  legend.innerHTML = `
    <span class="swdb-dr-switch-legend-item"><span class="swdb-dr-switch-swatch" style="background:${COLOR_STIM}"></span>stimulus</span>
    <span class="swdb-dr-switch-legend-item"><span class="swdb-dr-switch-swatch" style="background:${COLOR_RESP}"></span>response</span>
    <span class="swdb-dr-switch-legend-item"><span class="swdb-dr-switch-swatch" style="background:${COLOR_REWARD}"></span>reward</span>
    <span class="swdb-dr-switch-legend-item"><span class="swdb-dr-switch-swatch" style="background:${COLOR_MEAN_RATE}"></span>mean rate (Hz)</span>
  `;
  element.appendChild(legend);

  const holder = document.createElement('div');
  element.appendChild(holder);

  const playhead = document.createElement('div');
  playhead.className = 'swdb-dr-switch-playhead';
  Object.assign(playhead.style, {
    position: 'absolute', top: `${MARGIN.top}px`, bottom: `${MARGIN.bottom}px`,
    width: '1.5px', background: COLOR_SWITCH_RULE, pointerEvents: 'none',
    transform: 'translateX(-0.75px)', left: '0', display: 'none',
  });
  element.appendChild(playhead);

  const scrubOverlay = document.createElement('div');
  scrubOverlay.className = 'swdb-dr-switch-scrub-overlay';
  Object.assign(scrubOverlay.style, {
    position: 'absolute', top: `${MARGIN.top}px`, bottom: `${MARGIN.bottom}px`,
    left: `${MARGIN.left}px`, right: `${MARGIN.right}px`, cursor: 'crosshair',
  });
  element.appendChild(scrubOverlay);

  let innerWidth = 0;
  let scrubCb = null;
  let lastT = domain[0];

  function placePlayhead() {
    const [t0, t1] = domain;
    const frac = (lastT - t0) / (t1 - t0);
    if (!(frac >= 0) || frac > 1 || innerWidth <= 0) { playhead.style.display = 'none'; return; }
    playhead.style.left = `${MARGIN.left + frac * innerWidth}px`;
    playhead.style.display = '';
  }

  function render(width) {
    innerWidth = width - MARGIN.left - MARGIN.right;
    const plot = Plot.plot({
      width,
      height: HEIGHT,
      marginLeft: MARGIN.left,
      marginRight: MARGIN.right,
      marginTop: MARGIN.top,
      marginBottom: MARGIN.bottom,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      clip: true,
      x: { domain, axis: null },
      y: {
        label: 'mean rate (Hz) ↑',
        domain: [0, yDomainMax],
        tickFormat: (d) => (d > peakRate * 1.02 ? '' : d),
        grid: true,
        zero: true,
      },
      marks: [
        // 5 alternating-shade panels, one per trial — the primary "these are
        // separate trials" cue, not a thin axis tick.
        Plot.rect(bands, {
          x1: 'x1', x2: 'x2', y1: 0, y2: yDomainMax,
          fill: (d) => modalityColor(d.mod),
          fillOpacity: (d) => d.opacity,
          stroke: 'none',
        }),
        // A solid divider at every trial boundary; the switch boundary (x=2,
        // where the outgoing block's last trial ends and the incoming block's
        // first trial begins) is bolder and darker than the rest.
        Plot.ruleX([0, 1, 3, 4, 5], { stroke: COLOR_TRIAL_RULE, strokeOpacity: 0.55, strokeWidth: 1.2 }),
        Plot.ruleX([SWITCH_SLOT], { stroke: COLOR_SWITCH_RULE, strokeOpacity: 0.9, strokeWidth: 2.5 }),
        // Per-trial title, well above every event tick so it never competes
        // with them for "where is this in time" the way an axis tick did.
        Plot.text(titles, {
          x: 'x',
          y: yLabel,
          text: (d) => panelTitle(d.offset),
          fontSize: (d) => (d.offset === 0 ? 10.5 : 10),
          fontWeight: (d) => (d.offset === 0 ? 700 : 500),
          fill: (d) => (d.offset === 0 ? COLOR_SWITCH_RULE : '#666'),
        }),
        // Stimulus epoch, response, reward (warped to the same template axis).
        Plot.rect(stimSpans, { x1: 'x1', x2: 'x2', y1: yStim[0], y2: yStim[1], fill: COLOR_STIM }),
        Plot.ruleX(responses, {
          x: 'x', y1: yResp[0], y2: yResp[1], stroke: COLOR_RESP, strokeWidth: 1.6,
          strokeOpacity: (d) => 0.35 + 0.65 * d.frac,
        }),
        Plot.ruleX(rewards, {
          x: 'x', y1: yRew[0], y2: yRew[1], stroke: COLOR_REWARD, strokeWidth: 1.8,
          strokeOpacity: (d) => 0.35 + 0.65 * d.frac,
        }),
        // Population mean rate, on the real Hz axis below the event-tick headroom.
        Plot.lineY(meanSeries, { x: 't', y: 'rate', stroke: COLOR_MEAN_RATE, strokeWidth: 1.6 }),
      ],
    });
    holder.replaceChildren(plot);
    placePlayhead();
  }

  function seekAt(clientX) {
    if (!scrubCb) return;
    const rect = scrubOverlay.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    scrubCb(domain[0] + frac * (domain[1] - domain[0]));
  }
  let scrubbing = false;
  scrubOverlay.addEventListener('pointerdown', (ev) => {
    scrubbing = true;
    scrubOverlay.setPointerCapture?.(ev.pointerId);
    seekAt(ev.clientX);
  });
  scrubOverlay.addEventListener('pointermove', (ev) => { if (scrubbing) seekAt(ev.clientX); });
  const endScrub = (ev) => { scrubbing = false; scrubOverlay.releasePointerCapture?.(ev.pointerId); };
  scrubOverlay.addEventListener('pointerup', endScrub);
  scrubOverlay.addEventListener('pointercancel', endScrub);

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) render(Math.max(MIN_WIDTH, Math.floor(entry.contentRect.width)));
  });
  resizeObserver.observe(element);
  queueMicrotask(() => render(Math.max(MIN_WIDTH, element.clientWidth || 600)));

  return {
    element,
    domain,
    updatePlayhead(t) {
      lastT = t;
      placePlayhead();
    },
    setOnScrub(cb) {
      scrubCb = cb;
    },
    dispose() {
      resizeObserver.disconnect();
    },
  };
}

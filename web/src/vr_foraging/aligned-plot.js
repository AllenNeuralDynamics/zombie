/**
 * vr_foraging/aligned-plot.js — event-aligned stream averages for one session.
 *
 * Ported from the VR-Foraging dashboard's `viz/aligned.py` (`build_aligned`)
 * to Observable Plot. Averages a stream (velocity or lick rate) in a fixed
 * window around each occurrence of an event (reward onset or choice cue),
 * optionally grouped by patch label, and draws the mean ± 95% CI per group.
 */

import * as Plot from '@observablehq/plot';
import { computeVelocity } from './trace-plot.js';
import { patchColor, VELOCITY_TRACE_COLOR } from './theme.js';

const WINDOW = [-2.0, 2.0];
const BIN_WIDTH = 0.05;

const EVENTS = {
  reward_onset: { key: 'reward_onset_time_s', label: 'Reward onset' },
  choice_cue:   { key: 'choice_cue_time_s',   label: 'Choice cue' },
};

/** Lower-bound binary search: first index in sorted `arr` with arr[i] >= x. */
function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Velocity stream as {times[], values[]} sorted by time. */
function velocityStream(traces) {
  const v = computeVelocity(traces.pos_t, traces.pos_cm, BIN_WIDTH);
  return { times: v.map((d) => d.t), values: v.map((d) => d.v) };
}

/** Lick-rate stream (Hz) binned over the session, as {times[], values[]}. */
function lickRateStream(traces, t0, t1) {
  const licks = (traces.lick_t ?? []).filter(Number.isFinite);
  const times = [];
  const values = [];
  if (!(t1 > t0)) return { times, values };
  const n = Math.ceil((t1 - t0) / BIN_WIDTH);
  const counts = new Float64Array(n);
  for (const t of licks) {
    const bi = Math.floor((t - t0) / BIN_WIDTH);
    if (bi >= 0 && bi < n) counts[bi] += 1;
  }
  for (let i = 0; i < n; i++) {
    times.push(t0 + (i + 0.5) * BIN_WIDTH);
    values.push(counts[i] / BIN_WIDTH);
  }
  return { times, values };
}

/**
 * Bin each event snippet onto a shared grid; return per-bin mean + 95% CI.
 * @returns {{time:number, mean:number, lower:number, upper:number}[]}
 */
function summarize(stream, eventTimes) {
  const edges = [];
  for (let e = WINDOW[0]; e <= WINDOW[1] + 1e-9; e += BIN_WIDTH) edges.push(e);
  const nBins = edges.length - 1;
  const acc = Array.from({ length: nBins }, () => []);

  for (const ev of eventTimes) {
    const lo = lowerBound(stream.times, ev + WINDOW[0]);
    const hi = lowerBound(stream.times, ev + WINDOW[1]);
    for (let i = lo; i < hi; i++) {
      const rel = stream.times[i] - ev;
      const bin = Math.floor((rel - WINDOW[0]) / BIN_WIDTH);
      if (bin >= 0 && bin < nBins) acc[bin].push(stream.values[i]);
    }
  }

  const out = [];
  for (let i = 0; i < nBins; i++) {
    const vals = acc[i];
    if (vals.length === 0) continue;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    let sd = 0;
    if (vals.length > 1) {
      const varr = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1);
      sd = Math.sqrt(varr);
    }
    const ci = 1.96 * sd / Math.sqrt(vals.length);
    const center = edges[i] + BIN_WIDTH / 2;
    out.push({ time: center, mean, lower: mean - ci, upper: mean + ci });
  }
  return out;
}

/**
 * Build the event-aligned average widget.
 *
 * @param {object} data
 * @param {object[]} data.sites  - Trial/site rows from the NWB loader.
 * @param {object}   data.traces - { pos_t, pos_cm, lick_t }.
 * @returns {{ element: HTMLElement }}
 */
export function createAlignedPlot({ sites, traces }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'vrf-altview vrf-aligned';

  const t0 = sites.length ? sites[0].start_time_s : 0;
  const t1 = sites.length ? sites[sites.length - 1].stop_time_s : 0;

  const streams = {
    velocity:  { label: 'Velocity (cm/s)', build: () => velocityStream(traces) },
    lick_rate: { label: 'Lick rate (Hz)',  build: () => lickRateStream(traces, t0, t1) },
  };

  const controls = document.createElement('div');
  controls.className = 'vrf-altview-controls';
  controls.innerHTML = `
    <label>Stream
      <select class="al-stream">
        <option value="velocity">Velocity</option>
        <option value="lick_rate">Lick rate</option>
      </select>
    </label>
    <label>Align to
      <select class="al-event">
        <option value="reward_onset">Reward onset</option>
        <option value="choice_cue">Choice cue</option>
      </select>
    </label>
    <label class="al-group-label">
      <input type="checkbox" class="al-group" /> Group by patch
    </label>
  `;
  wrapper.appendChild(controls);

  const plotHolder = document.createElement('div');
  plotHolder.className = 'vrf-altview-plot';
  wrapper.appendChild(plotHolder);

  const streamSel = controls.querySelector('.al-stream');
  const eventSel  = controls.querySelector('.al-event');
  const groupChk  = controls.querySelector('.al-group');

  // Assign a stable colour index to each patch label (alphabetical).
  const labelOrder = [...new Set(sites.map((s) => String(s.patch_label ?? '')))].sort();
  const labelColor = new Map(labelOrder.map((l, i) => [l, patchColor(i)]));

  function render() {
    const streamKey = streamSel.value;
    const eventKey = EVENTS[eventSel.value].key;
    const groupByPatch = groupChk.checked;
    const stream = streams[streamKey].build();

    const valid = sites.filter((s) => Number.isFinite(s[eventKey]));

    // groups: [{ name, color, eventTimes }]
    const groups = [];
    if (groupByPatch) {
      const byLabel = new Map();
      for (const s of valid) {
        const lbl = String(s.patch_label ?? '');
        if (!byLabel.has(lbl)) byLabel.set(lbl, []);
        byLabel.get(lbl).push(s[eventKey]);
      }
      for (const lbl of [...byLabel.keys()].sort()) {
        groups.push({ name: lbl, color: labelColor.get(lbl) ?? patchColor(0), eventTimes: byLabel.get(lbl) });
      }
    } else {
      groups.push({ name: 'All', color: VELOCITY_TRACE_COLOR, eventTimes: valid.map((s) => s[eventKey]) });
    }

    const bandRows = [];
    const lineRows = [];
    const colorDomain = [];
    const colorRange = [];
    for (const g of groups) {
      const summary = summarize(stream, g.eventTimes);
      if (summary.length === 0) continue;
      const key = `${g.name} (n=${g.eventTimes.length})`;
      colorDomain.push(key);
      colorRange.push(g.color);
      for (const d of summary) {
        bandRows.push({ time: d.time, lower: d.lower, upper: d.upper, group: key });
        lineRows.push({ time: d.time, mean: d.mean, group: key });
      }
    }

    const fig = Plot.plot({
      width: Math.max(360, plotHolder.clientWidth || 700),
      height: 360,
      marginLeft: 56,
      marginRight: 16,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      x: { label: 'Time from event (s)', domain: WINDOW, grid: true },
      y: { label: streams[streamKey].label, grid: true },
      color: { domain: colorDomain, range: colorRange, legend: true },
      marks: [
        Plot.areaY(bandRows, {
          x: 'time', y1: 'lower', y2: 'upper',
          fill: 'group', fillOpacity: 0.18,
        }),
        Plot.lineY(lineRows, { x: 'time', y: 'mean', stroke: 'group', strokeWidth: 2 }),
        Plot.ruleX([0], { stroke: '#000', strokeWidth: 1, strokeDasharray: '3,3' }),
      ],
    });

    plotHolder.innerHTML = '';
    if (bandRows.length === 0) {
      plotHolder.innerHTML = '<p class="vrf-altview-empty">No events to align for this selection.</p>';
      return;
    }
    plotHolder.appendChild(fig);
  }

  streamSel.addEventListener('change', render);
  eventSel.addEventListener('change', render);
  groupChk.addEventListener('change', render);

  requestAnimationFrame(render);

  return { element: wrapper };
}

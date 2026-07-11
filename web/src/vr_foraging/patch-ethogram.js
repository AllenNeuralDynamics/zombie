/**
 * vr_foraging/patch-ethogram.js — per-patch stacked ethogram for one session.
 *
 * Ported from the VR-Foraging dashboard's `viz/patch_ethogram.py`
 * (`build_patch_ethogram`) to Observable Plot. Each row is one patch; x is
 * time relative to the patch's align anchor (start of its first non-inter
 * site). Every row shows:
 *   • site-coloured bands (reward sites per-patch colour, corridors grey)
 *   • a normalised running-velocity overlay
 *   • Choice / Reward / Force-reward / Lick event markers
 *   • a block-boundary tick at x=0 for the first patch of each block
 *
 * A small control row selects the patch window (count + start) and Y order.
 */

import * as Plot from '@observablehq/plot';
import { computeVelocity } from './trace-plot.js';
import {
  CHOICE_COLOR, REWARD_COLOR, LICK_COLOR, VELOCITY_COLOR, siteColor,
} from './theme.js';

const ROW_HEIGHT = 0.8;          // fraction of 1.0 each row occupies
const FORCE_REWARD_COLOR = '#9467bd';
const BLOCK_SEPARATOR_COLOR = '#555555';
const DEFAULT_WINDOW = 20;       // patches shown at once

function isInterSite(label) {
  return String(label ?? '').toLowerCase().startsWith('inter');
}

/** Group site rows into ordered patches keyed by `patch_index`. */
function groupPatches(sites) {
  const byIndex = new Map();
  for (const s of sites) {
    const pi = s.patch_index;
    if (pi == null) continue;
    if (!byIndex.has(pi)) byIndex.set(pi, []);
    byIndex.get(pi).push(s);
  }
  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  return indices.map((pi) => {
    const rows = byIndex.get(pi).slice().sort((a, b) => a.start_time_s - b.start_time_s);
    return { patchIndex: pi, rows };
  });
}

/** Anchor time for a patch: start of its first non-inter site (else first site). */
function patchAnchor(rows) {
  const odor = rows.find((r) => !isInterSite(r.site_label));
  return (odor ?? rows[0]).start_time_s;
}

/**
 * Build the per-patch ethogram widget.
 *
 * @param {object} data
 * @param {object[]} data.sites - Trial/site rows from the NWB loader.
 * @param {object}   data.traces - { pos_t, pos_cm, lick_t, force_reward_t }.
 * @returns {{ element: HTMLElement }}
 */
export function createPatchEthogram({ sites, traces }) {
  const wrapper = document.createElement('div');
  wrapper.className = 'vrf-altview vrf-patch-ethogram';

  const patches = groupPatches(sites);
  const vel = computeVelocity(traces.pos_t, traces.pos_cm, 0.1);
  const licks = (traces.lick_t ?? []).filter(Number.isFinite);
  const forceRewards = (traces.force_reward_t ?? []).filter(Number.isFinite);

  if (patches.length === 0) {
    wrapper.innerHTML = '<p class="vrf-altview-empty">No patch data for this session.</p>';
    return { element: wrapper };
  }

  // ---- Controls -----------------------------------------------------------
  const controls = document.createElement('div');
  controls.className = 'vrf-altview-controls';
  controls.innerHTML = `
    <label>Patches
      <input type="number" class="pe-count" min="1" max="${patches.length}"
             value="${Math.min(DEFAULT_WINDOW, patches.length)}" />
    </label>
    <label class="pe-start-label">Start
      <input type="range" class="pe-start" min="0"
             max="${Math.max(0, patches.length - 1)}" step="1" value="0" />
      <span class="pe-start-val">0</span>
    </label>
    <label class="pe-invert-label">
      <input type="checkbox" class="pe-invert" checked /> Invert Y
    </label>
  `;
  wrapper.appendChild(controls);

  const plotHolder = document.createElement('div');
  plotHolder.className = 'vrf-altview-plot';
  wrapper.appendChild(plotHolder);

  const countInput  = controls.querySelector('.pe-count');
  const startInput  = controls.querySelector('.pe-start');
  const startVal    = controls.querySelector('.pe-start-val');
  const invertInput = controls.querySelector('.pe-invert');

  function render() {
    let count = parseInt(countInput.value, 10);
    if (!Number.isFinite(count) || count < 1) count = 1;
    count = Math.min(count, patches.length);
    const maxStart = Math.max(0, patches.length - 1);
    let start = parseInt(startInput.value, 10) || 0;
    start = Math.min(start, maxStart);
    startInput.max = String(maxStart);
    startVal.textContent = String(start);
    const invertY = invertInput.checked;

    const shown = patches.slice(start, start + count);
    const nRows = shown.length;

    const bands = [];
    const velLines = [];
    const choiceMk = [];
    const rewardMk = [];
    const forceMk  = [];
    const lickMk   = [];
    const blockMk  = [];
    const yTicks = new Map();
    let prevBlock = null;

    shown.forEach((patch, rowIdx) => {
      const displayRow = invertY ? (nRows - 1 - rowIdx) : rowIdx;
      const y0 = displayRow;
      const y1 = displayRow + ROW_HEIGHT;
      const yc = displayRow + ROW_HEIGHT / 2;
      const anchor = patchAnchor(patch.rows);
      const label = String(patch.rows[0]?.patch_label ?? '');
      yTicks.set(yc, `${label} / ${patch.patchIndex}`);

      for (const s of patch.rows) {
        const x0 = s.start_time_s - anchor;
        const x1b = s.stop_time_s - anchor;
        if (!(x1b > x0)) continue;
        bands.push({ x1: x0, x2: x1b, y1: y0, y2: y1, color: siteColor(s.site_label, s.patch_index) });
      }

      // Velocity overlay, normalised to the row height.
      const t0p = patch.rows[0].start_time_s;
      const t1p = patch.rows[patch.rows.length - 1].stop_time_s;
      const win = vel.filter((d) => d.t >= t0p && d.t <= t1p);
      const vmax = win.reduce((m, d) => Math.max(m, d.v), 0) || 1;
      for (const d of win) {
        velLines.push({ x: d.t - anchor, y: y0 + (d.v / vmax) * ROW_HEIGHT, row: displayRow });
      }

      const inPatch = (t) => t >= t0p && t <= t1p;
      for (const s of patch.rows) {
        if (s.has_choice && Number.isFinite(s.choice_cue_time_s)) {
          choiceMk.push({ x: s.choice_cue_time_s - anchor, y: yc });
        }
        if (s.has_reward && Number.isFinite(s.reward_onset_time_s)) {
          rewardMk.push({ x: s.reward_onset_time_s - anchor, y: yc });
        }
      }
      for (const t of forceRewards) if (inPatch(t)) forceMk.push({ x: t - anchor, y: yc });
      for (const t of licks)        if (inPatch(t)) lickMk.push({ x: t - anchor, y: yc });

      // Block boundary tick at x=0 for the first patch of a new block.
      const blk = patch.rows[0]?.block_index;
      if (blk != null && blk !== prevBlock) {
        blockMk.push({ x: 0, y1: displayRow, y2: displayRow + ROW_HEIGHT });
        prevBlock = blk;
      }
    });

    const tickVals = [...yTicks.keys()].sort((a, b) => a - b);

    const fig = Plot.plot({
      width: Math.max(360, plotHolder.clientWidth || 700),
      height: Math.max(240, 60 + 48 * nRows),
      marginLeft: 130,
      marginRight: 16,
      marginTop: 28,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      x: { label: 'Time from align event (s)', grid: false },
      y: {
        domain: [-0.1, nRows + 0.1],
        ticks: tickVals,
        tickFormat: (v) => yTicks.get(v) ?? '',
        label: null,
        grid: false,
      },
      marks: [
        Plot.rect(bands, {
          x1: 'x1', x2: 'x2', y1: 'y1', y2: 'y2',
          fill: 'color', fillOpacity: 0.45,
        }),
        Plot.ruleX(blockMk, {
          x: 'x', y1: 'y1', y2: 'y2',
          stroke: BLOCK_SEPARATOR_COLOR, strokeWidth: 2, strokeDasharray: '2,2',
        }),
        Plot.line(velLines, { x: 'x', y: 'y', z: 'row', stroke: VELOCITY_COLOR, strokeWidth: 1 }),
        Plot.dot(choiceMk, { x: 'x', y: 'y', symbol: 'square', fill: CHOICE_COLOR, r: 3 }),
        Plot.dot(rewardMk, { x: 'x', y: 'y', symbol: 'circle', fill: REWARD_COLOR, r: 3 }),
        Plot.dot(forceMk,  { x: 'x', y: 'y', symbol: 'circle', fill: FORCE_REWARD_COLOR, r: 3 }),
        Plot.ruleX(lickMk, { x: 'x', y1: (d) => d.y - 0.12, y2: (d) => d.y + 0.12, stroke: LICK_COLOR, strokeWidth: 1 }),
        Plot.ruleX([0], { stroke: '#888', strokeWidth: 0.5 }),
      ],
    });

    plotHolder.innerHTML = '';
    plotHolder.appendChild(fig);
  }

  countInput.addEventListener('input', render);
  startInput.addEventListener('input', render);
  invertInput.addEventListener('change', render);

  // Defer the first render until the holder has a measured width.
  requestAnimationFrame(render);

  return { element: wrapper };
}

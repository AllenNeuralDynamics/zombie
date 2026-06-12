/**
 * vr_foraging/depletion.js — tiny per-patch reward-probability bar chart.
 *
 * Renders a horizontal bar plot of P(reward) for every reward site in the
 * current patch, recoloured by visit state (past reward / past omission /
 * upcoming / current).
 */

import * as Plot from '@observablehq/plot';

const ACCENT          = '#f39c12';
const REWARD_COLOR    = '#2980b9';
const NOREWARD_COLOR  = '#c0392b';
const CURRENT_OUTLINE = '#111111';

/** Pre-index reward sites by patch_index for fast per-frame lookup. */
export function buildPatchIndex(sites) {
  const m = new Map();
  for (const s of sites) {
    if (s.site_label !== 'RewardSite') continue;
    if (!m.has(s.patch_index)) m.set(s.patch_index, []);
    m.get(s.patch_index).push(s);
  }
  return m;
}

/** Render (or re-render) the depletion mini-chart into `el`. */
export function updateDepletion(el, patchIndex, currentSite) {
  const patchSites = patchIndex.get(currentSite.patch_index) ?? [];
  if (patchSites.length === 0) { el.replaceChildren(); return; }

  const rp    = currentSite.reward_probability;
  const rpStr = rp != null ? `${(rp * 100).toFixed(1)}%` : '–';

  const label = document.createElement('div');
  label.className = 'vrf-prew';
  label.innerHTML = `Current P(rew) <b>${rpStr}</b>`;

  const chart = Plot.plot({
    width:        270,
    height:       80,
    marginLeft:   30,
    marginBottom: 20,
    marginTop:    6,
    marginRight:  4,
    style: { background: 'transparent', color: '#666', fontFamily: 'inherit', fontSize: 10 },
    x: { label: null, axis: null },
    y: { label: 'P', domain: [0, 1], ticks: [0, 0.5, 1] },
    marks: [
      Plot.barY(patchSites, {
        x: 'site_by_type_in_patch_index',
        y: (d) => d.reward_probability ?? 0,
        fill: (d) => {
          if (d.site_index === currentSite.site_index) return CURRENT_OUTLINE;
          if (d.start_time_s >= currentSite.start_time_s) return ACCENT;
          return d.has_reward ? REWARD_COLOR : NOREWARD_COLOR;
        },
        title: (d) =>
          `site ${d.site_by_type_in_patch_index + 1}: P=${((d.reward_probability ?? 0) * 100).toFixed(0)}%`,
      }),
    ],
  });
  el.replaceChildren(label, chart);
}

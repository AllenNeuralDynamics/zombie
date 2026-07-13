/**
 * vr_foraging/theme.js — colours shared by the corridor animation and the
 * running-velocity trace plot. Ported from the VR-Foraging dashboard
 * viz/theme.py so the corridor and the plot always agree.
 */

export const PATCH_COLORMAP = [
  '#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d',
];
export const INTERPATCH_COLOR   = '#A9A9A9';
export const INTERSITE_COLOR    = '#4C4C4C';
export const UNKNOWN_SITE_COLOR = '#CCCCCC';

export const CHOICE_COLOR   = '#d62728';
export const REWARD_COLOR   = '#1f77b4';
export const LICK_COLOR     = '#2ca02c';
export const VELOCITY_COLOR = '#222222';
export const VELOCITY_TRACE_COLOR = '#e11d48';

/** Stable colour for a patch by its (instance) index. */
export function patchColor(index) {
  const n = PATCH_COLORMAP.length;
  return PATCH_COLORMAP[(((index | 0) % n) + n) % n];
}

/** Colour a track segment: reward sites per-patch, others grey. */
export function siteColor(siteLabel, patchIndex) {
  const label = String(siteLabel ?? '').toLowerCase();
  if (label.includes('reward'))     return patchColor(patchIndex);
  if (label.includes('interpatch')) return INTERPATCH_COLOR;
  if (label.includes('intersite'))  return INTERSITE_COLOR;
  return UNKNOWN_SITE_COLOR;
}

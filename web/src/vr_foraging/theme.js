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

/** True when the page is in dark mode (explicit data-theme, else OS preference). */
export function isDarkMode() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark') return true;
  if (t === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

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

// ---------------------------------------------------------------------------
// Odor palette — colours keyed by ODOR IDENTITY (patch_label), so the same
// odor (e.g. "odor_90") always gets the same colour across the corridor, the
// legend, the trace bands, the ethogram, the depletion chart and the aligned
// view. Highest odor probability gets orange, lowest gets purple; middle ranks
// fill in with green, blue, red. Deterministic given a session's site list.
// ---------------------------------------------------------------------------

const ODOR_ORANGE = '#e67e22';
const ODOR_GREEN  = '#27ae60';
const ODOR_PURPLE = '#8e44ad';
const ODOR_BLUE   = '#2980b9';
const ODOR_RED    = '#c0392b';

const ODOR_PALETTES = {
  1: [ODOR_ORANGE],
  2: [ODOR_ORANGE, ODOR_PURPLE],
  3: [ODOR_ORANGE, ODOR_GREEN, ODOR_PURPLE],
  4: [ODOR_ORANGE, ODOR_GREEN, ODOR_BLUE, ODOR_PURPLE],
  5: [ODOR_ORANGE, ODOR_GREEN, ODOR_BLUE, ODOR_RED, ODOR_PURPLE],
};
const ODOR_FALLBACK = [ODOR_ORANGE, ODOR_GREEN, ODOR_BLUE, ODOR_RED, ODOR_PURPLE, '#16a085', '#d35400'];

function parseOdorProb(label) {
  if (label == null) return null;
  const m = String(label).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * Build a Map<patch_label, color> keyed by odor identity. Labels are ranked by
 * odor probability (highest → orange) so the assignment is stable and each
 * distinct odor gets a distinct colour.
 */
export function buildOdorPalette(sites) {
  const labels = new Set();
  for (const s of sites) {
    if (s.site_label === 'InterPatch') continue;
    if (s.patch_label != null) labels.add(s.patch_label);
  }
  const sorted = [...labels].sort((a, b) => {
    const pa = parseOdorProb(a);
    const pb = parseOdorProb(b);
    if (pa == null && pb == null) return String(a).localeCompare(String(b));
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pb - pa;
  });
  const colors = ODOR_PALETTES[sorted.length] ?? ODOR_FALLBACK;
  const map = new Map();
  sorted.forEach((label, i) => {
    map.set(label, colors[i] ?? ODOR_FALLBACK[i % ODOR_FALLBACK.length]);
  });
  return map;
}

/**
 * Colour a track band by odor identity: reward sites use the odor palette
 * (same colour for same odor name), non-reward segments keep their greys.
 */
export function odorBandColor(site, palette) {
  const label = String(site.site_label ?? '').toLowerCase();
  if (label.includes('reward')) return palette.get(site.patch_label) ?? UNKNOWN_SITE_COLOR;
  if (label.includes('interpatch')) return INTERPATCH_COLOR;
  if (label.includes('intersite'))  return INTERSITE_COLOR;
  return UNKNOWN_SITE_COLOR;
}

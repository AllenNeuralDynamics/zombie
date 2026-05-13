/**
 * credit-helpers.js — Shared utilities for CRediT taxonomy helpers.
 *
 * This module contains helper functions and constants for working with
 * CRediT (Contributor Roles Taxonomy) roles and visualizations.
 */

/** All 14 CRediT taxonomy roles in canonical display order. */
export const CREDIT_ROLES = [
  'Conceptualization',
  'Methodology',
  'Software',
  'Validation',
  'Formal analysis',
  'Investigation',
  'Resources',
  'Data curation',
  'Writing – original draft',
  'Writing – review & editing',
  'Visualization',
  'Supervision',
  'Project Administration',
  'Funding Acquisition',
];

/**
 * Normalize a CRediT role string for comparison.
 * Converts to lowercase, collapses whitespace, and normalizes dashes.
 * @param {string} r
 * @returns {string}
 */
export function normalizeRole(r) {
  return r.toLowerCase().replace(/\s+/g, ' ').replace(/\u2014/g, '\u2013').trim();
}

/** Role → semantic group mapping. */
export const ROLE_GROUP = (() => {
  const m = {};
  for (const r of ['Conceptualization', 'Supervision', 'Project Administration', 'Funding Acquisition'])
    m[normalizeRole(r)] = 'leadership';
  for (const r of ['Methodology', 'Resources']) m[normalizeRole(r)] = 'methods';
  for (const r of ['Validation', 'Investigation', 'Data curation']) m[normalizeRole(r)] = 'data';
  for (const r of [
    'Formal analysis',
    'Software',
    'Writing – original draft',
    'Writing – review & editing',
    'Visualization',
  ])
    m[normalizeRole(r)] = 'analysis';
  return m;
})();

/** Hue [center, halfSpread] per group (degrees). */
export const GROUP_HUE = {
  leadership: [252, 32],
  methods: [41, 22],
  data: [165, 28],
  analysis: [340, 22],
};

/**
 * Simple deterministic string hash.
 * @param {string} s
 * @returns {number}
 */
export function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

/**
 * Compute an HSL color for an author based on their majority CRediT group.
 *
 * @param {{ name: string, credit_levels?: Array<{role:string,level:string}> }} author
 * @param {Array} allAuthors — full list for co-contributor weighting
 * @returns {string} CSS hsl() color
 */
export function authorColor(author, allAuthors = []) {
  const counts = { leadership: 0, methods: 0, data: 0, analysis: 0 };
  const ownRoles = new Set();
  if (author.credit_levels) {
    for (const cl of author.credit_levels) {
      if (!cl.role) continue;
      const norm = normalizeRole(cl.role);
      ownRoles.add(norm);
      const grp = ROLE_GROUP[norm];
      if (grp) counts[grp]++;
    }
  }
  if (allAuthors.length > 0 && ownRoles.size > 0) {
    for (const other of allAuthors) {
      if (other.name === author.name || !other.credit_levels) continue;
      const shares = other.credit_levels.some((cl) => ownRoles.has(normalizeRole(cl.role)));
      if (!shares) continue;
      for (const cl of other.credit_levels) {
        if (!cl.role) continue;
        const grp = ROLE_GROUP[normalizeRole(cl.role)];
        if (grp) counts[grp] += 0.1;
      }
    }
  }
  const best = Math.max(counts.leadership, counts.methods, counts.data, counts.analysis);
  let group;
  if (best === 0) {
    group = ['leadership', 'methods', 'data', 'analysis'][hashStr(author.name) % 4];
  } else {
    const tied = Object.entries(counts)
      .filter(([, v]) => v === best)
      .map(([k]) => k);
    group = tied.length === 1 ? tied[0] : tied[hashStr(author.name) % tied.length];
  }
  const h1 = hashStr(author.name);
  const h2 = hashStr(author.name + '~');
  const [hCenter, hHalf] = GROUP_HUE[group];
  const hue = ((hCenter - hHalf + (h1 % (hHalf * 2 + 1))) + 360) % 360;
  const sat = 62 + (h2 % 18);
  const lgt = 40 + ((h1 >> 6) % 14);
  return `hsl(${hue},${sat}%,${lgt}%)`;
}

/**
 * Get 1-2 character initials from a full name.
 * @param {string} name
 * @returns {string}
 */
export function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Get last name from a full name.
 * @param {string} name
 * @returns {string}
 */
export function getLastName(name) {
  const parts = name.trim().split(/\s+/);
  return parts[parts.length - 1];
}

/**
 * Get first name from a full name.
 * @param {string} name
 * @returns {string}
 */
export function getFirstName(name) {
  const parts = name.trim().split(/\s+/);
  return parts[0];
}

/**
 * Detect dark mode from document theme.
 * @returns {boolean}
 */
export function isDarkMode() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme:dark)').matches);
}

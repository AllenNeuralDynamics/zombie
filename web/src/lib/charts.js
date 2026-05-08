/**
 * charts.js — Shared chart rendering utilities.
 */

import { escHtml } from './utils.js';

/** Fixed colours for known institutions; others fall back to grey shades. */
const INSTITUTION_COLORS = {
  AIND: '#FF8C00',
  AIBS: '#003087',
  AI: '#a0c4ff',
  Columbia: '#9b2226',
  NYU: '#6a0dad',
  None: '#999999',
};

const FALLBACK_COLORS = [
  '#4e9af1', '#f4845f', '#6bcb77', '#ffd166', '#ef476f', '#118ab2',
];

/**
 * Compute institution slices for a pie chart from SmartSPIM row data.
 * Returns array sorted by count descending, each entry:
 *   { institution, count, fraction }
 *
 * @param {object[]} rows
 * @returns {Array<{institution: string, count: number, fraction: number}>}
 */
export function institutionSlices(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row.institution ?? 'Unknown');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = rows.length;
  if (total === 0) return [];
  return Array.from(counts.entries())
    .map(([institution, count]) => ({ institution, count, fraction: count / total }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Build an SVG string for a pie chart of institution slices.
 *
 * @param {Array<{institution: string, count: number, fraction: number}>} slices
 * @param {number} [size=220]  Diameter of the pie circle.
 * @returns {string} SVG markup string.
 */
export function buildPieSvg(slices, size = 220) {
  if (slices.length === 0) return '';

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;

  const legendItemH = 20;
  const legendWidth = 180;
  const svgHeight = Math.max(size, slices.length * legendItemH + 10);
  const svgWidth = size + legendWidth + 20;

  let paths = '';
  let legend = '';
  let fallbackIdx = 0;

  let angle = -Math.PI / 2;

  for (let i = 0; i < slices.length; i++) {
    const { institution, count, fraction } = slices[i];
    const sweep = fraction * 2 * Math.PI;
    const endAngle = angle + sweep;

    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const largeArc = sweep > Math.PI ? 1 : 0;

    const color =
      INSTITUTION_COLORS[institution] ??
      FALLBACK_COLORS[fallbackIdx++ % FALLBACK_COLORS.length];

    paths += `<path d="M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${largeArc},1 ${x2},${y2} Z"
      fill="${color}" stroke="#fff" stroke-width="1.5" />`;

    const midAngle = angle + sweep / 2;
    const labelR = r * 0.65;
    const lx = cx + labelR * Math.cos(midAngle);
    const ly = cy + labelR * Math.sin(midAngle);
    if (fraction >= 0.05) {
      const pct = (fraction * 100).toFixed(2);
      paths += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}"
        text-anchor="middle" dominant-baseline="middle"
        font-size="11" fill="#fff" font-weight="600">${count.toLocaleString()} (${pct}%)</text>`;
    }

    const ly2 = 10 + i * legendItemH + legendItemH / 2;
    const lx2 = size + 16;
    legend += `<rect x="${lx2}" y="${(ly2 - 7).toFixed(1)}" width="14" height="14" rx="2" fill="${color}" />`;
    legend += `<text x="${(lx2 + 19).toFixed(1)}" y="${ly2.toFixed(1)}"
      dominant-baseline="middle" font-size="12" fill="#333">${escHtml(institution)}</text>`;

    angle = endAngle;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}"
    viewBox="0 0 ${svgWidth} ${svgHeight}" role="img" aria-label="Subjects by Institution pie chart">
    <title>Subjects by Institution</title>
    ${paths}
    ${legend}
  </svg>`;
}

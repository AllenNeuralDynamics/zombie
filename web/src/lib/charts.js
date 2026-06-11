/**
 * charts.js — Shared chart rendering utilities.
 */

import * as Plot from '@observablehq/plot';
import { escHtml } from './utils.js';

// ---------------------------------------------------------------------------
// Modality histogram
// ---------------------------------------------------------------------------

/** Fixed colour per modality — used by both project and platform overview pages. */
export const MODALITY_COLOR = {
  'ecephys':         '#4e79a7',
  'icephys':         '#a0cbe8',
  'EMG':             '#b07aa1',
  'fib':             '#f28e2b',
  'pophys':          '#ffbe7d',
  'slap2':           '#e15759',
  'SPIM':            '#76b7b2',
  'confocal':        '#59a14f',
  'brightfield':     '#8cd17d',
  'fMOST':           '#b6992d',
  'STPT':            '#499894',
  'MRI':             '#86bcb6',
  'EM':              '#d37295',
  'ISI':             '#fabfd2',
  'merfish':         '#9d7660',
  'MAPseq':          '#d4a6c8',
  'BARseq':          '#bcbd22',
  'scRNAseq':        '#79706e',
  'behavior':        '#000000',
  'behavior-videos': '#bab0ac',
};

function _isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function _selectTickStrategy(chartWidth, dated) {
  const times = dated.map((a) => new Date(a.acquisition_start_time).getTime()).filter((t) => !isNaN(t));
  if (times.length === 0) return 'month';
  const yearsSpan = Math.max(1, (Math.max(...times) - Math.min(...times)) / (365.25 * 24 * 3600 * 1000));
  const pixelsPerMonth = chartWidth / (yearsSpan * 12);
  if (pixelsPerMonth >= 26) return 'month';
  if (pixelsPerMonth >= 15) return 'quarter';
  return 'year';
}

function _quarterlyTicks(dated) {
  const times = dated.map((a) => new Date(a.acquisition_start_time).getTime()).filter((t) => !isNaN(t));
  if (times.length === 0) return [];
  const minYear = new Date(Math.min(...times)).getUTCFullYear();
  const maxYear = new Date(Math.max(...times)).getUTCFullYear();
  const ticks = [];
  for (let y = minYear; y <= maxYear; y++) {
    for (const m of [0, 3, 6, 9]) {
      ticks.push(new Date(Date.UTC(y, m, 1)));
    }
  }
  return ticks;
}

/**
 * Build a stacked bar chart of acquisitions per month, coloured by modality.
 *
 * Pre-aggregates the assets in JS (data already in memory) then passes a
 * plain array to Observable Plot.
 *
 * @param {object[]} assets        - Raw assets with acquisition_start_time and modalities.
 * @param {number}   containerWidth - Available pixel width for sizing the chart.
 * @param {object}   [opts]
 * @param {'auto'|'month'|'quarter'|'year'} [opts.xTicks='auto'] - Tick granularity on the
 *   x-axis. 'auto' selects the best fit based on containerWidth and data date range.
 * @returns {HTMLElement|null} The plot element, or null if there is no data.
 */
export function buildModalityHistogram(assets, containerWidth = 700, { xTicks = 'auto', hiddenModalities = new Set(), showLegend = true } = {}) {
  const dated = assets.filter((a) => a.acquisition_start_time && a.modalities);
  if (dated.length === 0) return null;

  const counts = new Map(); // `weekStart|modality` → count
  for (const a of dated) {
    const d = new Date(a.acquisition_start_time);
    const day = d.getUTCDay(); // 0=Sun
    const weekStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    const weekStr = _isoDate(weekStart);
    for (const m of (Array.isArray(a.modalities) ? a.modalities : String(a.modalities).split(',').map((s) => s.trim()).filter(Boolean))) {
      const key = `${weekStr}|${m}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  const allRows = Array.from(counts.entries()).map(([key, n]) => {
    const [week, modality] = key.split('|');
    return { week: new Date(week), modality, n };
  });

  const rows = hiddenModalities.size > 0
    ? allRows.filter((r) => !hiddenModalities.has(r.modality))
    : allRows;

  const chartWidth = Math.max(300, containerWidth - 32);

  const strategy = xTicks === 'auto' ? _selectTickStrategy(chartWidth, dated) : xTicks;

  let axisTicks;
  let tickFormat;
  if (strategy === 'quarter') {
    axisTicks = _quarterlyTicks(dated);
    tickFormat = (d) =>
      d.getUTCMonth() === 0
        ? String(d.getUTCFullYear())
        : d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  } else if (strategy === 'year') {
    axisTicks = 'year';
    tickFormat = (d) => String(d.getUTCFullYear());
  } else {
    axisTicks = 'month';
    tickFormat = (d) =>
      d.getUTCMonth() === 0
        ? String(d.getUTCFullYear())
        : d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  }

  const totalByModality = new Map();
  for (const r of allRows) totalByModality.set(r.modality, (totalByModality.get(r.modality) ?? 0) + r.n);
  const presentModalities = Array.from(totalByModality.keys())
    .filter((m) => !hiddenModalities.has(m))
    .sort((a, b) => totalByModality.get(b) - totalByModality.get(a));
  const colorDomain = presentModalities;
  const colorRange = presentModalities.map((m) => MODALITY_COLOR[m] ?? '#aaaaaa');

  return Plot.plot({
    width: chartWidth,
    height: 200,
    marginBottom: 50,
    x: {
      type: 'utc',
      ticks: axisTicks,
      tickFormat,
    },
    y: { label: 'Acquisitions', grid: true },
    color: { domain: colorDomain, range: colorRange, legend: showLegend },
    style: { background: 'transparent', fontSize: '11px', fontFamily: 'inherit' },
    marks: [
      Plot.rectY(rows, Plot.stackY({
        order: presentModalities,
        x: (d) => d.week,
        interval: 'week',
        y: 'n',
        fill: 'modality',
      })),
    ],
  });
}

/**
 * Build an interactive modality histogram with a clickable HTML legend.
 *
 * Wraps `buildModalityHistogram` — clicking a legend item toggles that modality
 * on/off and re-renders only the plot portion.
 *
 * @param {object[]} assets        - Raw assets (same as buildModalityHistogram).
 * @param {number}   containerWidth - Available pixel width.
 * @param {object}   [opts]        - Same options as buildModalityHistogram (except hiddenModalities/showLegend).
 * @returns {HTMLElement|null}
 */
export function buildInteractiveModalityHistogram(assets, containerWidth = 700, opts = {}) {
  const dated = assets.filter((a) => a.acquisition_start_time && a.modalities);
  if (dated.length === 0) return null;

  const totalByModality = new Map();
  for (const a of dated) {
    for (const m of (Array.isArray(a.modalities) ? a.modalities : String(a.modalities).split(',').map((s) => s.trim()).filter(Boolean))) {
      totalByModality.set(m, (totalByModality.get(m) ?? 0) + 1);
    }
  }
  const allModalities = Array.from(totalByModality.keys())
    .sort((a, b) => totalByModality.get(b) - totalByModality.get(a));

  const hidden = new Set();
  const container = document.createElement('div');
  container.className = 'modality-histogram-interactive';

  const legend = document.createElement('div');
  legend.className = 'modality-legend';
  for (const m of allModalities) {
    const item = document.createElement('span');
    item.className = 'modality-legend-item';
    item.dataset.modality = m;

    const swatch = document.createElement('span');
    swatch.className = 'modality-legend-swatch';
    swatch.style.background = MODALITY_COLOR[m] ?? '#aaaaaa';
    swatch.style.borderColor = MODALITY_COLOR[m] ?? '#aaaaaa';

    const label = document.createTextNode(m);
    item.appendChild(swatch);
    item.appendChild(label);

    item.addEventListener('click', () => {
      if (hidden.has(m)) {
        hidden.delete(m);
        item.classList.remove('faded');
        swatch.style.background = MODALITY_COLOR[m] ?? '#aaaaaa';
      } else {
        hidden.add(m);
        item.classList.add('faded');
        swatch.style.background = 'transparent';
      }
      const newPlot = buildModalityHistogram(assets, containerWidth, { ...opts, hiddenModalities: hidden, showLegend: false });
      const old = container.querySelector('.modality-plot');
      if (old) old.remove();
      if (newPlot) {
        newPlot.classList.add('modality-plot');
        container.appendChild(newPlot);
      }
    });

    legend.appendChild(item);
  }

  container.appendChild(legend);

  const initialPlot = buildModalityHistogram(assets, containerWidth, { ...opts, hiddenModalities: hidden, showLegend: false });
  if (initialPlot) {
    initialPlot.classList.add('modality-plot');
    container.appendChild(initialPlot);
  }

  return container;
}

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

/**
 * charts.js — Shared chart rendering utilities.
 */

import * as Plot from '@observablehq/plot';
import { escHtml } from './utils.js';

// ---------------------------------------------------------------------------
// Asset overview histogram
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

/**
 * Resolve the colour for a modality.
 *
 * `behavior` is black in light mode, which is invisible on a dark background,
 * so it resolves to the `--modality-behavior` CSS variable (black in light,
 * white in dark). Returning the `var(...)` string — rather than a resolved
 * hex — lets the colour flip live with the theme without re-rendering the
 * chart, since SVG `fill` / inline `background` both honour CSS variables.
 */
export function modalityColor(m) {
  if (m === 'behavior') return 'var(--modality-behavior, #000000)';
  return MODALITY_COLOR[m] ?? '#aaaaaa';
}

function _isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function _selectTickStrategy(chartWidth, spanMs) {
  if (spanMs <= 0) return 'month';
  const yearsSpan = Math.max(1, spanMs / (365.25 * 24 * 3600 * 1000));
  const pixelsPerMonth = chartWidth / (yearsSpan * 12);
  if (pixelsPerMonth >= 26) return 'month';
  if (pixelsPerMonth >= 15) return 'quarter';
  return 'year';
}

function _quarterlyTicks(domainMin, domainMax) {
  const minYear = domainMin.getUTCFullYear();
  const maxYear = domainMax.getUTCFullYear();
  const ticks = [];
  for (let y = minYear; y <= maxYear; y++) {
    for (const m of [0, 3, 6, 9]) {
      ticks.push(new Date(Date.UTC(y, m, 1)));
    }
  }
  return ticks;
}

/**
 * Convert the metadata representation of modalities into plain strings.
 */
function _modalities(value) {
  return Array.isArray(value)
    ? value.map(String).filter(Boolean)
    : String(value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

const DATASET_COLORS = [
  '#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#b07aa1',
  '#9c755f', '#edc949', '#af7aa1', '#ff9da7', '#79706e', '#86bcb6',
];

/** Resolve a deterministic colour for an SWDB dataset. */
export function datasetColor(dataset) {
  let hash = 0;
  for (const char of String(dataset ?? '')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return DATASET_COLORS[hash % DATASET_COLORS.length];
}

function _histogramRows(assets, groupBy) {
  const counts = new Map();
  const labels = new Map();
  const seenAssets = new Set();
  for (const asset of assets) {
    // An SWDB asset can belong to more than one published dataset. Dataset
    // mode intentionally preserves those memberships; modality mode should
    // still count the canonical asset only once.
    if (!asset.acquisition_start_time) continue;
    const date = new Date(asset.acquisition_start_time);
    if (Number.isNaN(date.valueOf())) continue;
    if (groupBy === 'modality' && asset.name) {
      if (seenAssets.has(asset.name)) continue;
      seenAssets.add(asset.name);
    }
    const day = date.getUTCDay(); // 0=Sun
    const week = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day));
    const weekKey = _isoDate(week);
    const groups = groupBy === 'dataset' ? [asset.dataset].filter(Boolean) : _modalities(asset.modalities);
    for (const group of groups) {
      const key = `${weekKey}|${group}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (groupBy === 'dataset' && asset.datasetLabel) labels.set(group, asset.datasetLabel);
    }
  }
  return {
    rows: Array.from(counts.entries()).map(([key, n]) => {
      const separator = key.indexOf('|');
      const group = key.slice(separator + 1);
      return {
        week: new Date(key.slice(0, separator)),
        group,
        groupLabel: labels.get(group) ?? group,
        n,
      };
    }),
    labels,
  };
}

/**
 * Build the shared stacked asset-overview histogram used by the assets page,
 * platform pages, and the SWDB landing page.
 *
 * Pre-aggregates the assets in JS (data already in memory) then passes a
 * plain array to Observable Plot.
 *
 * @param {object[]} assets        - Rows with acquisition_start_time and either
 *   modalities or dataset, depending on groupBy.
 * @param {number}   containerWidth - Available pixel width for sizing the chart.
 * @param {object}   [opts]
 * @param {'modality'|'dataset'} [opts.groupBy='modality'] - Stack colour grouping.
 * @param {'auto'|'month'|'quarter'|'year'} [opts.xTicks='auto'] - Tick granularity on the
 *   x-axis. 'auto' selects the best fit based on containerWidth and data date range.
 * @param {Set<string>} [opts.hiddenGroups] - Groups to omit from the plot.
 * @param {boolean} [opts.showLegend=true]
 * @returns {HTMLElement|null} The plot element, or null if there is no data.
 */
export function buildAssetOverviewHistogram(
  assets,
  containerWidth = 700,
  { groupBy = 'modality', xTicks = 'auto', hiddenGroups = new Set(), showLegend = true } = {},
) {
  const { rows: allRows } = _histogramRows(assets, groupBy);
  if (allRows.length === 0) return null;
  const rows = hiddenGroups.size > 0 ? allRows.filter((r) => !hiddenGroups.has(r.group)) : allRows;

  const chartWidth = Math.max(300, containerWidth - 32);

  const ONE_YEAR_MS = 365.25 * 24 * 3600 * 1000;
  const visibleTimes = rows.map((r) => r.week.getTime()).filter((t) => !isNaN(t));
  let xDomain;
  if (visibleTimes.length > 0) {
    const rawMin = Math.min(...visibleTimes);
    const rawMax = Math.max(...visibleTimes);
    if (rawMax - rawMin < ONE_YEAR_MS) {
      const median = (rawMin + rawMax) / 2;
      const half = ONE_YEAR_MS / 2;
      xDomain = [new Date(median - half), new Date(median + half)];
    } else {
      xDomain = [new Date(rawMin), new Date(rawMax)];
    }
  }

  const domainSpanMs = xDomain ? xDomain[1].getTime() - xDomain[0].getTime() : 0;
  const strategy = xTicks === 'auto' ? _selectTickStrategy(chartWidth, domainSpanMs) : xTicks;

  let axisTicks;
  let tickFormat;
  if (strategy === 'quarter') {
    axisTicks = xDomain ? _quarterlyTicks(xDomain[0], xDomain[1]) : [];
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

  const totalByGroup = new Map();
  for (const row of allRows) totalByGroup.set(row.group, (totalByGroup.get(row.group) ?? 0) + row.n);
  const presentGroups = Array.from(totalByGroup.keys())
    .filter((group) => !hiddenGroups.has(group))
    .sort((a, b) => totalByGroup.get(b) - totalByGroup.get(a));
  const colorDomain = presentGroups;
  const colorRange = presentGroups.map((group) => groupBy === 'dataset' ? datasetColor(group) : modalityColor(group));

  return Plot.plot({
    width: chartWidth,
    height: 200,
    marginBottom: 50,
    x: {
      type: 'utc',
      ticks: axisTicks,
      tickFormat,
      domain: xDomain,
    },
    y: { label: groupBy === 'dataset' ? 'Assets' : 'Acquisitions', grid: true },
    color: { domain: colorDomain, range: colorRange, legend: showLegend },
    style: { background: 'transparent', fontSize: '11px', fontFamily: 'inherit' },
    marks: [
      Plot.rectY(rows, Plot.stackY({
        order: presentGroups,
        x: (d) => d.week,
        interval: 'week',
        y: 'n',
        fill: 'group',
        title: (d) => `${d.groupLabel}: ${d.n.toLocaleString()}`,
        ariaLabel: (d) => d.group,
      })),
    ],
  });
}

/** Backwards-compatible platform/project wrapper. */
export function buildModalityHistogram(assets, containerWidth = 700, opts = {}) {
  const { hiddenModalities = new Set(), ...rest } = opts;
  return buildAssetOverviewHistogram(assets, containerWidth, {
    ...rest,
    groupBy: 'modality',
    hiddenGroups: hiddenModalities,
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
  return buildInteractiveAssetOverviewHistogram(assets, containerWidth, {
    ...opts,
    groupBy: 'modality',
    hoverFilters: false,
  });
}

/**
 * Build an interactive overview histogram with a legend that can hide groups
 * on click and temporarily filter to one group on hover.
 */
export function buildInteractiveAssetOverviewHistogram(
  assets,
  containerWidth = 700,
  {
    groupBy = 'modality',
    xTicks = 'auto',
    hoverFilters = false,
    onHoverGroup = null,
  } = {},
) {
  const { rows } = _histogramRows(assets, groupBy);
  if (rows.length === 0) return null;

  const totals = new Map();
  const labels = new Map();
  for (const row of rows) {
    totals.set(row.group, (totals.get(row.group) ?? 0) + row.n);
    labels.set(row.group, row.groupLabel);
  }
  const groups = Array.from(totals.keys()).sort((a, b) => totals.get(b) - totals.get(a));
  const hidden = new Set();
  let hoverGroup = null;
  const container = document.createElement('div');
  container.className = groupBy === 'dataset' ? 'asset-overview-histogram-interactive' : 'modality-histogram-interactive';

  const legend = document.createElement('div');
  legend.className = 'modality-legend';
  container.appendChild(legend);

  const plotWrap = document.createElement('div');
  plotWrap.className = 'modality-plot';
  container.appendChild(plotWrap);

  function render() {
    const filtered = hoverGroup == null
      ? hidden
      : new Set(groups.filter((group) => group !== hoverGroup));
    const plot = buildAssetOverviewHistogram(assets, containerWidth, {
      groupBy,
      xTicks,
      hiddenGroups: filtered,
      showLegend: false,
    });
    plotWrap.replaceChildren();
    if (plot) plotWrap.appendChild(plot);
    onHoverGroup?.(hoverGroup);
  }

  for (const group of groups) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'modality-legend-item';
    item.dataset.group = group;
    item.title = hoverFilters ? `Filter to ${labels.get(group)}` : `Toggle ${labels.get(group)}`;

    const swatch = document.createElement('span');
    swatch.className = 'modality-legend-swatch';
    const color = groupBy === 'dataset' ? datasetColor(group) : modalityColor(group);
    swatch.style.background = color;
    swatch.style.borderColor = color;
    item.append(swatch, document.createTextNode(labels.get(group)));

    item.addEventListener('mouseenter', () => {
      if (!hoverFilters) return;
      hoverGroup = group;
      render();
    });
    item.addEventListener('mouseleave', () => {
      if (!hoverFilters) return;
      hoverGroup = null;
      render();
    });
    item.addEventListener('click', () => {
      if (hidden.has(group)) {
        hidden.delete(group);
        item.classList.remove('faded');
        swatch.style.background = color;
      } else {
        hidden.add(group);
        item.classList.add('faded');
        swatch.style.background = 'transparent';
      }
      render();
    });
    legend.appendChild(item);
  }

  render();
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

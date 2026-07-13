import * as Plot from '@observablehq/plot';

export const PSTH_BASELINE_DEFAULT_MS = 200;

export function createBaselineControls({ defaultMs = PSTH_BASELINE_DEFAULT_MS, defaultOn = true, onChange } = {}) {
  const wrap = document.createElement('span');
  wrap.className = 'psth-baseline-controls';
  wrap.innerHTML =
    `<label class="psth-baseline-toggle"><input type="checkbox" class="psth-baseline-chk"${defaultOn ? ' checked' : ''}> Baseline</label>`
    + `<label class="psth-baseline-ms"><input type="number" class="psth-baseline-ms-input" value="${defaultMs}" min="0" step="50"${defaultOn ? '' : ' disabled'}> ms</label>`;
  const chk = wrap.querySelector('.psth-baseline-chk');
  const ms = wrap.querySelector('.psth-baseline-ms-input');

  const getBaselineSec = () => {
    if (!chk.checked) return 0;
    const v = Number(ms.value);
    return Number.isFinite(v) && v > 0 ? v / 1000 : 0;
  };

  chk.addEventListener('change', () => { ms.disabled = !chk.checked; onChange?.(); });
  ms.addEventListener('change', () => { if (chk.checked) onChange?.(); });

  const setDisabled = (disabled) => {
    chk.disabled = disabled;
    ms.disabled = disabled || !chk.checked;
  };

  return { element: wrap, getBaselineSec, setDisabled };
}

export function baselineSeries(series, baselineSec, { colorKey } = {}) {
  if (!(baselineSec > 0) || !series.length) return series;
  const baseByKey = new Map();
  const groups = new Map();
  for (const d of series) {
    const k = colorKey ? d[colorKey] : '_';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  for (const [k, arr] of groups) {
    const pre = arr.filter((d) => d.t >= -baselineSec && d.t < 0 && Number.isFinite(d.mean));
    baseByKey.set(k, pre.length ? pre.reduce((s, d) => s + d.mean, 0) / pre.length : 0);
  }
  return series.map((d) => {
    const b = baseByKey.get(colorKey ? d[colorKey] : '_') ?? 0;
    const out = { ...d, mean: d.mean - b };
    if (d.lo != null) out.lo = d.lo - b;
    if (d.hi != null) out.hi = d.hi - b;
    return out;
  });
}

export function buildPsthPlot(series, opts = {}) {
  const {
    pre = -2,
    post = 4,
    xLabel = 'Time rel. event (s)',
    yLabel = '',
    width = 320,
    height = 200,
    marginLeft = 44,
    marginTop = 8,
    marginRight = 10,
    marginBottom = 30,
    compact = false,
    yDomain,
    colorKey,
    colorDomain,
    colorRange,
    stroke = '#c0392b',
    fill = '#c0392b',
    showArea = true,
    fillOpacity = 0.15,
    strokeWidth = 1.6,
    showEventRule = true,
  } = opts;

  const banded = showArea ? series.filter((d) => d.lo != null && d.hi != null) : [];
  const marks = [];
  if (banded.length) {
    marks.push(Plot.areaY(banded, {
      x: 't', y1: 'lo', y2: 'hi',
      fill: colorKey ?? fill, fillOpacity,
    }));
  }
  marks.push(Plot.lineY(series, {
    x: 't', y: 'mean',
    stroke: colorKey ?? stroke, strokeWidth,
  }));
  if (showEventRule) marks.push(Plot.ruleX([0], { stroke: '#888', strokeDasharray: '3,3' }));
  marks.push(Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.4 }));

  return Plot.plot({
    height,
    width: Math.max(220, width),
    marginLeft,
    marginTop,
    marginRight,
    marginBottom,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: compact ? 9 : 10 },
    x: { domain: [pre, post], label: compact ? null : xLabel },
    y: { label: compact ? null : yLabel, grid: true, ...(yDomain ? { domain: yDomain } : {}) },
    ...(colorKey ? { color: { domain: colorDomain, range: colorRange } } : {}),
    marks,
  });
}

/** Dynamic Routing context/stimulus-aligned ecephys raster viewer. */

import * as Plot from '@observablehq/plot';
import {
  filterUnits,
  loadRasterSession,
  unitArea,
  unitAreaKey,
  unitProbeKey,
  unitProbeName,
} from './data.js';

const DEFAULT_PRE = -1.5;
const DEFAULT_POST = 1;

const RASTER_COLUMNS = [
  { condition: 'visual_target', label: 'VIS+' },
  { condition: 'auditory_target', label: 'AUD+' },
  { condition: 'visual_nontarget', label: 'VIS-' },
  { condition: 'auditory_nontarget', label: 'AUD-' },
];
const CONTEXTS = ['vis', 'aud'];
const CONTEXT_COLORS = { vis: '#dceedd', aud: '#fff0d5' };
const PSTH_COLORS = { vis: '#6b7280', aud: '#f59e0b' };
const PSTH_BINS = 60;

function finite(value, fallback) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sortUnits(units) {
  return [...units].sort((a, b) => {
    const aRate = Number.isFinite(a.firingRate) ? a.firingRate : -Infinity;
    const bRate = Number.isFinite(b.firingRate) ? b.firingRate : -Infinity;
    return bRate - aRate
      || String(a.deviceName).localeCompare(String(b.deviceName), undefined, { numeric: true })
      || String(a.unitName).localeCompare(String(b.unitName), undefined, { numeric: true });
  });
}

function unitLabel(unit) {
  const stats = [];
  stats.push(unitArea(unit));
  if (unit.decoderLabel) stats.push(unit.decoderLabel);
  if (Number.isFinite(unit.firingRate)) stats.push(`${unit.firingRate.toFixed(1)} Hz`);
  if (Number.isFinite(unit.numSpikes)) stats.push(`${unit.numSpikes.toLocaleString()} spikes`);
  return `${unit.unitName}${stats.length ? ` (${stats.join(', ')})` : ''}`;
}

function buildProbeOptions(select, units, selectedKey) {
  const probes = new Map();
  for (const unit of units) {
    const key = unitProbeKey(unit);
    if (!probes.has(key)) {
      probes.set(key, {
        key,
        label: `${unit.experiment ?? 'experiment'} / ${unitProbeName(unit)}`,
      });
    }
  }
  const sorted = [...probes.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }));
  select.replaceChildren();
  for (const probe of sorted) {
    const option = document.createElement('option');
    option.value = probe.key;
    option.textContent = probe.label;
    option.selected = probe.key === selectedKey;
    select.appendChild(option);
  }
  const preferred = sorted.find((probe) => probe.key === selectedKey) ?? sorted[0] ?? null;
  if (preferred) select.value = preferred.key;
  return { selected: preferred, count: sorted.length };
}

function buildAreaOptions(select, units, selectedKey) {
  const areas = new Map();
  for (const unit of units) {
    const key = unitAreaKey(unit);
    if (!areas.has(key)) areas.set(key, { key, label: unitArea(unit) });
  }
  const sorted = [...areas.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true }));
  select.replaceChildren();
  for (const area of sorted) {
    const option = document.createElement('option');
    option.value = area.key;
    option.textContent = area.label;
    option.selected = area.key === selectedKey;
    select.appendChild(option);
  }
  const preferred = sorted.find((area) => area.key === selectedKey) ?? sorted[0] ?? null;
  if (preferred) select.value = preferred.key;
  return { selected: preferred, count: sorted.length };
}

function buildUnitOptions(select, units, selectedKey, probeKey, areaKey) {
  select.replaceChildren();
  const sorted = sortUnits(filterUnits(units, { probeKey, areaKey }));
  for (const unit of sorted) {
    const option = document.createElement('option');
    option.value = unit.key;
    option.textContent = unitLabel(unit);
    option.selected = unit.key === selectedKey;
    select.appendChild(option);
  }
  const requested = sorted.find((unit) => unit.key === selectedKey);
  const preferred = requested ?? sorted.find((unit) => unit.qc) ?? sorted[0] ?? null;
  if (preferred) select.value = preferred.key;
  return preferred;
}

function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function buildBlockRowSpans(trials) {
  const spans = [];
  if (!trials.length) return spans;

  let start = 0;
  let block = trials[0].block;
  let context = trials[0].context;
  const finish = (end) => {
    spans.push({
      y1: start - 0.5,
      y2: end + 0.5,
      midpoint: (start + end) / 2,
      context: CONTEXTS.includes(context) ? context : null,
      label: CONTEXTS.includes(context) ? context : 'catch',
    });
  };

  for (let row = 1; row < trials.length; row++) {
    const trial = trials[row];
    if (trial.block === block && trial.context === context) continue;
    finish(row - 1);
    start = row;
    block = trial.block;
    context = trial.context;
  }
  finish(trials.length - 1);
  return spans;
}

function buildColumnRasterRows(spikeTimes, trials, pre, post, rowIndex) {
  const rows = [];
  const times = Array.from(spikeTimes ?? [], Number).filter(Number.isFinite);
  for (const trial of trials) {
    if (!Number.isFinite(trial.stimStart)) continue;
    const row = rowIndex.get(trial);
    if (!Number.isFinite(row)) continue;
    const lo = trial.stimStart + pre;
    const hi = trial.stimStart + post;
    for (let index = lowerBound(times, lo); index < times.length; index++) {
      const spike = times[index];
      if (spike > hi) break;
      rows.push({ relative: spike - trial.stimStart, row });
    }
  }
  return rows;
}

function buildPsthSeries(spikeTimes, trials, condition, pre, post) {
  const conditionTrials = trials.filter((trial) => trial.condition === condition);
  const binWidth = (post - pre) / PSTH_BINS;
  const grouped = new Map(CONTEXTS.map((context) => [context, {
    nTrials: 0,
    sums: new Array(PSTH_BINS).fill(0),
    squares: new Array(PSTH_BINS).fill(0),
  }]));
  const times = Array.from(spikeTimes ?? [], Number).filter(Number.isFinite);

  for (const trial of conditionTrials) {
    const group = grouped.get(trial.context);
    if (!group || !Number.isFinite(trial.stimStart)) continue;
    group.nTrials += 1;
    const counts = new Array(PSTH_BINS).fill(0);
    const lo = trial.stimStart + pre;
    const hi = trial.stimStart + post;
    for (let index = lowerBound(times, lo); index < times.length; index++) {
      const spike = times[index];
      if (spike > hi) break;
      const bin = Math.floor((spike - trial.stimStart - pre) / binWidth);
      if (bin >= 0 && bin < PSTH_BINS) counts[bin] += 1;
    }
    for (let bin = 0; bin < PSTH_BINS; bin++) {
      group.sums[bin] += counts[bin];
      group.squares[bin] += counts[bin] * counts[bin];
    }
  }

  return CONTEXTS.flatMap((context) => {
    const group = grouped.get(context);
    if (!group?.nTrials) return [];
    return group.sums.map((sum, bin) => {
      const meanCount = sum / group.nTrials;
      const variance = Math.max(
        0,
        group.squares[bin] / group.nTrials - meanCount * meanCount,
      );
      const mean = meanCount / binWidth;
      const sem = Math.sqrt(variance / group.nTrials) / binWidth;
      return {
        t: pre + (bin + 0.5) * binWidth,
        mean,
        lo: Math.max(0, mean - sem),
        hi: mean + sem,
        context,
      };
    });
  });
}

function makePlot(trials, spikes, pre, post, includeCatch, availableWidth = 980) {
  const visibleTrials = trials.filter((trial) => includeCatch || trial.condition !== 'catch');
  // Each condition gets its own compact trial stack. Keeping these stacks
  // independent avoids reserving blank rows for trials shown in another
  // column, while block boundaries still follow the original trial order.
  const columnTrials = RASTER_COLUMNS.map(({ condition }) =>
    visibleTrials.filter((trial) => trial.condition === condition));
  const maxColumnRows = Math.max(1, ...columnTrials.map((rows) => rows.length));
  const rasterHeight = Math.max(260, Math.min(760, 65 + maxColumnRows * 3));
  const plotGap = 8;
  const columnWidth = Math.max(160, Math.floor((availableWidth - plotGap * 3) / 4));
  const columnPsths = RASTER_COLUMNS.map(({ condition }) =>
    buildPsthSeries(spikes, visibleTrials, condition, pre, post));
  const maxPsth = Math.max(
    0,
    ...columnPsths.flat().map((point) => point.hi).filter(Number.isFinite),
  );
  const psthYMax = maxPsth > 0 ? maxPsth * 1.1 : 1;
  const durations = visibleTrials
    .map((trial) => trial.stimStop - trial.stimStart)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const stimulusDuration = durations.length
    ? durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]
    : 1;
  const stimulusStart = Math.max(pre, 0);
  const stimulusEnd = Math.min(post, stimulusStart + stimulusDuration);

  const figure = document.createElement('div');
  figure.className = 'dr-raster-figure';
  const grid = document.createElement('div');
  grid.className = 'dr-raster-column-grid';
  figure.appendChild(grid);

  for (let columnIndex = 0; columnIndex < RASTER_COLUMNS.length; columnIndex++) {
    const { condition, label } = RASTER_COLUMNS[columnIndex];
    const trialsForColumn = columnTrials[columnIndex];
    const rowIndex = new Map(trialsForColumn.map((trial, row) => [trial, row]));
    const blockSpans = buildBlockRowSpans(trialsForColumn);
    const n = Math.max(1, trialsForColumn.length);
    const yDomain = [-0.5, Math.max(0.5, n - 0.5)];
    const blockBoundaries = blockSpans.slice(1).map((span) => span.y1);
    const column = document.createElement('section');
    column.className = 'dr-raster-column';
    column.setAttribute('aria-label', `${label} raster and PSTH`);

    const heading = document.createElement('h4');
    heading.className = 'dr-raster-column-title';
    heading.textContent = label;
    column.appendChild(heading);

    const rasterRows = buildColumnRasterRows(
      spikes,
      trialsForColumn,
      pre,
      post,
      rowIndex,
    );
    const rasterMarks = [
      Plot.rect(blockSpans, {
        x1: pre,
        x2: post,
        y1: 'y1',
        y2: 'y2',
        fill: (span) => CONTEXT_COLORS[span.context] ?? '#f3f4f6',
        fillOpacity: 0.65,
        stroke: 'none',
      }),
    ];
    if (stimulusEnd > stimulusStart) {
      rasterMarks.push(Plot.rect([{
        x1: stimulusStart,
        x2: stimulusEnd,
        y1: yDomain[0],
        y2: yDomain[1],
      }], {
        x1: 'x1', x2: 'x2', y1: 'y1', y2: 'y2',
        fill: '#d9eff9', fillOpacity: 0.65, stroke: 'none',
      }));
    }
    rasterMarks.push(
      Plot.ruleY(blockBoundaries, { stroke: '#8b8f94', strokeWidth: 1 }),
      Plot.ruleX([0], { stroke: '#6b7280', strokeWidth: 1.1 }),
      Plot.ruleX(rasterRows, {
        x: 'relative',
        y1: (row) => row.row - 0.36,
        y2: (row) => row.row + 0.36,
        stroke: '#727272',
        strokeWidth: 0.9,
      }),
    );
    if (columnIndex === 0) {
      rasterMarks.push(Plot.textY(blockSpans, {
        y: 'midpoint',
        text: 'label',
        frameAnchor: 'left',
        dx: -8,
        textAnchor: 'end',
        fill: (span) => PSTH_COLORS[span.context] ?? '#6b7280',
        stroke: 'none',
        fontWeight: 600,
      }));
    }
    const rasterPlot = Plot.plot({
      width: columnWidth,
      height: rasterHeight,
      // Reserve the same y-axis gutter in every column so the time scales
      // and stimulus-onset lines remain visually aligned across conditions.
      marginLeft: 62,
      marginRight: 6,
      marginTop: 2,
      marginBottom: 2,
      x: { domain: [pre, post], axis: null },
      y: {
        domain: yDomain,
        reverse: true,
        axis: columnIndex === 0 ? 'left' : null,
        ticks: blockSpans.map((span) => span.midpoint),
        tickFormat: () => '',
        label: columnIndex === 0 ? 'Trials ↓' : null,
      },
      marks: rasterMarks,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
    });
    rasterPlot.classList.add('dr-raster-raster-plot');
    column.appendChild(rasterPlot);

    const psthMarks = [];
    for (const context of CONTEXTS) {
      const series = columnPsths[columnIndex].filter((point) => point.context === context);
      if (!series.length) continue;
      psthMarks.push(
        Plot.areaY(series, {
          x: 't', y1: 'lo', y2: 'hi',
          fill: PSTH_COLORS[context], fillOpacity: 0.16,
        }),
        Plot.lineY(series, {
          x: 't', y: 'mean',
          stroke: PSTH_COLORS[context], strokeWidth: 1.8,
        }),
      );
    }
    psthMarks.push(Plot.ruleX([0], { stroke: '#6b7280', strokeWidth: 1.1 }));
    const psthPlot = Plot.plot({
      width: columnWidth,
      height: 170,
      marginLeft: 62,
      marginRight: 6,
      marginTop: 4,
      marginBottom: 42,
      x: {
        domain: [pre, post],
        label: 'Time after stimulus onset (s)',
        ticks: 3,
      },
      y: {
        domain: [0, psthYMax],
        axis: columnIndex === 0 ? 'left' : null,
        grid: true,
        label: columnIndex === 0 ? 'Hz' : null,
      },
      marks: psthMarks,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
    });
    psthPlot.classList.add('dr-raster-psth-plot');
    column.appendChild(psthPlot);
    grid.appendChild(column);
  }
  return figure;
}

/**
 * Create the raster section that belongs in the /view Data tab.
 *
 * The acquisition event supplies the asset name; the loader follows its
 * source_data relationship when the timeline asset is raw but the public
 * NWB-Zarr is a derived ecephys asset.
 */
export function createDynamicRoutingRasterSection(coord, assetName) {
  const container = document.createElement('div');
  container.className = 'dynamic-routing-raster-view dynamic-routing-raster-section';

  let currentSession = null;
  let currentUnit = null;
  let generation = 0;
  let spikeController = null;

  container.innerHTML = `
    <div class="dr-raster-layout">
      <section class="dr-raster-top-row">
        <section class="dr-raster-controls" aria-label="Raster controls">
          <label>Probe
            <select class="dr-raster-probe" disabled><option>Loading probes…</option></select>
          </label>
          <label>Area
            <select class="dr-raster-area" disabled><option>Loading areas…</option></select>
          </label>
          <label>Unit
            <select class="dr-raster-unit" disabled><option>Loading units…</option></select>
          </label>
          <label>Pre (s)
            <input class="dr-raster-pre" type="number" step="0.25" value="${DEFAULT_PRE}" />
          </label>
          <label>Post (s)
            <input class="dr-raster-post" type="number" step="0.25" value="${DEFAULT_POST}" />
          </label>
          <label class="dr-raster-check"><input class="dr-raster-qc" type="checkbox" checked /> QC pass only</label>
          <label class="dr-raster-check"><input class="dr-raster-catch" type="checkbox" /> Show catch trials</label>
        </section>
        <p class="dr-raster-status" role="status">Loading the selected asset…</p>
      </section>
      <div class="dr-raster-visuals">
        <section class="dr-raster-brain" aria-label="Ecephys unit locations"></section>
        <section class="dr-raster-raster" aria-live="polite"></section>
      </div>
    </div>
  `;

  const probeSelect = container.querySelector('.dr-raster-probe');
  const areaSelect = container.querySelector('.dr-raster-area');
  const unitSelect = container.querySelector('.dr-raster-unit');
  const preInput = container.querySelector('.dr-raster-pre');
  const postInput = container.querySelector('.dr-raster-post');
  const qcInput = container.querySelector('.dr-raster-qc');
  const catchInput = container.querySelector('.dr-raster-catch');
  const status = container.querySelector('.dr-raster-status');
  const brainMount = container.querySelector('.dr-raster-brain');
  const rasterMount = container.querySelector('.dr-raster-raster');
  let brainViz = null;
  let brainInitPromise = null;

  function syncBrainHeight() {
    const figure = rasterMount.querySelector('.dr-raster-figure');
    if (!figure) return;
    const rasterStyles = getComputedStyle(rasterMount);
    const verticalPadding = parseFloat(rasterStyles.paddingTop || 0)
      + parseFloat(rasterStyles.paddingBottom || 0);
    const height = figure.getBoundingClientRect().height + verticalPadding;
    if (height > 0) brainMount.style.height = `${Math.ceil(height)}px`;
  }

  const rasterResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(syncBrainHeight)
    : null;
  rasterResizeObserver?.observe(rasterMount);

  function setStatus(message, error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('is-error', error);
  }

  function availableUnits() {
    return currentSession?.units.filter((unit) => !qcInput.checked || unit.qc) ?? [];
  }

  function syncUnitControls(
    preferredUnitKey = currentUnit?.key ?? null,
    preferredProbeKey = probeSelect.value,
    requestedAreaKey = areaSelect.value,
  ) {
    const units = availableUnits();
    const sorted = sortUnits(units);
    const preferredUnit = units.find((unit) => unit.key === preferredUnitKey)
      ?? sorted.find((unit) => unit.qc)
      ?? sorted[0]
      ?? null;
    const probes = buildProbeOptions(
      probeSelect,
      units,
      units.some((unit) => unitProbeKey(unit) === preferredProbeKey)
        ? preferredProbeKey
        : preferredUnit ? unitProbeKey(preferredUnit) : null,
    );
    probeSelect.disabled = !probes.selected;
    const probeUnits = filterUnits(units, { probeKey: probeSelect.value });
    const preferredAreaKey = preferredUnit
      && unitProbeKey(preferredUnit) === probeSelect.value
      ? unitAreaKey(preferredUnit)
      : null;
    const areas = buildAreaOptions(
      areaSelect,
      probeUnits,
      probeUnits.some((unit) => unitAreaKey(unit) === requestedAreaKey)
        ? requestedAreaKey
        : preferredAreaKey,
    );
    areaSelect.disabled = !areas.selected;
    currentUnit = buildUnitOptions(
      unitSelect,
      units,
      preferredUnit?.key ?? null,
      probeSelect.value,
      areaSelect.value,
    );
    unitSelect.disabled = !currentUnit;
    brainViz?.setUnits(units);
    brainViz?.setSelectedUnit(currentUnit?.key ?? null);
    return units;
  }

  async function ensureBrainViz(units) {
    if (brainViz) {
      brainViz.setUnits(units);
      brainViz.setSelectedUnit(currentUnit?.key ?? null);
      return;
    }
    if (!brainInitPromise) {
      brainInitPromise = import('./unit-viz-3d.js')
        .then(({ createEphysUnitViz3D }) => {
          brainViz = createEphysUnitViz3D({
            units: availableUnits(),
            selectedKey: currentUnit?.key ?? null,
          });
          brainMount.replaceChildren(brainViz);
        })
        .catch((error) => {
          console.error('[dynamic-routing-raster] 3D unit viewer failed', error);
        });
    }
    await brainInitPromise;
  }

  async function renderSelectedUnit() {
    if (!currentSession || !currentUnit) return;
    spikeController?.abort();
    spikeController = new AbortController();
    const localGeneration = ++generation;
    const pre = finite(preInput.value, DEFAULT_PRE);
    const post = Math.max(pre + 0.25, finite(postInput.value, DEFAULT_POST));
    preInput.value = String(pre);
    postInput.value = String(post);
    try {
      const spikes = await currentSession.loadSpikes(currentUnit, { signal: spikeController.signal });
      if (localGeneration !== generation) return;
      const hasConditions = currentSession.trials.some((trial) => (
        RASTER_COLUMNS.some(({ condition }) => trial.condition === condition)
        && (catchInput.checked || trial.condition !== 'catch')
      ));
      if (!hasConditions) {
        const empty = document.createElement('p');
        empty.className = 'dr-raster-empty';
        empty.textContent = 'No trial conditions are available.';
        rasterMount.replaceChildren(empty);
      } else {
        rasterMount.replaceChildren(makePlot(
          currentSession.trials,
          spikes,
          pre,
          post,
          catchInput.checked,
          Math.max(760, rasterMount.clientWidth || 980),
        ));
      }
      syncBrainHeight();
      setStatus('');
    } catch (error) {
      if (error?.message === 'aborted' || spikeController.signal.aborted) return;
      console.error('[dynamic-routing-raster] spike load failed', error);
      setStatus(`Could not load spikes: ${error?.message ?? error}`, true);
      rasterMount.replaceChildren();
    }
  }

  async function loadAsset() {
    const asset = String(assetName ?? '').trim();
    if (!asset) { setStatus('No acquisition asset is available.', true); return; }
    unitSelect.disabled = true;
    probeSelect.disabled = true;
    areaSelect.disabled = true;
    rasterMount.replaceChildren();
    setStatus(`Loading trials and unit catalog for ${asset}…`);
    try {
      currentSession = await loadRasterSession(coord, asset);
      const units = syncUnitControls(null, null);
      await ensureBrainViz(units);
      if (!currentUnit) {
        setStatus('The asset loaded, but no units were available.', true);
      } else {
        await renderSelectedUnit();
      }
    } catch (error) {
      console.error('[dynamic-routing-raster] asset load failed', error);
      setStatus(`Could not load asset: ${error?.message ?? error}`, true);
    }
  }

  probeSelect.addEventListener('change', () => {
    syncUnitControls(null, probeSelect.value, null);
    renderSelectedUnit();
  });

  areaSelect.addEventListener('change', () => {
    syncUnitControls(null, probeSelect.value, areaSelect.value);
    renderSelectedUnit();
  });

  qcInput.addEventListener('change', () => {
    const units = syncUnitControls();
    brainViz?.setUnits(units);
    if (currentUnit) renderSelectedUnit();
    else setStatus('No units match the current QC filter.', true);
  });

  unitSelect.addEventListener('change', () => {
    currentUnit = currentSession?.units.find((unit) => unit.key === unitSelect.value) ?? null;
    brainViz?.setSelectedUnit(currentUnit?.key ?? null);
    renderSelectedUnit();
  });
  preInput.addEventListener('change', () => renderSelectedUnit());
  postInput.addEventListener('change', () => renderSelectedUnit());
  catchInput.addEventListener('change', () => renderSelectedUnit());

  loadAsset();
  return container;
}

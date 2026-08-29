/**
 * Visual Learning cell-type activity view.
 *
 * Cell annotations and ROI registration live in the subject-partitioned cache;
 * the selected session's calcium traces are read from its public NWB-Zarr only
 * when a session is selected.
 */

import * as Plot from '@observablehq/plot';
import { loadBehaviorEvents } from '../mfish/behavior-events.js';
import { loadPlaneTimestamps, loadRoiTraces, openPophysNwb } from '../pophys/nwb-traces.js';
import {
  loadVisualLearningCellTypes,
  loadVisualLearningCoreg,
  loadVisualLearningProgression,
  resolveVisualLearningPlaybackSource,
  VISUAL_LEARNING_GENE_COLUMNS,
} from './data.js';

const TRACE_SERIES_KEY = 'dff';

const EVENT_STREAMS = [
  { key: 'changes', label: 'Stimulus changes' },
  { key: 'rewards', label: 'Rewards' },
  { key: 'licks', label: 'Licks' },
];

const PSTH_PRE = 2;
const PSTH_POST = 4;
const PSTH_BINS = 80;
const ACTIVITY_MARGIN_LEFT = 150;
// Shared by the activity heatmap and the gene-expression heatmap so their
// cell-type rows land on the same pixel offsets and read as one aligned pair.
const ACTIVITY_MARGIN_BOTTOM = 84;
const CELL_TYPE_ROW_HEIGHT = 18;
const CELL_TYPE_ROW_BASE_HEIGHT = 90;

/**
 * Join co-registration rows to transcriptomic cell annotations.
 *
 * @returns {{plane: string, planeId: number, roiId: number, cellId: string, cellType: string}[]}
 */
export function joinVisualLearningCells(coregRows, cellRows) {
  const types = new Map(
    (cellRows ?? []).map((row) => [String(row.cell_id), {
      cellClass: String(row.cell_class ?? 'unassigned'),
      cellSubclass: String(row.cell_subclass ?? 'none'),
      cellType: String(row.cell_type ?? 'unassigned'),
    }]),
  );
  const seen = new Set();
  const joined = [];
  for (const row of coregRows ?? []) {
    const planeValue = String(row.plane_id ?? '');
    const planeId = Number.isInteger(Number(row.plane_id))
      ? Number(row.plane_id)
      : Number(planeValue.match(/(\d+)$/)?.[1]);
    const roiId = Number(row.roi_id);
    const cellId = String(row.hcr_id ?? '');
    const label = types.get(cellId);
    if (!Number.isInteger(planeId) || !Number.isInteger(roiId) || !label) continue;
    const key = String(planeId) + ':' + String(roiId);
    if (seen.has(key)) continue;
    seen.add(key);
    joined.push({
      plane: planeValue.startsWith('VISp_') ? planeValue : 'VISp_' + String(planeId),
      planeId,
      roiId,
      cellId,
      ...label,
    });
  }
  return joined;
}

/**
 * Aggregate traces into a cell-type-by-time heatmap.
 *
 * @param {{cellType: string, timestamps: ArrayLike<number>, values: ArrayLike<number>}[]} traces
 * @returns {{rows: object[], cellTypes: string[], minTime: number, maxTime: number}}
 */
export function aggregateActivityByCellType(traces, { maxBins = 360, cellTypeOrder = null } = {}) {
  const usable = (traces ?? []).filter((trace) => trace?.timestamps?.length && trace?.values?.length);
  const times = usable.flatMap((trace) => [
    Number(trace.timestamps[0]),
    Number(trace.timestamps[trace.timestamps.length - 1]),
  ]).filter(Number.isFinite);
  if (!times.length) return { rows: [], cellTypes: [], minTime: 0, maxTime: 0 };
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const span = Math.max(maxTime - minTime, 1e-9);
  const nBins = Math.max(1, Math.min(maxBins, Math.ceil(span * 20)));
  const binWidth = span / nBins;
  // Accept a shared cell-type order (e.g. the full annotated set) so this
  // plot's rows line up with a companion plot even when some annotated
  // types have no registered ROIs in this session's traces.
  const cellTypes = cellTypeOrder?.length
    ? [...cellTypeOrder]
    : [...new Set(usable.map((trace) => trace.cellType || 'unassigned'))].sort((a, b) => a.localeCompare(b));
  const typeIndex = new Map(cellTypes.map((type, index) => [type, index]));
  const sums = cellTypes.map(() => new Float64Array(nBins));
  const counts = cellTypes.map(() => new Uint32Array(nBins));

  for (const trace of usable) {
    const index = typeIndex.get(trace.cellType || 'unassigned');
    if (index === undefined) continue;
    const n = Math.min(trace.timestamps.length, trace.values.length);
    for (let i = 0; i < n; i += 1) {
      const t = Number(trace.timestamps[i]);
      const value = Number(trace.values[i]);
      if (!Number.isFinite(t) || !Number.isFinite(value)) continue;
      const bin = Math.min(nBins - 1, Math.max(0, Math.floor((t - minTime) / binWidth)));
      sums[index][bin] += value;
      counts[index][bin] += 1;
    }
  }

  const rows = [];
  for (let typeIndexValue = 0; typeIndexValue < cellTypes.length; typeIndexValue += 1) {
    for (let bin = 0; bin < nBins; bin += 1) {
      if (!counts[typeIndexValue][bin]) continue;
      rows.push({
        cell_type: cellTypes[typeIndexValue],
        y0: typeIndexValue,
        y1: typeIndexValue + 1,
        t0: minTime + bin * binWidth,
        t1: minTime + (bin + 1) * binWidth,
        activity: sums[typeIndexValue][bin] / counts[typeIndexValue][bin],
      });
    }
  }
  return { rows, cellTypes, minTime, maxTime };
}

/**
 * Aggregate traces into a mean-dF/F time series per cell subclass, suitable
 * for a multi-line plot (unlike the cell-type heatmap, which bins by cell
 * type for a rect mark).
 *
 * Resampled to a fixed rate (10 Hz by default) rather than a fixed bin count,
 * so resolution stays comparable to the running trace it's plotted alongside
 * regardless of session length — `maxBins` is just a safety ceiling for
 * pathological time ranges, not the normal control.
 *
 * @param {{cellSubclass: string, timestamps: ArrayLike<number>, values: ArrayLike<number>}[]} traces
 * @returns {{rows: object[], subclasses: string[], minTime: number, maxTime: number}}
 */
export function aggregateActivityBySubclassSeries(traces, { sampleHz = 10, maxBins = 200_000 } = {}) {
  const usable = (traces ?? []).filter((trace) => trace?.timestamps?.length && trace?.values?.length);
  const times = usable.flatMap((trace) => [
    Number(trace.timestamps[0]),
    Number(trace.timestamps[trace.timestamps.length - 1]),
  ]).filter(Number.isFinite);
  if (!times.length) return { rows: [], subclasses: [], minTime: 0, maxTime: 0 };
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const span = Math.max(maxTime - minTime, 1e-9);
  const nBins = Math.max(1, Math.min(maxBins, Math.round(span * sampleHz)));
  const binWidth = span / nBins;
  const subclasses = [...new Set(usable.map((trace) => trace.cellSubclass || 'unassigned'))]
    .sort((a, b) => a.localeCompare(b));
  const subclassIndex = new Map(subclasses.map((subclass, index) => [subclass, index]));
  const sums = subclasses.map(() => new Float64Array(nBins));
  const counts = subclasses.map(() => new Uint32Array(nBins));

  for (const trace of usable) {
    const index = subclassIndex.get(trace.cellSubclass || 'unassigned');
    const n = Math.min(trace.timestamps.length, trace.values.length);
    for (let i = 0; i < n; i += 1) {
      const t = Number(trace.timestamps[i]);
      const value = Number(trace.values[i]);
      if (!Number.isFinite(t) || !Number.isFinite(value)) continue;
      const bin = Math.min(nBins - 1, Math.max(0, Math.floor((t - minTime) / binWidth)));
      sums[index][bin] += value;
      counts[index][bin] += 1;
    }
  }

  const rows = [];
  subclasses.forEach((subclass, index) => {
    for (let bin = 0; bin < nBins; bin += 1) {
      if (!counts[index][bin]) continue;
      rows.push({
        cell_subclass: subclass,
        t: minTime + (bin + 0.5) * binWidth,
        activity: sums[index][bin] / counts[index][bin],
      });
    }
  });
  return { rows, subclasses, minTime, maxTime };
}

/**
 * Aggregate per-cell HCR gene-probe counts into a mean-expression-by-cell-type
 * matrix, one row per (cell type, gene) pair.
 *
 * @param {object[]} cellRows - rows from `loadVisualLearningCellTypes`.
 * @returns {{rows: object[], cellTypes: string[], genes: string[]}}
 */
export function aggregateGeneExpressionByCellType(cellRows) {
  const genes = VISUAL_LEARNING_GENE_COLUMNS;
  const cellTypes = [...new Set((cellRows ?? []).map((row) => String(row.cell_type ?? 'unassigned')))]
    .sort((a, b) => a.localeCompare(b));
  if (!cellTypes.length) return { rows: [], cellTypes: [], genes };
  const typeIndex = new Map(cellTypes.map((type, index) => [type, index]));
  const sums = cellTypes.map(() => new Float64Array(genes.length));
  const counts = new Uint32Array(cellTypes.length);

  for (const row of cellRows ?? []) {
    const index = typeIndex.get(String(row.cell_type ?? 'unassigned'));
    counts[index] += 1;
    genes.forEach((gene, geneIndex) => {
      const value = Number(row[gene]);
      if (Number.isFinite(value)) sums[index][geneIndex] += value;
    });
  }

  const rows = [];
  cellTypes.forEach((type, index) => {
    if (!counts[index]) return;
    genes.forEach((gene, geneIndex) => {
      rows.push({
        cell_type: type,
        gene,
        mean_expression: sums[index][geneIndex] / counts[index],
      });
    });
  });
  return { rows, cellTypes, genes };
}

/**
 * Compute event-triggered averages for every cell type.
 *
 * @param {{cellType: string, timestamps: ArrayLike<number>, values: ArrayLike<number>}[]} traces
 * @param {ArrayLike<number>} eventTimes
 * @returns {object[]}
 */
export function computeVisualLearningPsths(
  traces,
  eventTimes,
  { pre = PSTH_PRE, post = PSTH_POST, bins = PSTH_BINS } = {},
) {
  const window = pre + post;
  if (!(window > 0) || bins < 2 || !(eventTimes?.length)) return [];
  const groups = new Map();
  const binWidth = window / bins;
  for (const trace of traces ?? []) {
    const n = Math.min(trace.timestamps?.length ?? 0, trace.values?.length ?? 0);
    if (n < 2) continue;
    const start = Number(trace.timestamps[0]);
    const dt = (Number(trace.timestamps[n - 1]) - start) / (n - 1);
    if (!(dt > 0)) continue;
    const type = trace.cellType || 'unassigned';
    if (!groups.has(type)) {
      groups.set(type, {
        sum: new Float64Array(bins),
        sumSq: new Float64Array(bins),
        count: new Uint32Array(bins),
      });
    }
    const group = groups.get(type);
    for (const event of eventTimes) {
      const eventTime = Number(event);
      if (!Number.isFinite(eventTime)) continue;
      for (let bin = 0; bin < bins; bin += 1) {
        const lag = -pre + (bin + 0.5) * binWidth;
        const sample = Math.round((eventTime + lag - start) / dt);
        if (sample < 0 || sample >= n) continue;
        const value = Number(trace.values[sample]);
        if (!Number.isFinite(value)) continue;
        group.sum[bin] += value;
        group.sumSq[bin] += value * value;
        group.count[bin] += 1;
      }
    }
  }

  const rows = [];
  for (const [cellType, group] of groups) {
    for (let bin = 0; bin < bins; bin += 1) {
      const count = group.count[bin];
      if (!count) continue;
      const mean = group.sum[bin] / count;
      const variance = Math.max(0, group.sumSq[bin] / count - mean * mean);
      const sem = Math.sqrt(variance / count);
      rows.push({
        cell_type: cellType,
        lag: -pre + (bin + 0.5) * binWidth,
        mean,
        lo: mean - sem,
        hi: mean + sem,
        n: count,
      });
    }
  }
  return rows;
}

function sourceNameForAsset(asset, sourceMap) {
  return sourceNamesForAsset(asset, sourceMap).find(Boolean) ?? asset.name;
}

function sourceNamesForAsset(asset, sourceMap) {
  return sourceMap?.[asset.name]
    ?? sourceMap?.[asset.asset_name]
    ?? [];
}

function sessionKeyFromAsset(name) {
  const match = String(name ?? '').match(/_(\d{4,})_(\d{4}-\d{2}-\d{2})_/);
  return match ? match[1] + '_' + match[2] : null;
}

async function readSessionTraces(session, cellRows, coregRows, series, signal) {
  const joined = joinVisualLearningCells(coregRows, cellRows);
  if (!joined.length) return { traces: [], matched: 0, planes: 0 };
  const root = await openPophysNwb(session.asset_name, { signal });
  const byPlane = new Map();
  for (const row of joined) {
    if (!byPlane.has(row.plane)) byPlane.set(row.plane, []);
    byPlane.get(row.plane).push(row);
  }

  const traces = [];
  await Promise.all([...byPlane].map(async ([plane, rows]) => {
    const roiIds = rows.map((row) => row.roiId);
    const [timestamps, packed] = await Promise.all([
      loadPlaneTimestamps(root, plane, { signal }),
      loadRoiTraces(root, plane, roiIds, series, { signal }),
    ]);
    if (signal?.aborted) throw new Error('aborted');
    const nColumns = packed.nColumns || 0;
    for (const row of rows) {
      const column = row.roiId - packed.startRoi;
      if (column < 0 || column >= nColumns) continue;
      traces.push({
        cellType: row.cellType,
        cellSubclass: row.cellSubclass,
        timestamps,
        values: packed.data,
        valueOffset: column,
        nFrames: packed.nFrames,
      });
    }
  }));
  return { traces: traces.map(expandPackedTrace), matched: traces.length, planes: byPlane.size };
}

function expandPackedTrace(trace) {
  const values = new Float32Array(trace.nFrames);
  const nColumns = trace.values.length / trace.nFrames;
  for (let index = 0; index < trace.nFrames; index += 1) {
    values[index] = trace.values[index * nColumns + trace.valueOffset];
  }
  return {
    cellType: trace.cellType,
    cellSubclass: trace.cellSubclass,
    timestamps: trace.timestamps,
    values,
  };
}

/** Keep an externally supplied task zoom inside the trace time range. */
export function normaliseActivityTimeDomain(domain, minTime, maxTime) {
  const full = [Number(minTime), Number(maxTime)];
  if (!Number.isFinite(full[0]) || !Number.isFinite(full[1]) || full[1] <= full[0]) return null;
  const t0 = Number(domain?.[0]);
  const t1 = Number(domain?.[1]);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return full;
  const start = Math.max(full[0], Math.min(full[1], t0));
  const stop = Math.max(full[0], Math.min(full[1], t1));
  return stop > start ? [start, stop] : full;
}

function buildActivityPlot(heatmap, width, timeDomain = null) {
  if (!heatmap.rows.length) return null;
  const values = heatmap.rows.map((row) => row.activity).filter(Number.isFinite);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const domain = min === max ? [min - 1, max + 1] : [min, max];
  const xDomain = normaliseActivityTimeDomain(timeDomain, heatmap.minTime, heatmap.maxTime)
    ?? [heatmap.minTime, heatmap.maxTime];
  return Plot.plot({
    width: Math.max(520, width || 760),
    height: Math.max(260, heatmap.cellTypes.length * CELL_TYPE_ROW_HEIGHT + CELL_TYPE_ROW_BASE_HEIGHT),
    marginLeft: ACTIVITY_MARGIN_LEFT,
    marginBottom: ACTIVITY_MARGIN_BOTTOM,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: '10px' },
    // Task zoom only changes x. Keep the cell-type y domain fixed.
    x: { label: 'session time (s)', domain: xDomain },
    y: {
      label: 'cell type',
      domain: [0, heatmap.cellTypes.length],
      reverse: true,
      ticks: heatmap.cellTypes.map((_, index) => index + 0.5),
      tickFormat: (value) => heatmap.cellTypes[Math.floor(value)] ?? '',
    },
    color: { scheme: 'RdBu', domain, pivot: 0, legend: true, label: 'activity' },
    marks: [Plot.rect(heatmap.rows, {
      x1: 't0', x2: 't1', y1: 'y0', y2: 'y1', fill: 'activity', inset: 0.2,
    })],
  });
}

function buildGeneExpressionPlot(geneExpression, width) {
  if (!geneExpression.rows.length) return null;
  const values = geneExpression.rows.map((row) => row.mean_expression).filter(Number.isFinite);
  const max = Math.max(...values, 1e-9);
  return Plot.plot({
    width: Math.max(520, width || 760),
    height: Math.max(260, geneExpression.cellTypes.length * CELL_TYPE_ROW_HEIGHT + CELL_TYPE_ROW_BASE_HEIGHT),
    marginLeft: ACTIVITY_MARGIN_LEFT,
    marginBottom: ACTIVITY_MARGIN_BOTTOM,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: '10px' },
    x: { label: 'gene', domain: geneExpression.genes, tickRotate: -45 },
    // Band scales already put domain[0] at the top by default, matching the
    // reversed continuous scale in buildActivityPlot — do not add `reverse`
    // here or the two heatmaps' cell-type rows will land in opposite order.
    // padding: 0 matches the continuous scale's even division so rows line
    // up pixel-for-pixel between the two heatmaps.
    y: { label: 'cell type', domain: geneExpression.cellTypes, padding: 0 },
    color: { scheme: 'YlGnBu', domain: [0, max], legend: true, label: 'mean HCR counts' },
    marks: [Plot.cell(geneExpression.rows, {
      x: 'gene', y: 'cell_type', fill: 'mean_expression', inset: 0.5,
    })],
  });
}

function buildPsthPlot(rows, width) {
  if (!rows.length) return null;
  const cellTypes = [...new Set(rows.map((row) => row.cell_type))]
    .sort((a, b) => a.localeCompare(b));
  return Plot.plot({
    width: Math.max(520, width || 760),
    height: 320,
    marginLeft: 64,
    marginBottom: 42,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: '10px' },
    x: { label: 'time from event (s)', domain: [-PSTH_PRE, PSTH_POST] },
    y: { label: 'activity', grid: true },
    color: { domain: cellTypes, scheme: 'turbo', legend: true, label: 'cell type' },
    marks: [
      Plot.ruleX([0], { stroke: '#ef4444' }),
      Plot.ruleY([0], { stroke: '#9ca3af', strokeOpacity: 0.6 }),
      Plot.areaY(rows, { x: 'lag', y1: 'lo', y2: 'hi', fill: 'cell_type', fillOpacity: 0.12 }),
      Plot.lineY(rows, { x: 'lag', y: 'mean', stroke: 'cell_type', strokeWidth: 1.2 }),
    ],
  });
}

/** Build the dataset-level Visual Learning activity panels. */
export function createVisualLearningActivityView(coord, { onSelect = null, onSubclassActivity = null } = {}) {
  const section = document.createElement('section');
  section.className = 'swdb-visual-learning-activity';

  const heading = document.createElement('div');
  heading.className = 'swdb-visual-learning-activity-heading';
  const title = document.createElement('h2');
  title.textContent = 'Cell-type activity';
  heading.appendChild(title);
  const controls = document.createElement('div');
  controls.className = 'swdb-visual-learning-activity-controls';

  const sessionLabel = document.createElement('label');
  sessionLabel.textContent = 'Session';
  const sessionSelect = document.createElement('select');
  sessionLabel.appendChild(sessionSelect);
  const eventLabel = document.createElement('label');
  eventLabel.textContent = 'PSTH event';
  const eventSelect = document.createElement('select');
  eventLabel.appendChild(eventSelect);
  controls.append(sessionLabel, eventLabel);
  heading.appendChild(controls);
  section.appendChild(heading);

  const status = document.createElement('div');
  status.className = 'swdb-panel-status';
  status.textContent = 'Select a session to load cell-type activity.';
  section.appendChild(status);

  const cellTypeRow = document.createElement('div');
  cellTypeRow.className = 'swdb-visual-learning-activity-row';

  const activityColumn = document.createElement('div');
  activityColumn.className = 'swdb-visual-learning-activity-column';
  const activitySubheading = document.createElement('h3');
  activitySubheading.className = 'swdb-visual-learning-activity-subheading';
  activitySubheading.textContent = 'Physiology (dF/F)';
  const activityMount = document.createElement('div');
  activityMount.className = 'swdb-visual-learning-activity-heatmap';
  activityColumn.append(activitySubheading, activityMount);

  const geneColumn = document.createElement('div');
  geneColumn.className = 'swdb-visual-learning-activity-column';
  const geneHeading = document.createElement('h3');
  geneHeading.className = 'swdb-visual-learning-activity-subheading';
  geneHeading.textContent = 'Gene expression';
  const geneMount = document.createElement('div');
  geneMount.className = 'swdb-visual-learning-activity-gene';
  geneColumn.append(geneHeading, geneMount);

  cellTypeRow.append(activityColumn, geneColumn);

  const psthMount = document.createElement('div');
  psthMount.className = 'swdb-visual-learning-activity-psth';
  const activityChart = document.createElement('div');
  activityChart.className = 'swdb-visual-learning-activity-chart';
  const activityPlayhead = document.createElement('div');
  activityPlayhead.className = 'swdb-visual-learning-activity-playhead';
  activityPlayhead.hidden = true;
  activityChart.appendChild(activityPlayhead);
  activityMount.appendChild(activityChart);
  section.append(cellTypeRow, psthMount);

  let assetsByName = new Map();
  let sourceMap = {};
  let currentSession = null;
  let currentData = null;
  let currentHeatmap = null;
  let currentCellTypeOrder = [];
  let timeDomain = null;
  let currentTime = null;
  let controller = null;

  function updateActivityPlayhead() {
    const plot = activityChart.querySelector('svg');
    const domain = currentHeatmap
      ? normaliseActivityTimeDomain(timeDomain, currentHeatmap.minTime, currentHeatmap.maxTime)
      : null;
    const time = Number(currentTime);
    if (!plot || !domain || !Number.isFinite(time) || time < domain[0] || time > domain[1]) {
      activityPlayhead.hidden = true;
      return;
    }
    const width = Number(plot.getAttribute('width')) || plot.clientWidth || activityChart.clientWidth;
    const innerWidth = width - ACTIVITY_MARGIN_LEFT;
    if (!(innerWidth > 0) || !(domain[1] > domain[0])) {
      activityPlayhead.hidden = true;
      return;
    }
    const fraction = (time - domain[0]) / (domain[1] - domain[0]);
    activityPlayhead.style.left = `${ACTIVITY_MARGIN_LEFT + fraction * innerWidth}px`;
    activityPlayhead.style.height = `${Math.max(0, (Number(plot.getAttribute('height')) || 0) - ACTIVITY_MARGIN_BOTTOM)}px`;
    activityPlayhead.hidden = false;
  }

  function renderActivity() {
    activityChart.replaceChildren();
    const plot = currentHeatmap
      ? buildActivityPlot(currentHeatmap, activityColumn.clientWidth, timeDomain)
      : null;
    if (plot) activityChart.appendChild(plot);
    activityChart.appendChild(activityPlayhead);
    if (!activityMount.contains(activityChart)) activityMount.appendChild(activityChart);
    updateActivityPlayhead();
  }

  function renderGeneExpression(cellRows) {
    const geneExpression = aggregateGeneExpressionByCellType(cellRows);
    currentCellTypeOrder = geneExpression.cellTypes;
    geneMount.replaceChildren();
    const plot = buildGeneExpressionPlot(geneExpression, geneColumn.clientWidth);
    if (plot) geneMount.appendChild(plot);
  }

  function renderPsth() {
    const stream = currentData?.eventStreams?.find((candidate) => candidate.key === eventSelect.value);
    const rows = stream ? computeVisualLearningPsths(currentData.traces, stream.times) : [];
    psthMount.replaceChildren();
    const plot = buildPsthPlot(rows, section.clientWidth);
    if (plot) psthMount.appendChild(plot);
  }

  async function select(sessionOrName, { notify = true } = {}) {
    const session = typeof sessionOrName === 'string' ? assetsByName.get(sessionOrName) : sessionOrName;
    if (!session?.asset_name || !session.subject_id) return;
    currentSession = session;
    sessionSelect.value = session.asset_name;
    timeDomain = null;
    if (notify) onSelect?.(session);
    controller?.abort();
    controller = new AbortController();
    currentData = null;
    currentHeatmap = null;
    currentTime = null;
    activityMount.replaceChildren();
    geneMount.replaceChildren();
    psthMount.replaceChildren();
    eventSelect.replaceChildren();
    onSubclassActivity?.(null);
    status.textContent = 'Loading ' + session.asset_name + '…';
    try {
      const sessionKey = sessionKeyFromAsset(session.asset_name);
      const taskSource = await resolveVisualLearningPlaybackSource(
        coord,
        sourceNamesForAsset(session, sourceMap),
        { signal: controller.signal },
      ).catch((error) => {
        if (controller.signal.aborted) throw error;
        return null;
      });
      if (controller.signal.aborted) return;
      const rawName = taskSource?.name ?? sourceNameForAsset(session, sourceMap);
      const [cellRows, coregRows, behavior] = await Promise.all([
        loadVisualLearningCellTypes(coord, session.subject_id),
        loadVisualLearningCoreg(coord, session.subject_id, sessionKey),
        rawName
          ? loadBehaviorEvents(coord, rawName, { signal: controller.signal }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (controller.signal.aborted) return;
      renderGeneExpression(cellRows);
      const result = await readSessionTraces(
        session,
        cellRows,
        coregRows,
        TRACE_SERIES_KEY,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (!result.traces.length) {
        status.textContent = 'No registered cell-type traces are available for this session '
          + '(gene expression is unaffected — it does not require ROI registration).';
        onSubclassActivity?.(aggregateActivityBySubclassSeries([]));
        return;
      }
      const heatmap = aggregateActivityByCellType(result.traces, { cellTypeOrder: currentCellTypeOrder });
      currentHeatmap = heatmap;
      renderActivity();
      onSubclassActivity?.(aggregateActivityBySubclassSeries(result.traces));
      const eventStreams = EVENT_STREAMS
        .map((stream) => ({ ...stream, times: behavior?.[stream.key] ?? [] }))
        .filter((stream) => stream.times?.length);
      currentData = { ...result, eventStreams };
      eventSelect.replaceChildren(...eventStreams.map((stream) => {
        const option = document.createElement('option');
        option.value = stream.key;
        option.textContent = stream.label + ' (n=' + stream.times.length + ')';
        return option;
      }));
      eventSelect.disabled = eventStreams.length === 0;
      renderPsth();
      const matchedTypeCount = new Set(result.traces.map((trace) => trace.cellType || 'unassigned')).size;
      status.textContent = result.matched.toLocaleString() + ' registered cells across '
        + result.planes + ' planes · ' + matchedTypeCount + ' of ' + currentCellTypeOrder.length
        + ' annotated cell types have session traces';
      if (!eventStreams.length) status.textContent += ' · no task events available for PSTHs';
    } catch (error) {
      if (controller.signal.aborted) return;
      status.textContent = 'Could not load cell-type activity: ' + error.message;
      console.error('[SWDB] Visual Learning activity load failed', error);
    }
  }

  sessionSelect.addEventListener('change', () => select(sessionSelect.value));
  eventSelect.addEventListener('change', renderPsth);

  return {
    element: section,
    load(assets, nextSourceMap = {}) {
      sourceMap = nextSourceMap;
      const sessions = loadVisualLearningProgression(assets)
        .filter((session) => session.subject_id && session.asset_name)
        .sort((a, b) => String(a.session_date ?? '').localeCompare(String(b.session_date ?? '')));
      assetsByName = new Map(sessions.map((session) => [session.asset_name, session]));
      sessionSelect.replaceChildren(...sessions.map((session) => {
        const option = document.createElement('option');
        option.value = session.asset_name;
        option.textContent = String(session.subject_id) + ' · '
          + String(session.session_date ?? 'undated').slice(0, 10) + ' · '
          + String(session.session_type ?? 'session');
        return option;
      }));
      sessionSelect.disabled = sessions.length === 0;
      eventSelect.disabled = true;
      if (!sessions.length) status.textContent = 'No Visual Learning sessions are available.';
    },
    select,
    setTimeDomain(domain) {
      timeDomain = domain;
      if (currentHeatmap) renderActivity();
    },
    setCurrentTime(time) {
      currentTime = Number.isFinite(Number(time)) ? Number(time) : null;
      updateActivityPlayhead();
    },
    dispose() {
      controller?.abort();
    },
  };
}

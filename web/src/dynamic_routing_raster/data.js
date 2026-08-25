/**
 * Dynamic Routing ecephys raster data access.
 *
 * Trials come from the NWB-Zarr intervals/trials table so the condition labels
 * and spike clock are always from the same acquisition. Spikes/units use an
 * exact matching platform_ecephys cache partition when one exists; otherwise
 * this module reads one unit's ragged spike-time vector from the public NWB-
 * Zarr. The latter is the path used by the supplied 742903 test asset because
 * that derived asset does not yet have an exact ecephys cache partition.
 */

import * as zarr from 'zarrita';
import { DATA_CACHE_PREFIX } from '../constants.js';
import { getResolvedVersion } from '../lib/metadata.js';
import { queryRows } from '../lib/arrow.js';
import { resolveLatestDerived } from '../lib/raw-to-derived.js';

const OPEN_DATA_BASE = 'https://aind-open-data.s3.amazonaws.com';

const TRIAL_COLUMNS = [
  'trial_index', 'block_index', 'rewarded_modality', 'stim_name',
  'start_time', 'stop_time', 'stim_start_time', 'stim_stop_time',
  'is_target', 'is_nontarget', 'is_catch',
  'is_aud_target', 'is_vis_target', 'is_aud_nontarget', 'is_vis_nontarget',
];

const UNIT_COLUMNS = [
  'unit_id', 'device_name', 'is_qc_pass', 'decoder_label',
  'firing_rate', 'num_spikes', 'structure', 'location',
  'electrode_group_name', 'ccf_ap', 'ccf_dv', 'ccf_ml',
];

// The SWDB overview only needs the small location catalog, not trial data or
// ragged spike times. Keeping this list separate avoids pulling unrelated unit
// metrics when several acquisitions are shown together.
const UNIT_LOCATION_COLUMNS = [
  'unit_id', 'device_name', 'structure', 'location', 'electrode_group_name',
  'ccf_ap', 'ccf_dv', 'ccf_ml',
];

const _nwbBaseCache = new Map();
const _cacheFiles = new Map();

function toNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asString(value) {
  if (value == null) return null;
  return String(value);
}

export function unitProbeName(unit) {
  return unit.probeName ?? unit.deviceName ?? 'unknown probe';
}

export function unitProbeKey(unit) {
  return `${unit.experiment ?? 'experiment'}::${unitProbeName(unit)}`;
}

export function unitArea(unit) {
  return unit.structure ?? unit.location ?? 'unknown area';
}

export function unitAreaKey(unit) {
  return `${unit.experiment ?? 'experiment'}::${unitArea(unit)}`;
}

export function filterUnits(units, { probeKey = null, areaKey = null } = {}) {
  return units.filter((unit) => (
    (!probeKey || unitProbeKey(unit) === probeKey)
    && (!areaKey || unitAreaKey(unit) === areaKey)
  ));
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parquetList(urls) {
  return `[${urls.map(sqlString).join(', ')}]`;
}

export function assertRasterAssetName(asset) {
  if (!/^[A-Za-z0-9_.-]+$/.test(asset ?? '')) {
    throw new Error(`Invalid ecephys asset name: ${asset}`);
  }
  return asset;
}

/** Parse the public S3 delimiter listing used to discover the NWB-Zarr root. */
export function findNwbZarrPrefix(xml, asset) {
  const key = assertRasterAssetName(asset);
  const prefix = `${key}/`;
  return [...String(xml ?? '').matchAll(
    /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g,
  )]
    .map((match) => match[1])
    .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith('.nwb.zarr/'))
    .sort()[0] ?? null;
}

export async function resolveNwbZarrBase(asset, { signal } = {}) {
  const key = assertRasterAssetName(asset);
  if (_nwbBaseCache.has(key)) return _nwbBaseCache.get(key);

  const promise = (async () => {
    const url = `${OPEN_DATA_BASE}/?list-type=2&prefix=${encodeURIComponent(`${key}/`)}`
      + `&delimiter=${encodeURIComponent('/')}&max-keys=1000`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`NWB-Zarr listing failed (${response.status})`);
    const prefix = findNwbZarrPrefix(await response.text(), key);
    if (!prefix) throw new Error('No NWB-Zarr root found for this asset');
    return `${OPEN_DATA_BASE}/${prefix.replace(/\/$/, '')}`;
  })();

  _nwbBaseCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    _nwbBaseCache.delete(key);
    throw error;
  }
}

function normalizeTrial(row) {
  return {
    trial: toNumber(row.trial_index),
    block: toNumber(row.block_index),
    context: asString(row.rewarded_modality),
    stim: asString(row.stim_name),
    start: toNumber(row.start_time),
    stop: toNumber(row.stop_time),
    stimStart: toNumber(row.stim_start_time),
    stimStop: toNumber(row.stim_stop_time),
    isTarget: !!row.is_target,
    isNontarget: !!row.is_nontarget,
    isCatch: !!row.is_catch,
    isAudTarget: !!row.is_aud_target,
    isVisTarget: !!row.is_vis_target,
    isAudNontarget: !!row.is_aud_nontarget,
    isVisNontarget: !!row.is_vis_nontarget,
  };
}

/**
 * Convert a real DR trial into the viewer's five condition labels.
 * The `is_rewarded` outcome is intentionally not used here.
 */
export function classifyTrial(trial) {
  if (trial.isCatch || trial.stim === 'catch') return 'catch';
  const modality = trial.isVisTarget || trial.isVisNontarget || /^vis/.test(trial.stim ?? '')
    ? 'visual' : 'auditory';
  const status = trial.isTarget ? 'target' : trial.isNontarget ? 'nontarget' : 'unknown';
  return status === 'unknown' ? 'unknown' : `${modality}_${status}`;
}

export function normalizeTrialRows(rows) {
  return rows
    .map(normalizeTrial)
    .map((trial) => ({ ...trial, condition: classifyTrial(trial) }))
    .filter((trial) => Number.isFinite(trial.stimStart) && trial.context);
}

export function buildConditionPanels(trials, { includeCatch = true } = {}) {
  const order = ['vis_visual_target', 'vis_visual_nontarget', 'vis_auditory_target',
    'vis_auditory_nontarget', 'aud_visual_target', 'aud_visual_nontarget',
    'aud_auditory_target', 'aud_auditory_nontarget'];
  const labels = {
    vis_visual_target: 'VIS context · vis+',
    vis_visual_nontarget: 'VIS context · vis-',
    vis_auditory_target: 'VIS context · aud+',
    vis_auditory_nontarget: 'VIS context · aud-',
    aud_visual_target: 'AUD context · vis+',
    aud_visual_nontarget: 'AUD context · vis-',
    aud_auditory_target: 'AUD context · aud+',
    aud_auditory_nontarget: 'AUD context · aud-',
    catch: 'Catch trials',
  };
  const map = new Map();
  for (const trial of trials) {
    if (!includeCatch && trial.condition === 'catch') continue;
    const key = trial.condition === 'catch' ? 'catch' : `${trial.context}_${trial.condition}`;
    if (!map.has(key)) map.set(key, {
      key, label: labels[key] ?? key, context: trial.context,
      condition: trial.condition, trials: [],
    });
    map.get(key).trials.push(trial);
  }
  return [...map.values()].sort((a, b) => {
    const ai = order.indexOf(a.key);
    const bi = order.indexOf(b.key);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (a.key === 'catch') return 1;
    if (b.key === 'catch') return -1;
    return a.key.localeCompare(b.key);
  });
}

export function buildRasterRows(spikeTimes, trials, preS, postS, rowOffset = 0) {
  const rows = [];
  const times = Array.from(spikeTimes ?? [], Number).filter(Number.isFinite);
  for (let row = 0; row < trials.length; row++) {
    const trial = trials[row];
    if (!Number.isFinite(trial.stimStart)) continue;
    const lo = trial.stimStart + preS;
    const hi = trial.stimStart + postS;
    for (const spike of times) {
      if (spike < lo) continue;
      if (spike > hi) break;
      rows.push({ relative: spike - trial.stimStart, row: rowOffset + row, trial: trial.trial });
    }
  }
  return rows;
}

async function openArray(root, path, options = {}) {
  const array = await zarr.open(root.resolve(path), { kind: 'array' });
  return { array, chunk: await zarr.get(array, null, options) };
}

async function readTrialData(root, signal) {
  const entries = await Promise.all(TRIAL_COLUMNS.map(async (column) => {
    const { chunk } = await openArray(root, `intervals/trials/${column}`, { signal });
    return [column, Array.from(chunk.data)];
  }));
  if (signal?.aborted) throw new Error('aborted');
  const columns = Object.fromEntries(entries);
  const n = columns.trial_index?.length ?? 0;
  return normalizeTrialRows(Array.from({ length: n }, (_, i) =>
    Object.fromEntries(TRIAL_COLUMNS.map((column) => [column, columns[column]?.[i]]))));
}

async function readRawUnits(root, signal) {
  const entries = await Promise.all(UNIT_COLUMNS.map(async (column) => {
    const { chunk } = await openArray(root, `units/${column}`, { signal });
    return [column, Array.from(chunk.data)];
  }));
  const indexArray = await zarr.open(root.resolve('units/spike_times_index'), { kind: 'array' });
  const indexChunk = await zarr.get(indexArray, null, { signal });
  const spikeArray = await zarr.open(root.resolve('units/spike_times'), { kind: 'array' });
  const columns = Object.fromEntries(entries);
  const ends = Array.from(indexChunk.data, Number);
  const n = columns.unit_id?.length ?? ends.length;
  const units = Array.from({ length: n }, (_, index) => ({
    key: `raw:${index}`,
    index,
    unitName: asString(columns.unit_id?.[index]) ?? `unit-${index}`,
    deviceName: asString(columns.device_name?.[index]) ?? 'unknown device',
    probeName: asString(columns.electrode_group_name?.[index])
      ?? asString(columns.device_name?.[index])
      ?? 'unknown probe',
    experiment: 'raw NWB-Zarr',
    qc: !!columns.is_qc_pass?.[index],
    decoderLabel: asString(columns.decoder_label?.[index]),
    firingRate: toNumber(columns.firing_rate?.[index]),
    numSpikes: toNumber(columns.num_spikes?.[index]),
    structure: asString(columns.structure?.[index]),
    location: asString(columns.location?.[index]),
    ccfAp: toNumber(columns.ccf_ap?.[index]),
    ccfDv: toNumber(columns.ccf_dv?.[index]),
    ccfMl: toNumber(columns.ccf_ml?.[index]),
    start: index === 0 ? 0 : ends[index - 1],
    stop: ends[index],
  }));
  return { units, spikeArray };
}

async function readRawUnitLocations(root, signal) {
  const entries = await Promise.all(UNIT_LOCATION_COLUMNS.map(async (column) => {
    const { chunk } = await openArray(root, `units/${column}`, { signal });
    return [column, Array.from(chunk.data)];
  }));
  if (signal?.aborted) throw new Error('aborted');
  const columns = Object.fromEntries(entries);
  const n = columns.unit_id?.length ?? 0;
  return Array.from({ length: n }, (_, index) => ({
    key: `raw:${index}`,
    index,
    unitName: asString(columns.unit_id?.[index]) ?? `unit-${index}`,
    deviceName: asString(columns.device_name?.[index]) ?? 'unknown device',
    probeName: asString(columns.electrode_group_name?.[index])
      ?? asString(columns.device_name?.[index])
      ?? 'unknown probe',
    structure: asString(columns.structure?.[index]),
    location: asString(columns.location?.[index]),
    ccfAp: toNumber(columns.ccf_ap?.[index]),
    ccfDv: toNumber(columns.ccf_dv?.[index]),
    ccfMl: toNumber(columns.ccf_ml?.[index]),
  }));
}

async function readRawSpikes(spikeArray, unit, signal) {
  const start = Math.max(0, Math.floor(Number(unit.start) || 0));
  const stop = Math.max(start, Math.floor(Number(unit.stop) || start));
  if (stop <= start) return new Float64Array();
  const chunk = await zarr.get(spikeArray, [zarr.slice(start, stop)], { signal });
  if (signal?.aborted) throw new Error('aborted');
  return Float64Array.from(chunk.data, Number);
}

async function listCacheFiles(kind, asset, signal) {
  const key = `${kind}:${asset}:${getResolvedVersion()}`;
  if (_cacheFiles.has(key)) return _cacheFiles.get(key);
  const promise = (async () => {
    const prefix = `data-asset-cache/${getResolvedVersion()}/platform_ecephys_${kind}/asset_name=${asset}/`;
    const url = `${DATA_CACHE_PREFIX.replace(/\/data-asset-cache$/, '')}`
      + `/?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    const response = await fetch(url, { signal });
    if (!response.ok) return [];
    return [...(await response.text()).matchAll(/<Key>([^<]+\.pqt)<\/Key>/g)]
      .map((match) => `${DATA_CACHE_PREFIX.replace(/\/data-asset-cache$/, '')}/${match[1]}`)
      .sort();
  })();
  _cacheFiles.set(key, promise);
  try { return await promise; } catch (error) { _cacheFiles.delete(key); throw error; }
}

async function tryLoadCache(coord, asset, signal) {
  if (!coord) return null;
  const [spikeFiles, unitFiles] = await Promise.all([
    listCacheFiles('spikes', asset, signal),
    listCacheFiles('units', asset, signal),
  ]);
  if (!spikeFiles.length || !unitFiles.length) return null;
  const units = await queryRows(coord, `
    SELECT experiment, device_name, unit_name, default_qc, decoder_label,
           firing_rate, num_spikes, structure, depth
    FROM read_parquet(${parquetList(unitFiles)})
    ORDER BY device_name, unit_name
  `);
  return {
    source: 'cache',
    sourceLabel: `ecephys cache ${getResolvedVersion()}`,
    spikeFiles,
    units: units.map((unit) => ({
      key: `cache:${unit.experiment}:${unit.device_name}:${unit.unit_name}`,
      unitName: asString(unit.unit_name),
      deviceName: asString(unit.device_name),
      experiment: asString(unit.experiment),
      qc: !!unit.default_qc,
      decoderLabel: asString(unit.decoder_label),
      firingRate: toNumber(unit.firing_rate),
      numSpikes: toNumber(unit.num_spikes),
      structure: asString(unit.structure),
      location: null,
      probeName: asString(unit.device_name),
      ccfAp: null,
      ccfDv: null,
      ccfMl: null,
      depth: toNumber(unit.depth),
    })),
  };
}

async function readCachedSpikes(coord, source, unit, signal) {
  const rows = await queryRows(coord, `
    SELECT spike_time
    FROM read_parquet(${parquetList(source.spikeFiles)})
    WHERE experiment = ${sqlString(unit.experiment)}
      AND device_name = ${sqlString(unit.deviceName)}
      AND unit_name = ${sqlString(unit.unitName)}
      AND spike_time IS NOT NULL
    ORDER BY spike_time
  `);
  if (signal?.aborted) throw new Error('aborted');
  return Float64Array.from(rows, (row) => Number(row.spike_time)).filter(Number.isFinite);
}

/**
 * Load only the CCF unit-location catalog for one public Dynamic Routing asset.
 *
 * This is intentionally separate from loadRasterSession: the SWDB overview
 * needs locations from every acquisition, but does not need trials or spikes.
 * The public SWDB files are derived ecephys NWB-Zarr assets, so their unit
 * coordinate arrays can be read directly without opening the merged HDF5 NWB.
 *
 * @param {string} asset - Public ecephys asset name.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadRasterUnitLocations(asset, { signal } = {}) {
  const key = assertRasterAssetName(asset);
  const base = await resolveNwbZarrBase(key, { signal });
  const root = zarr.root(new zarr.FetchStore(base));
  return readRawUnitLocations(root, signal);
}

/**
 * Load the condition table and unit catalog. Spike times stay lazy until a
 * neuron is selected, which keeps the initial page lightweight.
 */
export async function loadRasterSession(coord, asset, { signal } = {}) {
  const key = assertRasterAssetName(asset);
  let resolvedAsset = key;
  let base;
  try {
    base = await resolveNwbZarrBase(key, { signal });
  } catch (initialError) {
    // /view's acquisition timeline points at the raw acquisition, while the
    // public NWB-Zarr is often a derived ecephys asset. Follow the canonical
    // source_data relationship instead of guessing a derived name.
    const derived = await resolveLatestDerived(coord, key, { modality: 'ecephys' });
    if (!derived?.name) throw initialError;
    resolvedAsset = assertRasterAssetName(derived.name);
    base = await resolveNwbZarrBase(resolvedAsset, { signal });
  }
  const root = zarr.root(new zarr.FetchStore(base));
  const [trials, cached] = await Promise.all([
    readTrialData(root, signal),
    tryLoadCache(coord, key, signal).catch((error) => {
      console.warn('[dynamic-routing-raster] cache lookup failed; using NWB-Zarr', error);
      return null;
    }),
  ]);
  if (signal?.aborted) throw new Error('aborted');

  if (cached) {
    return {
      asset: resolvedAsset, requestedAsset: key, trials,
      source: cached.source, sourceLabel: cached.sourceLabel,
      units: cached.units,
      loadSpikes: (unit, options = {}) => readCachedSpikes(coord, cached, unit, options.signal),
    };
  }

  const raw = await readRawUnits(root, signal);
  return {
    asset: resolvedAsset, requestedAsset: key, trials,
    source: 'nwb-zarr', sourceLabel: 'raw NWB-Zarr fallback',
    units: raw.units,
    loadSpikes: (unit, options = {}) => readRawSpikes(raw.spikeArray, unit, options.signal),
  };
}

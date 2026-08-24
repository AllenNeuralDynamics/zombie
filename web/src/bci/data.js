/**
 * bci/data.js — task data adapter for the Brain-Computer Interface sessions.
 *
 * BCI processing assets do not contain the NWB-Zarr layout used by the general
 * pophys viewer.  Their task NWB is a separate `*_behavior_nwb` Zarr store;
 * the calcium products alongside it are HDF5 and are intentionally not read
 * by this browser-side adapter.  The task table is small, so we load its
 * scalar/vector columns in full and keep the wide HDF5 trace out of the path.
 */

import * as zarr from 'zarrita';

const S3_BASE = 'https://aind-open-data.s3.amazonaws.com';
const ROOT_CACHE = new Map();

const TRIAL_ARRAYS = [
  'start_time',
  'stop_time',
  'go_cue',
  'hit',
  'lick_L',
  'reward_time',
  'threshold_crossing_times',
  'zaber_step_times',
  'conditioned_neuron_x',
  'conditioned_neuron_y',
  'closest_roi',
];

export function assertAssetName(asset) {
  if (!/^[A-Za-z0-9_.-]+$/.test(asset ?? '')) {
    throw new Error(`Invalid BCI asset name: ${asset}`);
  }
  return asset;
}

function commonPrefixes(xml, asset) {
  const prefix = `${assertAssetName(asset)}/`;
  return [...String(xml ?? '').matchAll(
    /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g,
  )]
    .map((m) => m[1])
    .filter((key) => key.startsWith(prefix));
}

/** Find the BCI task NWB-Zarr directory under an asset prefix. */
export function findBciBehaviorPrefix(xml, asset) {
  return commonPrefixes(xml, asset)
    .find((key) => /_behavior_nwb\/$/.test(key)) ?? null;
}

/** Find the processing directory that contains the BCI FOV side artifacts. */
export function findBciProcessingPrefix(xml, asset) {
  return commonPrefixes(xml, asset)
    .filter((key) => !/_behavior_nwb\/$/.test(key) && !/original_metadata\/$/.test(key))
    .sort()[0] ?? null;
}

async function resolveBciRoots(asset, { signal } = {}) {
  const key = assertAssetName(asset);
  if (ROOT_CACHE.has(key)) return ROOT_CACHE.get(key);

  const promise = (async () => {
    const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(key)}/`
      + `&delimiter=${encodeURIComponent('/')}&max-keys=1000`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`BCI asset listing failed (${response.status})`);
    const xml = await response.text();
    const behaviorPrefix = findBciBehaviorPrefix(xml, key);
    if (!behaviorPrefix) throw new Error('No BCI behavior NWB-Zarr store found for this asset');
    const processingPrefix = findBciProcessingPrefix(xml, key);
    return {
      behaviorBase: `${S3_BASE}/${behaviorPrefix.replace(/\/$/, '')}`,
      processingBase: processingPrefix
        ? `${S3_BASE}/${processingPrefix.replace(/\/$/, '')}`
        : null,
    };
  })();

  ROOT_CACHE.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    ROOT_CACHE.delete(key);
    throw err;
  }
}

/** Exposed for unit tests and diagnostics; normal callers use loadBciSession. */
export async function resolveBciBehaviorBase(asset, options = {}) {
  return (await resolveBciRoots(asset, options)).behaviorBase;
}

/** Build the optional FOV backdrop URL from the discovered processing root. */
export function bciFovUrl(processingBase) {
  if (!processingBase) return null;
  const name = String(processingBase).replace(/\/$/, '').split('/').pop();
  if (!name) return null;
  return `${processingBase}/motion_correction/${name}_maximum_projection.png`;
}

async function loadArray(root, path, { signal, optional = false } = {}) {
  try {
    const array = await zarr.open(root.resolve(path), { kind: 'array' });
    const chunk = await zarr.get(array);
    if (signal?.aborted) throw new Error('aborted');
    return {
      data: Array.from(chunk.data, (value) => typeof value === 'bigint' ? Number(value) : value),
      shape: [...array.shape],
    };
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

function values(array) {
  return array?.data ?? array ?? [];
}

function shape(array) {
  return array?.shape ?? [values(array).length];
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function eventTime(trialStart, value) {
  const n = finite(value);
  return n != null && n > 0 ? trialStart + n : null;
}

function rowValues(array, row) {
  const data = values(array);
  const dims = shape(array);
  if (dims.length < 2) return [data[row]];
  const width = dims.slice(1).reduce((acc, n) => acc * n, 1);
  return data.slice(row * width, (row + 1) * width);
}

function compactFinite(row, min = 0) {
  return row.map(finite).filter((value) => value != null && value > min);
}

/**
 * Convert the raw BCI trial columns into the common session-clock-relative
 * shape consumed by the player, plot, and animation.
 */
export function normalizeBciTrials(raw) {
  const starts = values(raw.start_time).map(finite).filter((value) => value != null);
  const stops = values(raw.stop_time).map(finite);
  if (!starts.length) throw new Error('BCI behavior NWB contains no trials');

  const sessionClockStart = starts[0];
  const nTrials = starts.length;
  const trials = [];
  const goCues = [];
  const thresholdCrossings = [];
  const rewards = [];
  const licks = [];
  const zaberSteps = [];

  for (let i = 0; i < nTrials; i++) {
    const start = starts[i] - sessionClockStart;
    const stop = (stops[i] ?? starts[i]) - sessionClockStart;
    const goCue = eventTime(start, values(raw.go_cue)[i]);
    const threshold = eventTime(start, values(raw.threshold_crossing_times)[i]);
    const reward = eventTime(start, values(raw.reward_time)[i]);
    const trialLicks = compactFinite(rowValues(raw.lick_L, i));
    const trialSteps = compactFinite(rowValues(raw.zaber_step_times, i));
    const targetX = finite(values(raw.conditioned_neuron_x)[i]);
    const targetY = finite(values(raw.conditioned_neuron_y)[i]);
    const roi = finite(values(raw.closest_roi)[i]);
    const trial = {
      index: i + 1,
      start,
      stop,
      duration: Math.max(0, stop - start),
      goCue,
      threshold,
      reward,
      hit: Boolean(values(raw.hit)[i]),
      targetX,
      targetY,
      roi,
      licks: trialLicks.map((t) => start + t),
      zaberSteps: trialSteps.map((t) => start + t),
    };
    trials.push(trial);

    if (goCue != null) goCues.push({ t: goCue, trial: i + 1 });
    if (threshold != null) thresholdCrossings.push({ t: threshold, trial: i + 1 });
    if (reward != null) rewards.push({ t: reward, trial: i + 1 });
    trialLicks.forEach((t) => licks.push({ t: start + t, trial: i + 1 }));
    trialSteps.forEach((t, step) => zaberSteps.push({ t: start + t, trial: i + 1, step }));
  }

  const sessionEnd = Math.max(...trials.map((trial) => trial.stop));
  const targetChanges = [];
  let previousTarget = null;
  for (const trial of trials) {
    const target = trial.targetX != null && trial.targetY != null
      ? { x: trial.targetX, y: trial.targetY, roi: trial.roi }
      : null;
    const key = target ? `${target.x.toFixed(4)}|${target.y.toFixed(4)}|${target.roi}` : 'none';
    if (key !== previousTarget) {
      targetChanges.push({
        trial: trial.index,
        targetX: target?.x ?? null,
        targetY: target?.y ?? null,
        roi: target?.roi ?? null,
      });
      previousTarget = key;
    }
  }

  return {
    trials,
    sessionEnd,
    sessionClockStart,
    goCues,
    thresholdCrossings,
    rewards,
    licks,
    zaberSteps,
    targetChanges,
    target: targetChanges.find((change) => change.targetX != null && change.targetY != null) ?? null,
    counts: {
      trials: trials.length,
      hits: trials.filter((trial) => trial.hit).length,
      rewards: rewards.length,
      licks: licks.length,
      thresholdCrossings: thresholdCrossings.length,
      zaberSteps: zaberSteps.length,
    },
  };
}

export function findBciTrialAt(trials, t) {
  if (!trials?.length) return -1;
  let lo = 0;
  let hi = trials.length - 1;
  if (t < trials[0].start || t > trials[hi].stop) return -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const trial = trials[mid];
    if (t < trial.start) hi = mid - 1;
    else if (t > trial.stop) lo = mid + 1;
    else return mid;
  }
  return Math.min(trials.length - 1, Math.max(0, lo));
}

/** Load the compact behavior NWB arrays for one derived BCI asset. */
export async function loadBciSession(asset, { signal } = {}) {
  const key = assertAssetName(asset);
  const roots = await resolveBciRoots(key, { signal });
  if (signal?.aborted) throw new Error('aborted');

  const root = zarr.root(new zarr.FetchStore(roots.behaviorBase));
  const rawEntries = await Promise.all(TRIAL_ARRAYS.map(async (name) => [
    name,
    await loadArray(root, `stimulus/presentation/Trials/${name}`, { signal }),
  ]));
  if (signal?.aborted) throw new Error('aborted');

  return {
    ...normalizeBciTrials(Object.fromEntries(rawEntries)),
    asset,
    behaviorBase: roots.behaviorBase,
    processingBase: roots.processingBase,
    fovUrl: bciFovUrl(roots.processingBase),
  };
}

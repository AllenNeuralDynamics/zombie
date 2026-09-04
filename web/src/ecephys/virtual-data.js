import ReferenceStore from '@zarrita/storage/ref';
import * as zarr from 'zarrita';
import { DATA_CACHE_PREFIX } from '../constants.js';
import { getResolvedVersion } from '../lib/metadata.js';

const TIME_BINS = 250;
const DEPTH_BINS = 120;
const HI_QUANTILE = 0.999;
const PSTH_PRE = -2;
const PSTH_POST = 4;
const PSTH_BINS = 120;
const PSTH_BIN_WIDTH = (PSTH_POST - PSTH_PRE) / PSTH_BINS;
const QUANTILE_SAMPLE_SIZE = 200_000;

const UNIT_FIELDS = [
  'decoder_label', 'default_qc', 'firing_rate', 'snr', 'num_spikes',
  'presence_ratio', 'isi_violations_ratio', 'amplitude_median', 'depth',
  'extremum_channel_index',
];

function assertAssetName(assetName) {
  const value = String(assetName ?? '');
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error('Invalid ecephys asset name');
  return value;
}

function asValues(data) {
  if (data && typeof data.get === 'function') {
    return Array.from({ length: data.length }, (_, i) => data.get(i));
  }
  return Array.from(data ?? []);
}

function asNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function asBoolean(value) {
  if (typeof value === 'string') return !['', '0', 'false', 'no', 'fail'].includes(value.toLowerCase());
  return Boolean(value);
}

function numericCompare(a, b, direction) {
  const av = asNumber(a);
  const bv = asNumber(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return direction === 'ASC' ? av - bv : bv - av;
}

function stringCompare(a, b, direction) {
  const av = String(a ?? '');
  const bv = String(b ?? '');
  return direction === 'ASC' ? av.localeCompare(bv) : bv.localeCompare(av);
}

function quantile(sample, q) {
  if (!sample.length) return null;
  const values = sample.slice().sort((a, b) => a - b);
  const index = (values.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function updateSample(sample, value, seen) {
  if (sample.length < QUANTILE_SAMPLE_SIZE) {
    sample.push(value);
    return;
  }
  // Deterministic reservoir sampling keeps repeated source switches stable.
  const slot = (seen * 1_103_515_245 + 12_345) % (seen + 1);
  if (slot < QUANTILE_SAMPLE_SIZE) sample[slot] = value;
}

function manifestUrl(assetName) {
  const version = getResolvedVersion();
  if (!version) throw new Error('Cache version is not resolved');
  return `${DATA_CACHE_PREFIX}/${version}/platform_ecephys_virtual/asset_name=${assertAssetName(assetName)}/virtual-zarr.json`;
}

function sourceHasArray(source, name) {
  return Boolean(source?.arrays?.[name]);
}

function unitRow(source, index, fields, names, devices, ends) {
  const unitName = String(names[index] ?? '');
  const deviceName = String(devices[index] ?? '');
  const end = Number(ends[index] ?? 0);
  const start = index ? Number(ends[index - 1] ?? 0) : 0;
  const row = {
    experiment: source.experiment,
    unit_name: unitName,
    device_name: deviceName,
    decoder_label: fields.decoder_label?.[index] ?? null,
    default_qc: asBoolean(fields.default_qc?.[index]),
    firing_rate: asNumber(fields.firing_rate?.[index]),
    snr: asNumber(fields.snr?.[index]),
    num_spikes: asNumber(fields.num_spikes?.[index]) ?? Math.max(0, end - start),
    presence_ratio: asNumber(fields.presence_ratio?.[index]),
    isi_violations_ratio: asNumber(fields.isi_violations_ratio?.[index]),
    amplitude_median: asNumber(fields.amplitude_median?.[index]),
    depth: asNumber(fields.depth?.[index]),
    waveform: null,
    _source: source,
    _index: index,
    _spikeStart: start,
    _spikeEnd: end,
    _extremumChannelIndex: asNumber(fields.extremum_channel_index?.[index]),
  };
  return row;
}

/**
 * Create a browser data source backed by one published virtual-Zarr manifest.
 * The public methods intentionally mirror the queries used by the Parquet
 * ecephys playback so the page can switch sources without changing its UI.
 */
export async function createVirtualEcephysSource(assetName, { signal } = {}) {
  const url = manifestUrl(assetName);
  const response = await fetch(url, { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Virtual ecephys manifest request failed (${response.status})`);
  const manifest = await response.json();
  if (manifest?.version !== 1 || !manifest?.refs || !manifest?.metadata?.sources?.length) return null;

  const store = ReferenceStore.fromSpec(manifest);
  const root = zarr.root(store);
  const arrayCache = new Map();
  const stateCache = new Map();

  async function openArray(source, name) {
    if (!sourceHasArray(source, name)) return null;
    const key = `${source.group_path}/${name}`;
    if (!arrayCache.has(key)) {
      arrayCache.set(key, zarr.open(root.resolve(`${source.group_path}/units/${name}`), {
        kind: 'array', attrs: false, signal,
      }));
    }
    return arrayCache.get(key);
  }

  async function readArray(source, name, selection = null, options = {}) {
    const array = await openArray(source, name);
    if (!array) return null;
    return zarr.get(array, selection, { signal: options.signal ?? signal });
  }

  async function loadState(source) {
    if (stateCache.has(source.group_path)) return stateCache.get(source.group_path);
    const promise = (async () => {
      const identityName = sourceHasArray(source, 'unit_name')
        ? 'unit_name'
        : sourceHasArray(source, 'id') ? 'id' : 'unit_id';
      if (!identityName || !sourceHasArray(source, 'spike_times_index')) return { units: [] };
      const namesResult = await readArray(source, identityName);
      const endsResult = await readArray(source, 'spike_times_index');
      const fields = {};
      const fieldResults = await Promise.all(UNIT_FIELDS.map(async (name) => [name, await readArray(source, name)]));
      for (const [name, result] of fieldResults) fields[name] = result ? asValues(result.data) : null;
      const names = asValues(namesResult?.data);
      const ends = asValues(endsResult?.data);
      let devices = null;
      if (sourceHasArray(source, 'device_name')) {
        const result = await readArray(source, 'device_name');
        devices = asValues(result?.data);
      }
      devices ??= new Array(names.length).fill('');
      return {
        units: names.map((_, index) => unitRow(source, index, fields, names, devices, ends)),
        spikeCount: Number(ends[ends.length - 1] ?? 0),
      };
    })();
    stateCache.set(source.group_path, promise);
    return promise;
  }

  async function allStates() {
    return Promise.all(manifest.metadata.sources.map(loadState));
  }

  async function unitsForProbe(probe) {
    const states = await allStates();
    return states.flatMap((state) => state.units.filter((u) => String(u.device_name) === String(probe)));
  }

  async function readUnitSeries(units, options = {}) {
    const bySource = new Map();
    for (const unit of units) {
      let sourceUnits = bySource.get(unit._source);
      if (!sourceUnits) { sourceUnits = []; bySource.set(unit._source, sourceUnits); }
      sourceUnits.push(unit);
    }
    const series = [];
    for (const [source, sourceUnits] of bySource) {
      const array = await openArray(source, 'spike_times');
      if (!array) continue;
      const ordered = sourceUnits.slice().sort((a, b) => a._index - b._index);
      let run = [];
      const flush = async () => {
        if (!run.length) return;
        const start = run[0]._spikeStart;
        const end = run[run.length - 1]._spikeEnd;
        const chunk = await zarr.get(array, [zarr.slice(start, end)], { signal: options.signal ?? signal });
        const values = Array.from(chunk.data ?? []);
        for (const unit of run) {
          const from = unit._spikeStart - start;
          const to = unit._spikeEnd - start;
          series.push({ unit, times: values.slice(from, to).map(Number).filter(Number.isFinite) });
        }
        run = [];
      };
      for (const unit of ordered) {
        if (run.length && unit._spikeStart !== run[run.length - 1]._spikeEnd) await flush();
        run.push(unit);
      }
      await flush();
    }
    return series;
  }

  async function loadProbes() {
    const states = await allStates();
    const probes = new Map();
    for (const state of states) {
      for (const unit of state.units) {
        const key = String(unit.device_name);
        const probe = probes.get(key) ?? { device_name: key, nunits: 0, nspikes: 0 };
        probe.nunits += 1;
        probe.nspikes += Math.max(0, unit._spikeEnd - unit._spikeStart);
        probes.set(key, probe);
      }
    }
    return [...probes.values()].sort((a, b) => a.device_name.localeCompare(b.device_name));
  }

  async function loadBins(probe) {
    const series = await readUnitSeries(await unitsForProbe(probe));
    const sample = [];
    let lo = Infinity;
    let seen = 0;
    const byUnit = [];
    for (const entry of series) {
      let count = 0;
      for (const time of entry.times) {
        if (time < 0) continue;
        lo = Math.min(lo, time);
        updateSample(sample, time, seen++);
        count += 1;
      }
      byUnit.push({ entry, count });
    }
    const hi = quantile(sample, HI_QUANTILE);
    if (!(hi > lo)) return { bins: [], lo: 0, hi: 0 };
    const width = (hi - lo) / TIME_BINS;
    byUnit.sort((a, b) => b.count - a.count);
    const bins = [];
    byUnit.forEach(({ entry }, uidx) => {
      for (const time of entry.times) {
        if (time < lo || time > hi) continue;
        bins.push({ uidx, tbin: Math.min(TIME_BINS - 1, Math.floor((time - lo) / width)), n: 1 });
      }
    });
    const counts = new Map();
    for (const bin of bins) {
      const key = `${bin.uidx}:${bin.tbin}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      bins: [...counts].map(([key, n]) => {
        const [uidx, tbin] = key.split(':').map(Number);
        return { uidx, tbin, n };
      }),
      lo,
      hi,
    };
  }

  async function loadBinsByDepth(probe) {
    const units = (await unitsForProbe(probe)).filter((u) => u.depth != null);
    const series = await readUnitSeries(units);
    const sample = [];
    let lo = Infinity;
    let dlo = Infinity;
    let dhi = -Infinity;
    let seen = 0;
    for (const { unit, times } of series) {
      dlo = Math.min(dlo, unit.depth);
      dhi = Math.max(dhi, unit.depth);
      for (const time of times) {
        if (time < 0) continue;
        lo = Math.min(lo, time);
        updateSample(sample, time, seen++);
      }
    }
    const hi = quantile(sample, HI_QUANTILE);
    if (!(hi > lo) || !(dhi > dlo)) return { bins: [], lo: 0, hi: 0, dlo: 0, dhi: 0 };
    const tWidth = (hi - lo) / TIME_BINS;
    const dWidth = (dhi - dlo) / DEPTH_BINS;
    const counts = new Map();
    for (const { unit, times } of series) {
      for (const time of times) {
        if (time < lo || time > hi) continue;
        const tbin = Math.min(TIME_BINS - 1, Math.floor((time - lo) / tWidth));
        const dbin = Math.min(DEPTH_BINS - 1, Math.floor((unit.depth - dlo) / dWidth));
        const key = `${tbin}:${dbin}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return {
      bins: [...counts].map(([key, n]) => {
        const [tbin, dbin] = key.split(':').map(Number);
        return { tbin, dbin, n };
      }),
      lo,
      hi,
      dlo,
      dhi,
    };
  }

  async function loadAlignedPsth(probe, eventTimes, unitName) {
    if (!eventTimes?.length) return [];
    const units = (await unitsForProbe(probe)).filter((u) => !unitName || u.unit_name === unitName);
    const series = await readUnitSeries(units);
    const counts = new Map();
    for (const { times } of series) {
      for (const eventTime of eventTimes) {
        const t0 = Number(eventTime);
        if (!Number.isFinite(t0)) continue;
        for (const time of times) {
          if (time < t0 + PSTH_PRE || time >= t0 + PSTH_POST) continue;
          const bin = Math.floor((time - t0 - PSTH_PRE) / PSTH_BIN_WIDTH);
          counts.set(bin, (counts.get(bin) ?? 0) + 1);
        }
      }
    }
    return [...counts].map(([bin, n]) => ({ bin: Number(bin), n }));
  }

  async function loadUnitsMeta(probe) {
    return unitsForProbe(probe);
  }

  async function loadUnitSessionPsth(probe, unitName, lo, hi) {
    const width = (hi - lo) / TIME_BINS;
    if (!(width > 0)) return [];
    const units = (await unitsForProbe(probe)).filter((u) => u.unit_name === unitName);
    const series = await readUnitSeries(units);
    const totals = new Array(TIME_BINS).fill(0);
    for (const { times } of series) {
      for (const time of times) {
        if (time < lo || time > hi) continue;
        const bin = Math.min(TIME_BINS - 1, Math.floor((time - lo) / width));
        totals[bin] += 1;
      }
    }
    return totals.map((n, i) => ({ t: (i + 0.5) * width, mean: n / width }));
  }

  async function loadWaveform(unit) {
    const array = await openArray(unit._source, 'waveform_mean');
    if (!array) return null;
    const result = await zarr.get(array, [zarr.slice(unit._index, unit._index + 1), null, null], { signal });
    const values = Array.from(result.data ?? []).map(Number).filter(Number.isFinite);
    const shape = result.shape ?? [];
    if (shape.length === 3) {
      const samples = shape[1];
      const channels = shape[2];
      const channel = Math.max(0, Math.min(channels - 1, Math.round(unit._extremumChannelIndex ?? 0)));
      return Array.from({ length: samples }, (_, i) => values[i * channels + channel]).filter(Number.isFinite);
    }
    return values;
  }

  async function loadMidiCandidates(probe, selection) {
    let rows = await unitsForProbe(probe);
    if (selection.requireDefaultQc) rows = rows.filter((row) => row.default_qc);
    if (selection.decoderLabels?.length) rows = rows.filter((row) => selection.decoderLabels.includes(row.decoder_label));
    if (selection.minFiringRateHz != null) rows = rows.filter((row) => row.firing_rate != null && Number(row.firing_rate) >= Number(selection.minFiringRateHz));
    if (selection.maxFiringRateHz != null) rows = rows.filter((row) => row.firing_rate != null && Number(row.firing_rate) <= Number(selection.maxFiringRateHz));
    if (selection.maxIsiViolationsRatio != null) rows = rows.filter((row) => row.isi_violations_ratio != null && Number(row.isi_violations_ratio) <= Number(selection.maxIsiViolationsRatio));
    if (selection.minPresenceRatio != null) rows = rows.filter((row) => row.presence_ratio != null && Number(row.presence_ratio) >= Number(selection.minPresenceRatio));
    const rank = selection.rankBy?.length ? selection.rankBy : [['num_spikes', 'DESC']];
    rows.sort((a, b) => {
      for (const [key, direction] of rank) {
        const result = typeof a[key] === 'string' || typeof b[key] === 'string'
          ? stringCompare(a[key], b[key], direction)
          : numericCompare(a[key], b[key], direction);
        if (result) return result;
      }
      return 0;
    });
    return rows.slice(0, Math.max(1, Number(selection.topK) || 12));
  }

  async function loadSonificationSpikes(probe, mappedUnits) {
    const names = new Set(mappedUnits.map((unit) => unit.unitName));
    const units = (await unitsForProbe(probe)).filter((unit) => names.has(unit.unit_name));
    const series = await readUnitSeries(units);
    return series.flatMap(({ unit, times }) => times.map((spike_time) => ({ unit_name: unit.unit_name, spike_time })));
  }

  return {
    id: `virtual:${assertAssetName(assetName)}`,
    kind: 'virtual',
    label: 'Virtual Zarr',
    manifestUrl: url,
    hasUnits: manifest.metadata.sources.some((source) =>
      sourceHasArray(source, 'unit_name') || sourceHasArray(source, 'id') || sourceHasArray(source, 'unit_id')),
    loadProbes,
    loadBins,
    loadBinsByDepth,
    loadAlignedPsth,
    loadUnitsMeta,
    loadUnitSessionPsth,
    loadWaveform,
    loadMidiCandidates,
    loadSonificationSpikes,
  };
}

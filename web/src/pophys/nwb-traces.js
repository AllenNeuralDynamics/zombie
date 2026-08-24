/**
 * pophys/nwb-traces.js — on-demand reads of calcium traces from a derived
 * pophys NWB (Zarr) on the public aind-open-data bucket.
 *
 * A whole plane's dF/F array is (n_frames × n_roi) and can be > 100 MB, so we
 * never load it whole. Instead we read:
 *   - the plane's `timestamps` once (shared by every ROI in that plane), and
 *   - a single ROI's trace column on demand (zarrita fetches only the chunks
 *     that intersect that column).
 *
 * Trace columns are indexed by `roi_id` from the ROI cache (verified equal to
 * the RoiResponseSeries `rois` order == roi_table id).
 *
 * Only assets whose derived pophys NWB is public on aind-open-data are
 * readable here (see the audit in the session notes); callers should degrade
 * gracefully when a plane fails to open.
 */

import * as zarr from 'zarrita';

const S3_BASE = 'https://aind-open-data.s3.amazonaws.com';

const _nwbBaseCache = new Map();

function assertAssetName(asset) {
  if (!/^[A-Za-z0-9_.-]+$/.test(asset ?? '')) {
    throw new Error(`Invalid pophys asset name: ${asset}`);
  }
  return asset;
}

/** Find the NWB-Zarr directory directly under an asset's S3 prefix. */
export function findNwbZarrPrefix(xml, asset) {
  const prefix = `${assertAssetName(asset)}/`;
  const roots = [...String(xml ?? '').matchAll(
    /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g,
  )]
    .map((m) => m[1])
    .filter((key) => key.startsWith(prefix) && key.endsWith('.nwb.zarr/'))
    .sort();
  return roots[0] ?? null;
}

/**
 * Discover the NWB-Zarr root rather than assuming a particular inner filename.
 * Asset prefixes currently contain names such as `<asset>.nwb.zarr` and
 * `<session>.nwb.zarr`; future pipeline naming changes should not require a
 * viewer release as long as the root remains an NWB-Zarr directory.
 */
export async function resolvePophysNwbBase(asset, { signal } = {}) {
  const key = assertAssetName(asset);
  if (_nwbBaseCache.has(key)) return _nwbBaseCache.get(key);

  const promise = (async () => {
    const prefix = `${key}/`;
    const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}`
      + `&delimiter=${encodeURIComponent('/')}&max-keys=1000`;
    const resp = await fetch(url, { signal });
    if (!resp.ok) throw new Error(`NWB-Zarr listing failed (${resp.status})`);
    const rootPrefix = findNwbZarrPrefix(await resp.text(), key);
    if (!rootPrefix) throw new Error('No NWB-Zarr root found for this asset');
    return `${S3_BASE}/${rootPrefix.replace(/\/$/, '')}`;
  })();
  _nwbBaseCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    _nwbBaseCache.delete(key);
    throw err;
  }
}

/**
 * Trace layouts. Derived pophys NWBs come in two generations and the plane
 * groups are named differently in each, so the group path is resolved by
 * probing rather than assumed:
 *
 *   modern  processing/<plane>/dff_timeseries/dff_timeseries/{data,timestamps}
 *   legacy  processing/<plane>/dff/{data,timestamps}
 *
 * The legacy layout is what the V1 deep-dive assets use (plane names are
 * `plane-0`… rather than `VISp_3`), and it carries two extra series.
 */
const LAYOUTS = [
  {
    name: 'modern',
    groups: {
      dff: (p) => `processing/${p}/dff_timeseries/dff_timeseries`,
      events: (p) => `processing/${p}/event_timeseries`,
      neuropil_corrected: (p) => `processing/${p}/neuropil_corrected_timeseries`,
      raw: (p) => `processing/${p}/raw_timeseries/ROI_fluorescence_timeseries`,
    },
  },
  {
    name: 'legacy',
    groups: {
      dff: (p) => `processing/${p}/dff`,
      events: (p) => `processing/${p}/events`,
      demixed: (p) => `processing/${p}/demixed`,
      neuropil_corrected: (p) => `processing/${p}/neuropil_corrected`,
      neuropil_fluorescence: (p) => `processing/${p}/neuropil_fluorescence`,
      raw: (p) => `processing/${p}/raw`,
    },
  },
];

/** Preferred order for the series picker; unknown keys sort last. */
export const SERIES_ORDER = [
  'dff', 'events', 'demixed', 'neuropil_corrected', 'neuropil_fluorescence', 'raw',
];

export const TRACE_LABELS = {
  dff: 'dF/F',
  events: 'events (deconvolved)',
  demixed: 'demixed',
  neuropil_corrected: 'neuropil-corrected',
  neuropil_fluorescence: 'neuropil fluorescence',
  raw: 'raw fluorescence',
};

/** root → plane → Promise<{name, groups, series}> */
const _layoutCache = new WeakMap();

async function _arrayExists(root, path) {
  try {
    await zarr.open(root.resolve(path), { kind: 'array' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which trace layout a plane uses, and which series it actually has.
 *
 * @returns {Promise<{name: string, groups: object, series: string[]}>}
 */
export function resolvePlaneLayout(root, plane) {
  let byPlane = _layoutCache.get(root);
  if (!byPlane) { byPlane = new Map(); _layoutCache.set(root, byPlane); }
  if (byPlane.has(plane)) return byPlane.get(plane);

  const promise = (async () => {
    for (const layout of LAYOUTS) {
      const keys = Object.keys(layout.groups);
      const hits = await Promise.all(
        keys.map((k) => _arrayExists(root, `${layout.groups[k](plane)}/data`)),
      );
      const series = keys.filter((_, i) => hits[i]);
      // dff is the anchor: every generation has it, and its timestamps are the
      // plane clock. A layout matching only stray names is not a match.
      if (series.includes('dff')) {
        series.sort((a, b) => SERIES_ORDER.indexOf(a) - SERIES_ORDER.indexOf(b));
        return { name: layout.name, groups: layout.groups, series };
      }
    }
    throw new Error(`No recognised NWB trace layout for plane "${plane}"`);
  })();

  byPlane.set(plane, promise);
  promise.catch(() => byPlane.delete(plane));
  return promise;
}

export function pophysNwbBase(asset, rootPrefix = 'pophys.nwb.zarr') {
  return `${S3_BASE}/${assertAssetName(asset)}/${rootPrefix}`;
}

/** Open the NWB zarr root for a derived pophys asset. */
export async function openPophysNwb(asset, options = {}) {
  const store = new zarr.FetchStore(await resolvePophysNwbBase(asset, options));
  return zarr.root(store);
}

/** Load a plane's frame timestamps (seconds, session clock). */
export async function loadPlaneTimestamps(root, plane, { signal } = {}) {
  const layout = await resolvePlaneLayout(root, plane);
  const arr = await zarr.open(
    root.resolve(`${layout.groups.dff(plane)}/timestamps`),
    { kind: 'array' },
  );
  const chunk = await zarr.get(arr);
  if (signal?.aborted) throw new Error('aborted');
  return Float64Array.from(chunk.data, Number);
}

/**
 * Read one ROI's trace column for a plane / series.
 *
 * @param {number} roiId - ROI column index (== cache roi_id).
 * @param {string} [series='dff'] - Key from `resolvePlaneLayout().series`.
 * @returns {Promise<Float32Array>}
 */
export async function loadRoiTrace(root, plane, roiId, series = 'dff', { signal } = {}) {
  const layout = await resolvePlaneLayout(root, plane);
  const key = layout.series.includes(series) ? series : 'dff';
  const arr = await zarr.open(root.resolve(`${layout.groups[key](plane)}/data`), { kind: 'array' });
  // Integer index on the ROI axis reduces it away → a 1-D column.
  const chunk = await zarr.get(arr, [null, roiId]);
  if (signal?.aborted) throw new Error('aborted');
  return Float32Array.from(chunk.data, Number);
}

/** Parse "Structure: VISp Depth: 152" → { structure:'VISp', depthUm:152 }. */
function parseLocation(loc) {
  const s = String(loc ?? '');
  const struct = s.match(/Structure:\s*([A-Za-z0-9]+)/)?.[1] ?? null;
  const depth = s.match(/Depth:\s*(\d+)/)?.[1];
  return { structure: struct, depthUm: depth != null ? Number(depth) : null };
}

/** Read imaging-plane metadata (depth, rate) for a plane. Best-effort. */
export async function loadPlaneMeta(root, plane, { signal } = {}) {
  try {
    const [locArr, rateArr] = await Promise.all([
      zarr.open(root.resolve(`general/optophysiology/${plane}/location`), { kind: 'array' }).then((a) => zarr.get(a)),
      zarr.open(root.resolve(`general/optophysiology/${plane}/imaging_rate`), { kind: 'array' }).then((a) => zarr.get(a)),
    ]);
    if (signal?.aborted) throw new Error('aborted');
    const { structure, depthUm } = parseLocation(locArr.data[0]);
    return { structure, depthUm, imagingRate: Number(rateArr.data[0]) };
  } catch {
    return { structure: null, depthUm: null, imagingRate: null };
  }
}

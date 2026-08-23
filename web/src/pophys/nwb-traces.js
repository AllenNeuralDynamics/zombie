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

/** Available trace series → path template under processing/<plane>/. */
export const TRACE_SERIES = {
  dff: (p) => `processing/${p}/dff_timeseries/dff_timeseries/data`,
  events: (p) => `processing/${p}/event_timeseries/data`,
  neuropil_corrected: (p) => `processing/${p}/neuropil_corrected_timeseries/data`,
  raw: (p) => `processing/${p}/raw_timeseries/ROI_fluorescence_timeseries/data`,
};

export const TRACE_LABELS = {
  dff: 'dF/F',
  events: 'events (deconvolved)',
  neuropil_corrected: 'neuropil-corrected',
  raw: 'raw fluorescence',
};

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
  const arr = await zarr.open(
    root.resolve(`processing/${plane}/dff_timeseries/dff_timeseries/timestamps`),
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
 * @param {keyof TRACE_SERIES} [series='dff']
 * @returns {Promise<Float32Array>}
 */
export async function loadRoiTrace(root, plane, roiId, series = 'dff', { signal } = {}) {
  const tmpl = TRACE_SERIES[series] ?? TRACE_SERIES.dff;
  const arr = await zarr.open(root.resolve(tmpl(plane)), { kind: 'array' });
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

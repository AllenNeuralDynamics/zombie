/**
 * Visual Coding Ophys NWB-Zarr adapter.
 *
 * These canonical assets use the Allen Brain Observatory single-plane NWB
 * layout. It is intentionally separate from pophys/nwb-traces.js: the latter
 * resolves processing/<plane> trace groups used by multiplane and V1DD assets.
 */

import * as zarr from 'zarrita';

const S3_BASE = 'https://aind-open-data.s3.amazonaws.com';
const ROOT_CACHE = new Map();

export const VCO_PATHS = {
  roiIds: 'processing/ophys/ImageSegmentation/PlaneSegmentation/id',
  globalRoiIds: 'processing/ophys/ImageSegmentation/PlaneSegmentation/global_roi_id',
  dff: 'processing/ophys/DfOverF/DfOverF/data',
  events: 'processing/ophys/DfOverF/DfOverFEvents/data',
  timestamps: 'processing/ophys/Fluorescence/Corrected/timestamps',
};

export function assertVisualCodingAssetName(asset) {
  if (!/^[A-Za-z0-9_.-]+$/.test(asset ?? '')) {
    throw new Error(`Invalid Visual Coding Ophys asset name: ${asset}`);
  }
  return asset;
}

export function findVisualCodingNwbPrefix(xml, asset) {
  const key = assertVisualCodingAssetName(asset);
  const prefix = `${key}/`;
  return [...String(xml ?? '').matchAll(
    /<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g,
  )]
    .map((match) => match[1])
    .filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith('.nwb.zarr/'))
    .sort()[0] ?? null;
}

export async function resolveVisualCodingNwbBase(asset, { signal } = {}) {
  const key = assertVisualCodingAssetName(asset);
  if (ROOT_CACHE.has(key)) return ROOT_CACHE.get(key);

  const promise = (async () => {
    const url = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(`${key}/`)}`
      + `&delimiter=${encodeURIComponent('/')}&max-keys=1000`;
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Visual Coding Ophys asset listing failed (${response.status})`);
    const prefix = findVisualCodingNwbPrefix(await response.text(), key);
    if (!prefix) throw new Error('No Visual Coding Ophys NWB-Zarr root found');
    return `${S3_BASE}/${prefix.replace(/\/$/, '')}`;
  })();

  ROOT_CACHE.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    ROOT_CACHE.delete(key);
    throw error;
  }
}

export async function openVisualCodingOphysNwb(asset, options = {}) {
  const store = new zarr.FetchStore(await resolveVisualCodingNwbBase(asset, options));
  return zarr.root(store);
}

async function readArray(root, path, { optional = false, signal } = {}) {
  try {
    const array = await zarr.open(root.resolve(path), { kind: 'array' });
    const values = await zarr.get(array, null, { signal });
    if (signal?.aborted) throw new Error('aborted');
    return { array, values };
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

async function openArray(root, path, { optional = false } = {}) {
  try {
    return await zarr.open(root.resolve(path), { kind: 'array' });
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

export async function loadVisualCodingOphysMeta(root, { signal } = {}) {
  const [roiIds, globalRoiIds, dff, events, timestamps] = await Promise.all([
    readArray(root, VCO_PATHS.roiIds, { signal }),
    readArray(root, VCO_PATHS.globalRoiIds, { optional: true, signal }),
    openArray(root, VCO_PATHS.dff),
    openArray(root, VCO_PATHS.events, { optional: true }),
    readArray(root, VCO_PATHS.timestamps, { signal }),
  ]);
  const ids = Array.from(roiIds.values.data, Number);
  return {
    roiIds: ids,
    globalRoiIds: globalRoiIds ? Array.from(globalRoiIds.values.data, Number) : ids,
    shape: [...dff.shape],
    eventsAvailable: !!events,
    timestamps: Float64Array.from(timestamps.values.data, Number),
  };
}

export async function loadVisualCodingOphysTrace(root, roiIndex, kind = 'dff', { signal } = {}) {
  const path = kind === 'events' ? VCO_PATHS.events : VCO_PATHS.dff;
  const array = await zarr.open(root.resolve(path), { kind: 'array' });
  const column = await zarr.get(array, [null, Number(roiIndex)], { signal });
  if (signal?.aborted) throw new Error('aborted');
  return Float32Array.from(column.data, Number);
}

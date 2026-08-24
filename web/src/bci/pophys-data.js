/**
 * bci/pophys-data.js — browser adapter for the calcium side of BCI NWBs.
 *
 * BCI sessions keep their behavior and population-ophys data in one behavior
 * NWB-Zarr store, but under a layout that is different from the derived
 * multiplane-ophys assets handled by web/src/pophys/. Keep this adapter local
 * to the BCI viewer so the established pophys path does not acquire BCI-only
 * probing and coordinate rules.
 */

import * as zarr from 'zarrita';

const DFF_GROUP = 'processing/processed/dff/dff';
const ROI_GROUP = 'processing/processed/image_segmentation/roi_table';

const OPTIONAL_ROI_FIELDS = [
  ['is_soma', 'isSoma'],
  ['soma_probability', 'somaProbability'],
  ['dendrite_probability', 'dendriteProbability'],
];

function chunkData(chunk) {
  return chunk && typeof chunk === 'object' && 'data' in chunk ? chunk.data : chunk;
}

function scalar(chunk) {
  const data = chunkData(chunk);
  if (data == null) return null;
  if (typeof data === 'number' || typeof data === 'bigint') return Number(data);
  return Number(data[0]);
}

function numbers(chunk) {
  const data = chunkData(chunk);
  if (data == null) return [];
  return Array.from(data, (value) => Number(value));
}

async function openArray(root, path) {
  return zarr.open(root.resolve(path), { kind: 'array' });
}

async function readOptional(root, path, { signal } = {}) {
  try {
    const array = await openArray(root, path);
    const chunk = await zarr.get(array, null, { signal });
    return { array, values: numbers(chunk) };
  } catch {
    return null;
  }
}

/** Open the behavior NWB-Zarr root already discovered by loadBciSession. */
export function openBciBehaviorNwb(behaviorBase) {
  if (!behaviorBase) throw new Error('BCI behavior NWB location is missing');
  return zarr.root(new zarr.FetchStore(String(behaviorBase).replace(/\/$/, '')));
}

/**
 * Load the small metadata vectors needed by the unit picker and trace viewer.
 * The wide dF/F array and the dense masks remain lazy.
 */
export async function loadBciPophysMeta(root, { signal } = {}) {
  const [dff, startingTime, roiIds, roiTableIds, isSoma, somaProbability, dendriteProbability, mask] =
    await Promise.all([
      openArray(root, `${DFF_GROUP}/data`),
      openArray(root, `${DFF_GROUP}/starting_time`),
      readOptional(root, `${DFF_GROUP}/rois`, { signal }),
      readOptional(root, `${ROI_GROUP}/id`, { signal }),
      readOptional(root, `${ROI_GROUP}/is_soma`, { signal }),
      readOptional(root, `${ROI_GROUP}/soma_probability`, { signal }),
      readOptional(root, `${ROI_GROUP}/dendrite_probability`, { signal }),
      openArray(root, `${ROI_GROUP}/image_mask`),
    ]);
  if (signal?.aborted) throw new Error('aborted');

  const start = scalar(await zarr.get(startingTime, null, { signal })) ?? 0;
  const rate = Number(startingTime.attrs?.rate ?? dff.attrs?.rate);
  if (!(rate > 0)) throw new Error('BCI dF/F array has no positive sampling rate');

  const nRoi = Number(dff.shape?.[1] ?? roiIds?.values?.length ?? 0);
  const idValues = roiIds?.values?.length ? roiIds.values : roiTableIds?.values;
  const ids = idValues?.length
    ? idValues.map(Number)
    : Array.from({ length: nRoi }, (_, i) => i);
  const optionalValues = { isSoma, somaProbability, dendriteProbability };
  const fields = Object.fromEntries(OPTIONAL_ROI_FIELDS.map(([, key]) => [
    key,
    optionalValues[key]?.values ?? null,
  ]));

  return {
    dff,
    nFrames: Number(dff.shape?.[0] ?? 0),
    nRoi,
    frameRate: rate,
    startingTime: start,
    traceStart: start,
    duration: Number(dff.shape?.[0] ?? 0) / rate,
    roiIds: ids,
    isSoma: fields.isSoma,
    somaProbability: fields.somaProbability,
    dendriteProbability: fields.dendriteProbability,
    mask,
    maskShape: [...(mask.shape ?? [])],
    unit: dff.attrs?.unit ?? '%',
  };
}

/** Read one ROI's dF/F column. The result is intentionally not cached here. */
export async function loadBciRoiTrace(meta, roiIndex, { signal } = {}) {
  const chunk = await zarr.get(meta.dff, [null, Number(roiIndex)], { signal });
  if (signal?.aborted) throw new Error('aborted');
  return Float32Array.from(chunkData(chunk), Number);
}

/** Read one dense ROI mask, on demand after the user selects a unit. */
export async function loadBciRoiMask(meta, roiIndex, { signal } = {}) {
  const chunk = await zarr.get(meta.mask, [Number(roiIndex), null, null], { signal });
  if (signal?.aborted) throw new Error('aborted');
  return {
    data: Float32Array.from(chunkData(chunk), Number),
    shape: [...(chunk.shape ?? meta.maskShape.slice(1))],
  };
}

/** Convert a session-clock timestamp into the BCI player's relative clock. */
export function bciTraceTime(meta, frame, sessionClockStart = 0) {
  return meta.traceStart - Number(sessionClockStart) + Number(frame) / meta.frameRate;
}

/** Return a compact unit record for the select and mask caption. */
export function bciUnit(meta, index) {
  const i = Number(index);
  return {
    index: i,
    id: Number(meta.roiIds[i] ?? i),
    isSoma: meta.isSoma?.[i] != null ? Boolean(meta.isSoma[i]) : null,
    somaProbability: meta.somaProbability?.[i] != null ? Number(meta.somaProbability[i]) : null,
    dendriteProbability: meta.dendriteProbability?.[i] != null
      ? Number(meta.dendriteProbability[i]) : null,
  };
}

/** Map cached contour ids to their dF/F column indexes without assuming ids are contiguous. */
export function indexBciCachedRois(meta, rois) {
  return (rois ?? [])
    .map((roi) => ({ ...roi, index: meta?.roiIds?.indexOf(Number(roi.id)) ?? -1 }))
    .filter((roi) => roi.index >= 0);
}

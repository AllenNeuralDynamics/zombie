const UNIT_NM = { nanometer: 1, micrometer: 1e3, millimeter: 1e6, meter: 1e9 };
const UNIT_S = { second: 1, millisecond: 1e-3, microsecond: 1e-6, nanosecond: 1e-9, minute: 60, hour: 3600 };
const MAX_SAMPLE_VOXELS = 2.5e5;

export function s3Https(s3Url) {
  const [, bucket, key] = s3Url.match(/^s3:\/\/([^/]+)\/(.+)$/);
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

async function fetchJson(url, fetchImpl, signal) {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`${res.status} fetching ${url.split('/').pop()}`);
  return res.json();
}

/** All IDs listed in a precomputed segmentation's segment_properties, or []. */
export async function fetchSkeletonSegmentIds(skeletonBase, fetchImpl = fetch, signal) {
  const info = await fetchJson(`${skeletonBase}/info`, fetchImpl, signal);
  if (!info.segment_properties) return [];
  const props = await fetchJson(`${skeletonBase}/${info.segment_properties}/info`, fetchImpl, signal);
  return props?.inline?.ids ?? [];
}

/** Vertex positions (nm) of one encoded precomputed skeleton, after `transform`. */
export function decodeSkeletonVertices(buffer, transform) {
  const view = new DataView(buffer);
  const n = view.getUint32(0, true);
  const verts = new Float32Array(buffer, 8, n * 3);
  const t = transform ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const out = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = verts[i * 3], y = verts[i * 3 + 1], z = verts[i * 3 + 2];
    for (let r = 0; r < 3; r++) {
      out[i * 3 + r] = t[r * 4] * x + t[r * 4 + 1] * y + t[r * 4 + 2] * z + t[r * 4 + 3];
    }
  }
  return out;
}

/** Bounding box `{ min, max }` in nm (x, y, z) over the given skeleton IDs. */
export async function fetchSkeletonBounds(skeletonBase, ids, fetchImpl = fetch, signal) {
  const info = await fetchJson(`${skeletonBase}/info`, fetchImpl, signal);
  const dir = info.skeletons ?? 'skeleton';
  const skelInfo = await fetchJson(`${skeletonBase}/${dir}/info`, fetchImpl, signal);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  await Promise.all(ids.map(async (id) => {
    const res = await fetchImpl(`${skeletonBase}/${dir}/${id}`, { signal });
    if (!res.ok) return;
    const v = decodeSkeletonVertices(await res.arrayBuffer(), skelInfo.transform);
    for (let i = 0; i < v.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        if (v[i + a] < min[a]) min[a] = v[i + a];
        if (v[i + a] > max[a]) max[a] = v[i + a];
      }
    }
  }));
  return min.every(Number.isFinite) ? { min, max } : null;
}

/** [lo, hi] at the given percentiles of the non-zero values, or null if none. */
export function percentileRange(values, lo = 5, hi = 95) {
  let n = 0;
  for (let i = 0; i < values.length; i++) if (values[i] !== 0) n++;
  if (!n) return null;
  const nz = new Float64Array(n);
  for (let i = 0, j = 0; i < values.length; i++) if (values[i] !== 0) nz[j++] = values[i];
  nz.sort();
  const at = p => nz[Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))))];
  return [at(lo), at(hi)];
}

/**
 * Per-level x/y/z geometry of an OME-Zarr multiscale: axis indices, voxel
 * size (nm), origin (nm) and shape along each spatial axis.
 */
export function omeSpatialLevels(multiscale, shapes) {
  const axes = (multiscale.axes ?? ['t', 'c', 'z', 'y', 'x']).map(a => (typeof a === 'string' ? { name: a } : a));
  const spatial = ['x', 'y', 'z'].map(name => axes.findIndex(a => a.name === name));
  if (spatial.some(i => i < 0)) throw new Error('image has no x/y/z axes');
  const unitNm = spatial.map(i => UNIT_NM[axes[i].unit] ?? 1e3);
  return multiscale.datasets.map((ds, level) => {
    const tf = ds.coordinateTransformations ?? [];
    const scale = tf.find(t => t.type === 'scale')?.scale ?? axes.map(() => 1);
    const trans = tf.find(t => t.type === 'translation')?.translation ?? axes.map(() => 0);
    return {
      path: ds.path,
      ndim: axes.length,
      spatial,
      voxelNm: spatial.map((i, a) => scale[i] * unitNm[a]),
      originNm: spatial.map((i, a) => trans[i] * unitNm[a]),
      shape: spatial.map(i => shapes[level][i]),
    };
  });
}

/** Voxel index ranges ([start, stop) per x/y/z) of `boundsNm` at a level. */
export function regionAtLevel(level, boundsNm) {
  return [0, 1, 2].map((a) => {
    if (!boundsNm) return [0, level.shape[a]];
    const start = Math.floor((boundsNm.min[a] - level.originNm[a]) / level.voxelNm[a]);
    const stop = Math.ceil((boundsNm.max[a] - level.originNm[a]) / level.voxelNm[a]) + 1;
    return [Math.max(0, Math.min(level.shape[a] - 1, start)), Math.max(1, Math.min(level.shape[a], stop))];
  });
}

/** Finest level whose region holds at most `maxVoxels` voxels (else the coarsest). */
export function pickSampleLevel(levels, boundsNm, maxVoxels = MAX_SAMPLE_VOXELS) {
  for (const level of levels) {
    const count = regionAtLevel(level, boundsNm).reduce((n, [s, e]) => n * (e - s), 1);
    if (count <= maxVoxels) return level;
  }
  return levels.at(-1);
}

/**
 * Global Neuroglancer dimensions an OME-Zarr image adds beyond x/y/z (e.g. `t`),
 * as `{ name: [scale, unit] }`. Channel axes become layer-local and are skipped.
 */
export function extraGlobalDimensions(multiscale) {
  const axes = (multiscale.axes ?? []).map(a => (typeof a === 'string' ? { name: a } : a));
  const scale = (multiscale.datasets?.[0]?.coordinateTransformations ?? []).find(t => t.type === 'scale')?.scale ?? [];
  const dims = {};
  axes.forEach((axis, i) => {
    if (['x', 'y', 'z'].includes(axis.name) || axis.type === 'channel' || axis.name === 'c') return;
    const unitScale = UNIT_S[axis.unit];
    dims[axis.name] = unitScale ? [(scale[i] ?? 1) * unitScale, 's'] : [scale[i] ?? 1, ''];
  });
  return dims;
}

export async function openOmeZarr(imageBase) {
  const zarr = await import('zarrita');
  const root = zarr.root(new zarr.FetchStore(imageBase));
  const group = await zarr.open(root, { kind: 'group' });
  const multiscale = group.attrs?.multiscales?.[0] ?? group.attrs?.ome?.multiscales?.[0];
  if (!multiscale) throw new Error('image is not OME-Zarr');
  return { zarr, root, multiscale };
}

/** 5–95 percentile contrast of an OME-Zarr image, sampled within `boundsNm` if given. */
export async function fetchImageContrast(image, boundsNm, { signal, lo = 5, hi = 95, maxVoxels = MAX_SAMPLE_VOXELS } = {}) {
  const { zarr, root, multiscale } = typeof image === 'string' ? await openOmeZarr(image) : image;
  const arrays = await Promise.all(multiscale.datasets.map(ds => zarr.open(root.resolve(ds.path), { kind: 'array' })));
  if (signal?.aborted) return null;
  const levels = omeSpatialLevels(multiscale, arrays.map(a => a.shape));
  const level = pickSampleLevel(levels, boundsNm, maxVoxels);
  const region = regionAtLevel(level, boundsNm);
  const selection = Array.from({ length: level.ndim }, () => 0);
  level.spatial.forEach((axis, a) => { selection[axis] = zarr.slice(region[a][0], region[a][1]); });
  const chunk = await zarr.get(arrays[levels.indexOf(level)], selection, { signal });
  return percentileRange(chunk.data, lo, hi);
}

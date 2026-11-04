// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { parseJsReference, renderJsReference } from '../qc/js-references.js';
import { buildNeuroglancerState, fitViewToBounds, resolveNeuroglancerParams } from '../qc/js-renderers/neuroglancer.js';
import {
  decodeSkeletonVertices,
  extraGlobalDimensions,
  fetchSkeletonBounds,
  fetchSkeletonSegmentIds,
  omeSpatialLevels,
  percentileRange,
  pickSampleLevel,
} from '../qc/js-renderers/neuroglancer-data.js';
import { resolveReference } from '../qc/data.js';
import { renderMedia } from '../qc/media.js';

const REF = 'js:neuroglancer?skeleton=s3%3A%2F%2Fb%2Fskel&image=s3://b/img.zarr&segments=1,2';

describe('js: references', () => {
  it('parses type and decoded params', () => {
    const { type, params } = parseJsReference(REF);
    expect(type).toBe('neuroglancer');
    expect(params.get('skeleton')).toBe('s3://b/skel');
    expect(params.get('image')).toBe('s3://b/img.zarr');
  });

  it('is resolved as js type before s3 handling', () => {
    expect(resolveReference(REF, 'private-bucket', 'p').type).toBe('js');
  });

  it('builds neuroglancer layers', () => {
    const state = buildNeuroglancerState(parseJsReference(REF).params);
    expect(state.layers).toEqual([
      { type: 'image', source: 'zarr://s3://b/img.zarr', name: 'image' },
      { type: 'segmentation', source: 'precomputed://s3://b/skel', name: 'skeleton',
        skeletonRendering: { mode2d: 'lines_and_points', lineWidth3d: 2 }, segments: ['1', '2'] },
    ]);
  });

  it('renders an embedded viewer without presigning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const el = renderMedia(REF, 'private-bucket', 'p', 'asset');
    const iframe = el.querySelector('iframe');
    await vi.waitFor(() => expect(iframe.getAttribute('src')).toBeTruthy());
    vi.unstubAllGlobals();
    expect(iframe.getAttribute('src')).toMatch(/^\/ng\/index\.html#!/);
    expect(el.querySelector('a').href).toContain('neuroglancer-demo.appspot.com');
  });

  it('shows errors for unknown types and bad params', () => {
    expect(renderJsReference('js:nope?x=1').textContent).toContain('Unknown');
    expect(renderJsReference('js:neuroglancer?image=https://x').textContent).toContain('s3://');
    expect(renderJsReference('js:neuroglancer').textContent).toContain('needs');
  });

  it('resolves relative image/skeleton paths against the asset location', () => {
    const input = new URLSearchParams('image=/img.zarr&skeleton=skel/&segments=1&range=0,9');
    const out = resolveNeuroglancerParams(input, { s3Bucket: 'b', s3Prefix: 'asset/' });
    expect(out.get('image')).toBe('s3://b/asset/img.zarr');
    expect(out.get('skeleton')).toBe('s3://b/asset/skel/');
    expect(out.get('segments')).toBe('1');
    expect(out.get('range')).toBe('0,9');
    expect(input.get('image')).toBe('/img.zarr');
  });

  it('leaves absolute image/skeleton URLs alone', () => {
    const out = resolveNeuroglancerParams(new URLSearchParams('image=s3://x/i.zarr&skeleton=https://x/s'), { s3Bucket: 'b', s3Prefix: 'p' });
    expect(out.get('image')).toBe('s3://x/i.zarr');
    expect(out.get('skeleton')).toBe('https://x/s');
    expect(() => buildNeuroglancerState(out)).toThrow('s3://');
  });

  it('errors on relative paths without an S3 location', () => {
    expect(() => resolveNeuroglancerParams(new URLSearchParams('image=i.zarr'), { s3Bucket: 'b' }))
      .toThrow('image is a relative path but the asset has no S3 location');
    expect(renderJsReference('js:neuroglancer?skeleton=skel').textContent).toContain('no S3 location');
  });

  it('applies an image contrast range', () => {
    const state = buildNeuroglancerState(new URLSearchParams('image=s3://b/i.zarr&range=0,300'));
    expect(state.layers[0].shaderControls).toEqual({ normalized: { range: [0, 300] } });
  });

  it('reads skeleton segment ids from segment_properties', async () => {
    const files = {
      'https://b/skel/info': { segment_properties: 'props' },
      'https://b/skel/props/info': { inline: { ids: ['1', '3'] } },
    };
    const fetchImpl = async u => ({ ok: true, json: async () => files[u] });
    expect(await fetchSkeletonSegmentIds('https://b/skel', fetchImpl)).toEqual(['1', '3']);
  });

  function encodeSkeleton(verts) {
    const buf = new ArrayBuffer(8 + verts.length * 4);
    new DataView(buf).setUint32(0, verts.length / 3, true);
    new Float32Array(buf, 8).set(verts);
    return buf;
  }

  it('decodes skeleton vertices through the transform', () => {
    const v = decodeSkeletonVertices(encodeSkeleton([1, 2, 3]), [2, 0, 0, 10, 0, 3, 0, 0, 0, 0, 4, 0]);
    expect(Array.from(v)).toEqual([12, 6, 12]);
  });

  it('computes skeleton bounds across segments', async () => {
    const files = {
      'https://b/s/info': { skeletons: 'sk' },
      'https://b/s/sk/info': { transform: [1000, 0, 0, 0, 0, 1000, 0, 0, 0, 0, 1000, 0] },
    };
    const bins = { 'https://b/s/sk/1': [0, 0, 0, 1, 2, 3], 'https://b/s/sk/2': [-1, 5, 1] };
    const fetchImpl = async u => ({
      ok: true,
      json: async () => files[u],
      arrayBuffer: async () => encodeSkeleton(bins[u]),
    });
    expect(await fetchSkeletonBounds('https://b/s', ['1', '2'], fetchImpl))
      .toEqual({ min: [-1000, 0, 0], max: [1000, 5000, 3000] });
  });

  it('fits the view to bounds in micrometers', () => {
    const state = fitViewToBounds({}, { min: [0, 0, 0], max: [1000e3, 500e3, 200e3] }, 500);
    expect(state.position).toEqual([500, 250, 100]);
    expect(state.crossSectionScale).toBeCloseTo(2.2);
    expect(state.projectionScale).toBe(1500);
  });

  it('takes 5-95 percentiles of non-zero values', () => {
    const values = new Uint16Array(201);
    for (let i = 0; i < 101; i++) values[i] = i + 1;
    expect(percentileRange(values)).toEqual([6, 96]);
    expect(percentileRange(new Uint16Array(4))).toBeNull();
  });

  it('picks the finest zarr level that fits the sample budget', () => {
    const multiscale = {
      axes: ['t', 'c', 'z', 'y', 'x'].map(name => ({ name, unit: 'micrometer' })),
      datasets: [1, 2, 4].map((f, i) => ({
        path: String(i),
        coordinateTransformations: [{ type: 'scale', scale: [1, 1, f, f, f] }],
      })),
    };
    const levels = omeSpatialLevels(multiscale, [[1, 1, 400, 400, 400], [1, 1, 200, 200, 200], [1, 1, 100, 100, 100]]);
    expect(levels[1].voxelNm).toEqual([2000, 2000, 2000]);
    const bounds = { min: [0, 0, 0], max: [200e3, 200e3, 200e3] };
    expect(pickSampleLevel(levels, bounds, 1.1e6).path).toBe('1');
  });

  it('declares non-spatial, non-channel image axes as global dimensions', () => {
    const multiscale = {
      axes: [
        { name: 't', type: 'time', unit: 'millisecond' },
        { name: 'c', type: 'channel' },
        { name: 'z', type: 'space' }, { name: 'y', type: 'space' }, { name: 'x', type: 'space' },
      ],
      datasets: [{ coordinateTransformations: [{ type: 'scale', scale: [1, 1, 1, 0.7, 0.7] }] }],
    };
    expect(extraGlobalDimensions(multiscale)).toEqual({ t: [0.001, 's'] });
  });
});

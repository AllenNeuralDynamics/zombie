import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as zarr from 'zarrita';

vi.mock('zarrita', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(), get: vi.fn() };
});

import {
  bciTraceTime,
  bciUnit,
  loadBciPophysMeta,
  loadBciRoiMask,
  loadBciRoiTrace,
} from '../bci/pophys-data.js';

const PATHS = {
  dff: 'processing/processed/dff/dff/data',
  startingTime: 'processing/processed/dff/dff/starting_time',
  rois: 'processing/processed/dff/dff/rois',
  id: 'processing/processed/image_segmentation/roi_table/id',
  isSoma: 'processing/processed/image_segmentation/roi_table/is_soma',
  somaProbability: 'processing/processed/image_segmentation/roi_table/soma_probability',
  dendriteProbability: 'processing/processed/image_segmentation/roi_table/dendrite_probability',
  mask: 'processing/processed/image_segmentation/roi_table/image_mask',
};

function fakeRoot() {
  return { resolve(path) { return { path }; } };
}

describe('BCI pophys NWB adapter', () => {
  beforeEach(() => {
    zarr.open.mockReset();
    zarr.get.mockReset();
    zarr.open.mockImplementation(async (loc) => {
      const path = loc.path;
      if (path === PATHS.dff) return { path, shape: [1000, 4], attrs: { unit: '%' } };
      if (path === PATHS.startingTime) return { path, shape: [1], attrs: { rate: 50 } };
      if (path === PATHS.rois || path === PATHS.id) return { path, shape: [4], attrs: {} };
      if (path === PATHS.isSoma || path === PATHS.somaProbability || path === PATHS.dendriteProbability) {
        return { path, shape: [4], attrs: {} };
      }
      if (path === PATHS.mask) return { path, shape: [4, 2, 3], attrs: {} };
      throw new Error(`missing ${path}`);
    });
    zarr.get.mockImplementation(async (array, selection) => {
      if (array.path === PATHS.startingTime) return { data: Float64Array.from([0]) };
      if (array.path === PATHS.rois || array.path === PATHS.id) return { data: Int32Array.from([0, 1, 2, 3]) };
      if (array.path === PATHS.isSoma) return { data: Int32Array.from([1, 0, 1, 0]) };
      if (array.path === PATHS.somaProbability) return { data: Float32Array.from([0.8, 0.1, 0.7, 0.2]) };
      if (array.path === PATHS.dendriteProbability) return { data: Float32Array.from([0.1, 0.4, 0.2, 0.6]) };
      if (array.path === PATHS.dff) return { data: Float32Array.from([1, 2, 3]) };
      if (array.path === PATHS.mask) return { data: Float32Array.from([0, 1, 0, 0, 0.5, 0]), shape: [2, 3] };
      throw new Error(`missing data ${array.path}`);
    });
  });

  it('reads the nested BCI trace metadata and compact ROI vectors', async () => {
    const meta = await loadBciPophysMeta(fakeRoot());
    expect(meta).toMatchObject({
      nFrames: 1000,
      nRoi: 4,
      frameRate: 50,
      duration: 20,
      roiIds: [0, 1, 2, 3],
      maskShape: [4, 2, 3],
      unit: '%',
    });
    expect(bciUnit(meta, 2)).toMatchObject({ id: 2, isSoma: true });
    expect(bciUnit(meta, 2).somaProbability).toBeCloseTo(0.7, 5);
  });

  it('reads one dF/F column and one ROI mask lazily', async () => {
    const meta = await loadBciPophysMeta(fakeRoot());
    await loadBciRoiTrace(meta, 2);
    await loadBciRoiMask(meta, 2);
    expect(zarr.get).toHaveBeenCalledWith(meta.dff, [null, 2], { signal: undefined });
    expect(zarr.get).toHaveBeenCalledWith(meta.mask, [2, null, null], { signal: undefined });
  });

  it('aligns calcium frame time to the trial-relative BCI clock', () => {
    const meta = { traceStart: 0, frameRate: 50 };
    expect(bciTraceTime(meta, 0, 1543.5)).toBe(-1543.5);
    expect(bciTraceTime(meta, 15435, 1543.5)).toBe(-1234.8);
  });
});

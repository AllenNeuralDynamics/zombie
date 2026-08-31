import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as zarr from 'zarrita';

// zarrita's namespace is frozen, so spyOn cannot patch it — mock the module.
vi.mock('zarrita', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, open: vi.fn(), get: vi.fn() };
});

import {
  findNwbZarrPrefix,
  loadPlaneTimestamps,
  loadRoiTrace,
  loadRoiTraces,
  resolvePlaneLayout,
  resolvePophysNwbBase,
} from '../pophys/nwb-traces.js';

const ASSET = '409828_2018-12-13_15-10-05_nwb_2025-12-15_18-49-28';

describe('pophys NWB-Zarr discovery', () => {
  it('finds the asset-specific NWB-Zarr directory', () => {
    const xml = `<ListBucketResult>
      <CommonPrefixes><Prefix>${ASSET}/${ASSET}.nwb.zarr/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>${ASSET}/other-data/</Prefix></CommonPrefixes>
    </ListBucketResult>`;

    expect(findNwbZarrPrefix(xml, ASSET)).toBe(`${ASSET}/${ASSET}.nwb.zarr/`);
  });

  it('supports a different inner NWB filename without special-casing it', () => {
    const asset = '409828_2018-12-13_15-10-05_filtered_2026-04-09_05-57-20';
    const xml = `<CommonPrefixes><Prefix>${asset}/409828_2018-12-13_15-10-05.nwb.zarr/</Prefix></CommonPrefixes>`;

    expect(findNwbZarrPrefix(xml, asset)).toBe(`${asset}/409828_2018-12-13_15-10-05.nwb.zarr/`);
  });

  it('accepts a true HDF5 NWB root alongside NWB-Zarr roots', () => {
    const asset = 'multiplane-ophys_782149_2025-03-28_processed';
    const xml = `<CommonPrefixes><Prefix>${asset}/${asset}.nwb/</Prefix></CommonPrefixes>`;
    expect(findNwbZarrPrefix(xml, asset)).toBe(`${asset}/${asset}.nwb/`);
  });

  it('lists an asset prefix once and caches the resolved base URL', async () => {
    const asset = 'pophys-discovery-cache-test';
    const xml = `<CommonPrefixes><Prefix>${asset}/session.nwb.zarr/</Prefix></CommonPrefixes>`;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => xml });
    vi.stubGlobal('fetch', fetchMock);

    const expected = `https://aind-open-data.s3.amazonaws.com/${asset}/session.nwb.zarr`;
    await expect(resolvePophysNwbBase(asset)).resolves.toBe(expected);
    await expect(resolvePophysNwbBase(asset)).resolves.toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('delimiter=%2F');
  });

  it('rejects unsafe asset names before making a request', async () => {
    await expect(resolvePophysNwbBase('../not-an-asset')).rejects.toThrow(/Invalid pophys asset name/);
  });
});

// ---------------------------------------------------------------------------
// Trace layout resolution
// ---------------------------------------------------------------------------

/**
 * Fake zarr root: `resolve()` returns the path, and the module's zarr.open is
 * stubbed to succeed only for paths present in `present`.
 */
function fakeRoot(present) {
  return {
    _present: new Set(present),
    resolve(path) { return { _root: this, path }; },
  };
}

const MODERN_PLANE = 'VISp_3';
const LEGACY_PLANE = 'plane-0';

const MODERN_ARRAYS = [
  `processing/${MODERN_PLANE}/dff_timeseries/dff_timeseries/data`,
  `processing/${MODERN_PLANE}/dff_timeseries/dff_timeseries/timestamps`,
  `processing/${MODERN_PLANE}/event_timeseries/data`,
  `processing/${MODERN_PLANE}/raw_timeseries/ROI_fluorescence_timeseries/data`,
];

// The V1 deep-dive layout: short group names, plus two extra series.
const LEGACY_ARRAYS = [
  `processing/${LEGACY_PLANE}/dff/data`,
  `processing/${LEGACY_PLANE}/dff/timestamps`,
  `processing/${LEGACY_PLANE}/events/data`,
  `processing/${LEGACY_PLANE}/demixed/data`,
  `processing/${LEGACY_PLANE}/neuropil_corrected/data`,
  `processing/${LEGACY_PLANE}/neuropil_fluorescence/data`,
  `processing/${LEGACY_PLANE}/raw/data`,
];

describe('pophys NWB trace layouts', () => {
  let opened;

  beforeEach(() => {
    opened = [];
    zarr.open.mockReset();
    zarr.get.mockReset();
    zarr.open.mockImplementation(async (loc) => {
      opened.push(loc.path);
      if (!loc._root._present.has(loc.path)) throw new Error(`no such array: ${loc.path}`);
      return { path: loc.path };
    });
  });

  afterEach(() => { zarr.open.mockReset(); zarr.get.mockReset(); });

  it('detects the modern layout and its series', async () => {
    const layout = await resolvePlaneLayout(fakeRoot(MODERN_ARRAYS), MODERN_PLANE);
    expect(layout.name).toBe('modern');
    expect(layout.series).toEqual(['dff', 'events', 'raw']);
  });

  it('detects the legacy layout used by the V1 deep-dive assets', async () => {
    const layout = await resolvePlaneLayout(fakeRoot(LEGACY_ARRAYS), LEGACY_PLANE);
    expect(layout.name).toBe('legacy');
    expect(layout.series).toEqual([
      'dff', 'events', 'demixed', 'neuropil_corrected', 'neuropil_fluorescence', 'raw',
    ]);
  });

  it('reads a legacy ROI column from processing/<plane>/dff/data', async () => {
    zarr.get.mockResolvedValue({ data: [1, 2, 3] });
    const root = fakeRoot(LEGACY_ARRAYS);
    const out = await loadRoiTrace(root, LEGACY_PLANE, 42, 'dff');
    expect(out).toEqual(Float32Array.from([1, 2, 3]));
    expect(opened).toContain(`processing/${LEGACY_PLANE}/dff/data`);
    expect(zarr.get).toHaveBeenCalledWith({ path: `processing/${LEGACY_PLANE}/dff/data` }, [null, 42]);
  });

  it('reads legacy timestamps from the dff group', async () => {
    zarr.get.mockResolvedValue({ data: [0, 0.03] });
    const root = fakeRoot(LEGACY_ARRAYS);
    await loadPlaneTimestamps(root, LEGACY_PLANE);
    expect(opened).toContain(`processing/${LEGACY_PLANE}/dff/timestamps`);
  });

  it('reads a contiguous range for several ROI columns', async () => {
    const root = fakeRoot(MODERN_ARRAYS);
    zarr.open.mockImplementation(async (loc) => {
      opened.push(loc.path);
      if (!loc._root._present.has(loc.path)) throw new Error(`no such array: ${loc.path}`);
      return { path: loc.path, shape: loc.path.endsWith('/data') ? [3, 5] : [3] };
    });
    zarr.get.mockResolvedValue({ data: [1, 2, 3, 4, 5, 6], shape: [3, 2] });
    const out = await loadRoiTraces(root, MODERN_PLANE, [2, 3], 'events');
    expect(out).toMatchObject({ roiIds: [2, 3], startRoi: 2, nFrames: 3, nColumns: 2 });
    expect(out.data).toEqual(Float32Array.from([1, 2, 3, 4, 5, 6]));
    expect(zarr.get).toHaveBeenLastCalledWith(
      { path: `processing/${MODERN_PLANE}/event_timeseries/data`, shape: [3, 5] },
      [null, { start: 2, stop: 4, step: null }],
    );
  });

  it('falls back to dff when the requested series is absent in this layout', async () => {
    zarr.get.mockResolvedValue({ data: [1] });
    const root = fakeRoot(MODERN_ARRAYS);
    await loadRoiTrace(root, MODERN_PLANE, 0, 'demixed');
    expect(opened).toContain(`processing/${MODERN_PLANE}/dff_timeseries/dff_timeseries/data`);
  });

  it('caches the resolved layout per plane', async () => {
    const root = fakeRoot(LEGACY_ARRAYS);
    await resolvePlaneLayout(root, LEGACY_PLANE);
    const afterFirst = opened.length;
    await resolvePlaneLayout(root, LEGACY_PLANE);
    expect(opened.length).toBe(afterFirst);
  });

  it('rejects a plane with no recognised layout', async () => {
    await expect(resolvePlaneLayout(fakeRoot([]), 'nope'))
      .rejects.toThrow(/No recognised NWB trace layout/);
  });
});

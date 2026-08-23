import { describe, expect, it, vi } from 'vitest';
import { findNwbZarrPrefix, resolvePophysNwbBase } from '../pophys/nwb-traces.js';

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

/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';

const loadSwdbUnitLocations = vi.fn();
const ensureTable = vi.fn();
const queryRows = vi.fn();

vi.mock('../swdb/data.js', () => ({ loadSwdbUnitLocations }));
vi.mock('../lib/registry.js', () => ({ ensureTable }));
vi.mock('../lib/arrow.js', () => ({ queryRows }));
vi.mock('../lib/metadata.js', () => ({ quoteIdentifier: (name) => `"${name}"` }));

const { loadVisualCodingNeuropixelsUnits, loadVisualCodingNeuropixelsUnitLocations } =
  await import('../visual_coding_neuropixels/data.js');

describe('loadVisualCodingNeuropixelsUnits', () => {
  it('falls back to the live NWB-Zarr loader for every asset when no coord is given', async () => {
    loadSwdbUnitLocations.mockResolvedValueOnce({
      units: [{ key: 'vcn:asset-a:raw:0' }],
      failedAssets: [],
    });
    const rows = [{ asset_name: 'asset-a' }];
    const signal = new AbortController().signal;

    const result = await loadVisualCodingNeuropixelsUnits(rows, { signal });

    expect(ensureTable).not.toHaveBeenCalled();
    expect(loadSwdbUnitLocations).toHaveBeenCalledWith(
      rows, loadVisualCodingNeuropixelsUnitLocations, 'vcn', { signal },
    );
    expect(result.units).toEqual([{ key: 'vcn:asset-a:raw:0' }]);
  });

  it('reads unit locations from the cache table and skips the live loader on a full cache hit', async () => {
    ensureTable.mockResolvedValueOnce('platform_visual_coding_neuropixels_units');
    queryRows.mockResolvedValueOnce([
      {
        asset_name: 'asset-a', unit_id: 1, probe_name: 'probeA', structure: 'VISp',
        ccf_ap: 1000, ccf_dv: 2000, ccf_ml: 3000,
      },
      // Dropped: missing CCF coordinate.
      {
        asset_name: 'asset-a', unit_id: 2, probe_name: 'probeA', structure: 'VISp',
        ccf_ap: null, ccf_dv: 2000, ccf_ml: 3000,
      },
    ]);
    loadSwdbUnitLocations.mockResolvedValueOnce({ units: [], failedAssets: [] });

    const coord = {};
    const rows = [{ asset_name: 'asset-a', subject_id: '387858', session_date: '2018-07-12' }];
    const result = await loadVisualCodingNeuropixelsUnits(rows, { coord });

    expect(ensureTable).toHaveBeenCalledWith(coord, 'platform_visual_coding_neuropixels_units');
    expect(loadSwdbUnitLocations).toHaveBeenCalledWith([], loadVisualCodingNeuropixelsUnitLocations, 'vcn', { signal: undefined });
    expect(result.units).toEqual([{
      key: 'vcn:asset-a:cache:0',
      unitName: '1',
      deviceName: 'probeA',
      probeName: 'probeA',
      structure: 'VISp',
      location: null,
      ccfAp: 1000,
      ccfDv: 2000,
      ccfMl: 3000,
      acquisition: 'asset-a',
      acquisitionLabel: '2018-07-12 · 387858',
    }]);
  });

  it('falls back to the live loader only for assets missing from the cache table', async () => {
    ensureTable.mockResolvedValueOnce('platform_visual_coding_neuropixels_units');
    queryRows.mockResolvedValueOnce([
      {
        asset_name: 'asset-a', unit_id: 1, probe_name: 'probeA', structure: 'VISp',
        ccf_ap: 1000, ccf_dv: 2000, ccf_ml: 3000,
      },
    ]);
    loadSwdbUnitLocations.mockResolvedValueOnce({
      units: [{ key: 'vcn:asset-b:raw:0' }],
      failedAssets: [],
    });

    const coord = {};
    const rows = [{ asset_name: 'asset-a' }, { asset_name: 'asset-b' }];
    const result = await loadVisualCodingNeuropixelsUnits(rows, { coord });

    expect(loadSwdbUnitLocations).toHaveBeenCalledWith(
      [{ asset_name: 'asset-b' }], loadVisualCodingNeuropixelsUnitLocations, 'vcn', { signal: undefined },
    );
    expect(result.units).toHaveLength(2);
    expect(result.units.map((unit) => unit.key)).toEqual(
      expect.arrayContaining(['vcn:asset-a:cache:0', 'vcn:asset-b:raw:0']),
    );
  });
});

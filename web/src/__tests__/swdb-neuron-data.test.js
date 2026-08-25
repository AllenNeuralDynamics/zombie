/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';

const loadRasterUnitLocations = vi.fn();

vi.mock('../dynamic_routing_raster/data.js', () => ({ loadRasterUnitLocations }));

const { loadSwdbDynamicRoutingUnits } = await import('../swdb/data.js');

describe('loadSwdbDynamicRoutingUnits', () => {
  it('labels units by acquisition and drops units without CCF coordinates', async () => {
    loadRasterUnitLocations
      .mockResolvedValueOnce([
        { key: 'raw:0', ccfAp: 1000, ccfDv: 2000, ccfMl: 3000 },
        { key: 'raw:1', ccfAp: null, ccfDv: 2000, ccfMl: 3000 },
      ])
      .mockResolvedValueOnce([
        { key: 'raw:0', ccfAp: 1100, ccfDv: 2100, ccfMl: 3100 },
      ]);

    const result = await loadSwdbDynamicRoutingUnits([
      { asset_name: 'asset-b', subject_id: '2', session_date: '2024-02-02' },
      { asset_name: 'asset-a', subject_id: '1', session_date: '2024-01-01' },
    ]);

    expect(loadRasterUnitLocations).toHaveBeenNthCalledWith(1, 'asset-a', { signal: undefined });
    expect(result.failedAssets).toEqual([]);
    expect(result.units).toHaveLength(2);
    expect(result.units.map((unit) => [unit.acquisition, unit.acquisitionLabel])).toEqual([
      ['asset-a', '2024-01-01 · 1'],
      ['asset-b', '2024-02-02 · 2'],
    ]);
    expect(result.units[0].key).toBe('swdb:asset-a:raw:0');
  });

  it('keeps an acquisition failure separate from successful locations', async () => {
    loadRasterUnitLocations
      .mockResolvedValueOnce([{ key: 'raw:0', ccfAp: 1, ccfDv: 2, ccfMl: 3 }])
      .mockRejectedValueOnce(new Error('unavailable'));

    const result = await loadSwdbDynamicRoutingUnits([
      { asset_name: 'asset-a' },
      { asset_name: 'asset-b' },
    ]);

    expect(result.units).toHaveLength(1);
    expect(result.failedAssets).toHaveLength(1);
    expect(result.failedAssets[0].assetName).toBe('asset-b');
  });
});

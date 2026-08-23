/**
 * swdb-overview-data.test.js — ensure public SWDB memberships survive when
 * their asset names are not present in asset_basics.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/metadata.js', () => ({
  getResolvedVersion: () => 'bdc-v0.39',
  quoteIdentifier: (name) => `"${name}"`,
}));
vi.mock('../lib/registry.js', () => ({
  ensureTable: vi.fn(async (_coord, name) => name),
}));
vi.mock('../lib/assets-table.js', () => ({ fetchAssetsWithSources: vi.fn() }));
vi.mock('../lib/arrow.js', () => ({
  queryRows: vi.fn(async (_coord, sql) => {
    // Simulate the real case: none of these public collection assets has an
    // asset_basics match, so an INNER JOIN would silently return no rows.
    if (!sql.includes('LEFT JOIN asset_basics')) return [];
    const table = sql.match(/FROM "(swdb_[^"]+)"/)?.[1];
    return [{
      name: `${table}_asset_2025-01-01_00-00-00`,
      acquisition_start_time: null,
      modalities: null,
    }];
  }),
}));

const { loadSwdbOverviewAssets } = await import('../swdb/data.js');

const DATASET_NAMES = [
  'swdb_2026_bci',
  'swdb_2026_dynamic_routing',
  'swdb_2026_neuropixels_opto',
  'swdb_2026_visual_coding_neuropixels',
  'swdb_2026_visual_coding_ophys',
  'swdb_2026_visual_learning',
  'swdb_2026_v1dd',
];

describe('loadSwdbOverviewAssets', () => {
  it('keeps every published dataset when canonical asset metadata is missing', async () => {
    const metadata = { acorns: DATASET_NAMES.map((name) => ({ name, columns: [{ name: 'name' }] })) };
    const rows = await loadSwdbOverviewAssets({}, metadata);

    expect(new Set(rows.map((row) => row.dataset))).toEqual(new Set(DATASET_NAMES));
    expect(rows).toHaveLength(DATASET_NAMES.length);
    expect(rows.every((row) => row.acquisition_start_time && row.modalities.length > 0)).toBe(true);
  });
});

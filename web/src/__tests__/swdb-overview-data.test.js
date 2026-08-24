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
    if (sql.includes('COUNT(*) AS n_assets')) return [{ n_assets: 3 }];
    if (sql.includes('COUNT(DISTINCT a.subject_id)')) {
      return [{ n_subjects: 2, first_date: '2025-01-01', last_date: '2025-01-03' }];
    }
    if (sql.includes('SELECT DISTINCT unnest(a.modalities) AS modality')) {
      return [{ modality: 'ecephys' }, { modality: 'pophys' }];
    }
    if (sql.includes('SELECT DISTINCT modality FROM')) {
      return [{ modality: 'behavior' }, { modality: 'pophys' }];
    }
    // Simulate the real case: none of these public collection assets has an
    // asset_basics match, so an INNER JOIN would silently return no rows.
    if (sql.includes('SELECT DISTINCT unnest(a.modalities) AS modality')) {
      return [{ modality: 'pophys' }, { modality: 'behavior' }];
    }
    if (!sql.includes('LEFT JOIN asset_basics')) return [];
    const table = sql.match(/FROM "(swdb_[^"]+)"/)?.[1];
    return [{
      name: `${table}_asset_2025-01-01_00-00-00`,
      acquisition_start_time: null,
      modalities: null,
    }];
  }),
}));

const { loadSwdbDatasetSummaries, loadSwdbOverviewAssets } = await import('../swdb/data.js');

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

describe('loadSwdbDatasetSummaries', () => {
  it('reports every unique modality across canonical and dataset rows', async () => {
    const metadata = {
      acorns: [{
        name: 'swdb_2026_mixed',
        columns: [{ name: 'name' }, { name: 'modality' }],
      }],
    };
    const [summary] = await loadSwdbDatasetSummaries({}, metadata);

    expect(summary.modalities).toEqual(['behavior', 'ecephys', 'pophys']);
  });
});

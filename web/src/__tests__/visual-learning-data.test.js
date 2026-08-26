import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/arrow.js', () => ({ queryRows: vi.fn() }));
vi.mock('../lib/registry.js', () => ({ ensureTable: vi.fn() }));
vi.mock('../lib/metadata.js', () => ({ getResolvedVersion: () => 'bdc-v0.39' }));

import { queryRows } from '../lib/arrow.js';
import {
  loadVisualLearningCellTypes,
  loadVisualLearningCoreg,
  loadVisualLearningProgression,
  resolveVisualLearningPlaybackSource,
} from '../swdb/data.js';

describe('loadVisualLearningProgression', () => {
  it('uses acquisition_type from the canonical asset rows', () => {
    const assets = [
      { name: 'root-stage', subject_id: '782149', acquisition_start_time: '2025-03-25', acquisition_type: 'TRAINING_2_gratings_A' },
      { name: 'nested-stage', subject_id: '782149', acquisition_start_time: '2025-03-26', acquisition_type: 'OPHYS_4_images_A' },
    ];
    const rows = loadVisualLearningProgression(assets);

    expect(rows.map((row) => row.session_type)).toEqual([
      'TRAINING_2_gratings_A',
      'OPHYS_4_images_A',
    ]);
  });

  it('falls back to a subject encoded in the asset name', () => {
    const [row] = loadVisualLearningProgression([
      { name: 'multiplane-ophys_788406_2025-05-29_11-29-10_processed' },
    ]);

    expect(row.subject_id).toBe('788406');
  });
});

describe('resolveVisualLearningPlaybackSource', () => {
  it('prefers a raw source when the source map contains derived assets too', async () => {
    queryRows.mockResolvedValue([
      { name: 'derived-behavior', data_level: 'derived', location: 's3://bucket/derived' },
      { name: 'raw-acquisition', data_level: 'raw', location: 's3://bucket/raw' },
    ]);

    await expect(resolveVisualLearningPlaybackSource(
      {},
      ['derived-behavior', 'raw-acquisition'],
    )).resolves.toMatchObject({ name: 'raw-acquisition', location: 's3://bucket/raw' });
  });

  it('returns no source when the selected asset has no source names', async () => {
    queryRows.mockClear();
    await expect(resolveVisualLearningPlaybackSource({}, [])).resolves.toBeNull();
    expect(queryRows).not.toHaveBeenCalled();
  });
});

describe('Visual Learning lookup loaders', () => {
  it('selects only annotation columns from the cell-gene partition', async () => {
    queryRows.mockResolvedValue([{ cell_id: '3', cell_type: 'Exc-1' }]);
    await expect(loadVisualLearningCellTypes({}, '782149')).resolves.toEqual([
      { cell_id: '3', cell_type: 'Exc-1' },
    ]);
    expect(queryRows.mock.calls.at(-1)[1]).toContain('cell_id, cell_class, cell_subclass, cell_type, cluster_id');
    expect(queryRows.mock.calls.at(-1)[1]).toContain('subject_id=782149');
  });

  it('filters co-registration rows to a selected session key', async () => {
    queryRows.mockResolvedValue([]);
    await loadVisualLearningCoreg({}, '782149', "782149_2025-03-28");
    expect(queryRows.mock.calls.at(-1)[1]).toContain("session_key = '782149_2025-03-28'");
    expect(queryRows.mock.calls.at(-1)[1]).toContain('roi_id >= 0 AND hcr_id >= 0');
  });

  it('rejects an unsafe subject before querying', async () => {
    queryRows.mockClear();
    await expect(loadVisualLearningCellTypes({}, '782149/other')).rejects.toThrow(/Invalid SWDB subject id/);
    expect(queryRows).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/arrow.js', () => ({ queryRows: vi.fn() }));
vi.mock('../lib/registry.js', () => ({ ensureTable: vi.fn() }));

import { queryRows } from '../lib/arrow.js';
import {
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

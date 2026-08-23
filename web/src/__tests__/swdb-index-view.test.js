/**
 * swdb-index-view.test.js — regression coverage for the SWDB landing page.
 *
 * The page must render every published 2026 dataset, not just the dataset
 * whose assets happen to have canonical asset_basics rows.
 *
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../swdb/data.js', () => ({
  loadSwdbDatasetSummaries: vi.fn(),
  loadSwdbOverviewAssets: vi.fn(),
}));

import { loadSwdbDatasetSummaries, loadSwdbOverviewAssets } from '../swdb/data.js';
import { createSwdbIndexView } from '../swdb/index-view.js';

const DATASET_NAMES = [
  'swdb_2026_bci',
  'swdb_2026_dynamic_routing',
  'swdb_2026_neuropixels_opto',
  'swdb_2026_visual_coding_neuropixels',
  'swdb_2026_visual_coding_ophys',
  'swdb_2026_visual_learning',
  'swdb_2026_v1dd',
];

const summaries = DATASET_NAMES.map((name) => ({
  name,
  nAssets: 1,
  nSubjects: 1,
  firstDate: '2025-01-01',
  lastDate: '2025-01-01',
}));

const overviewRows = DATASET_NAMES.map((dataset, index) => ({
  name: `${dataset}-asset`,
  acquisition_start_time: `2025-01-0${index + 1}T00:00:00Z`,
  modalities: ['pophys'],
  dataset,
}));

describe('SWDB index view', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    loadSwdbDatasetSummaries.mockResolvedValue(summaries);
    loadSwdbOverviewAssets.mockResolvedValue(overviewRows);
  });

  it('renders every published 2026 dataset in the cards and overview legend', async () => {
    const root = createSwdbIndexView({}, { acorns: [] });
    document.body.appendChild(root);

    await vi.waitFor(() => {
      expect(root.querySelectorAll('.swdb-card')).toHaveLength(DATASET_NAMES.length);
    });

    expect([...root.querySelectorAll('.swdb-card')].map((card) => card.dataset.dataset))
      .toEqual(DATASET_NAMES);
    expect(root.querySelectorAll('.asset-overview-histogram-interactive .modality-legend-item'))
      .toHaveLength(DATASET_NAMES.length);
  });
});

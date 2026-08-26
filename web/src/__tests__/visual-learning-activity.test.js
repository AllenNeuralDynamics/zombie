import { describe, expect, it } from 'vitest';

import {
  aggregateActivityByCellType,
  computeVisualLearningPsths,
  joinVisualLearningCells,
  normaliseActivityTimeDomain,
} from '../swdb/visual-learning-activity.js';

describe('Visual Learning cell-type activity transforms', () => {
  it('joins registered ROI columns to annotated HCR cells and removes duplicates', () => {
    const rows = joinVisualLearningCells([
      { plane_id: 0, roi_id: 3, hcr_id: 10 },
      { plane_id: 0, roi_id: 3, hcr_id: 10 },
      { plane_id: 'VISp_1', roi_id: 2, hcr_id: 11 },
      { plane_id: 1, roi_id: 4, hcr_id: 99 },
    ], [
      { cell_id: '10', cell_class: 'excitatory', cell_subclass: 'none', cell_type: 'Exc-1' },
      { cell_id: '11', cell_class: 'inhibitory', cell_subclass: 'Pvalb', cell_type: 'Pvalb-1' },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.plane)).toEqual(['VISp_0', 'VISp_1']);
    expect(rows[1].cellType).toBe('Pvalb-1');
  });

  it('aggregates activity into cell-type rows on the y axis', () => {
    const result = aggregateActivityByCellType([
      { cellType: 'Exc-1', timestamps: [0, 1, 2], values: [1, 3, 5] },
      { cellType: 'Pvalb-1', timestamps: [0, 1, 2], values: [2, 4, 6] },
    ], { maxBins: 2 });

    expect(result.cellTypes).toEqual(['Exc-1', 'Pvalb-1']);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.find((row) => row.cell_type === 'Pvalb-1').y0).toBe(1);
  });

  it('computes event-aligned averages independently for each cell type', () => {
    const rows = computeVisualLearningPsths([
      { cellType: 'Exc-1', timestamps: [0, 1, 2, 3, 4, 5], values: [0, 1, 2, 3, 4, 5] },
      { cellType: 'Pvalb-1', timestamps: [0, 1, 2, 3, 4, 5], values: [5, 4, 3, 2, 1, 0] },
    ], [2], { pre: 1, post: 2, bins: 3 });

    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.cell_type))).toEqual(new Set(['Exc-1', 'Pvalb-1']));
    expect(rows.every((row) => row.n === 1 && Number.isFinite(row.mean))).toBe(true);
  });

  it('clips the task playback zoom window to the cell trace time range', () => {
    expect(normaliseActivityTimeDomain([10, 40], 0, 30)).toEqual([10, 30]);
    expect(normaliseActivityTimeDomain([-5, 8], 0, 30)).toEqual([0, 8]);
    expect(normaliseActivityTimeDomain(null, 0, 30)).toEqual([0, 30]);
  });
});

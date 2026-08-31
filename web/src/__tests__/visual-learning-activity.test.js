import { describe, expect, it } from 'vitest';

import {
  aggregateActivityByCellType,
  aggregateActivityBySubclassSeries,
  aggregateGeneExpressionByCellType,
  computeVisualLearningPsths,
  joinVisualLearningCells,
  matchedCellIdsFromTraces,
  normaliseActivityTimeDomain,
} from '../swdb/visual-learning-activity.js';
import { VISUAL_LEARNING_GENE_COLUMNS } from '../swdb/data.js';

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
    expect(new Set(rows.map((row) => row.group))).toEqual(new Set(['Exc-1', 'Pvalb-1']));
    expect(rows.every((row) => row.n === 1 && Number.isFinite(row.mean) && Number.isFinite(row.t))).toBe(true);
  });

  it('groups PSTH rows by a custom accessor, e.g. cell subclass instead of cell type', () => {
    const rows = computeVisualLearningPsths([
      { cellType: 'Exc-1', cellSubclass: 'Sst', timestamps: [0, 1, 2, 3, 4, 5], values: [0, 1, 2, 3, 4, 5] },
      { cellType: 'Pvalb-1', cellSubclass: 'Sst', timestamps: [0, 1, 2, 3, 4, 5], values: [5, 4, 3, 2, 1, 0] },
    ], [2], { pre: 1, post: 2, bins: 3, groupBy: (trace) => trace.cellSubclass });

    // Both traces share a subclass, so they should merge into one group
    // instead of the two groups a cell-type grouping would produce.
    expect(new Set(rows.map((row) => row.group))).toEqual(new Set(['Sst']));
  });

  it('aggregates traces into a mean dF/F time series per cell subclass', () => {
    const result = aggregateActivityBySubclassSeries([
      { cellSubclass: 'Pvalb', timestamps: [0, 1, 2], values: [1, 3, 5] },
      { cellSubclass: 'Sst', timestamps: [0, 1, 2], values: [2, 4, 6] },
    ], { maxBins: 2 });

    expect(result.subclasses).toEqual(['Pvalb', 'Sst']);
    expect(result.rows).toHaveLength(4);
    expect(result.rows.every((row) => Number.isFinite(row.t) && Number.isFinite(row.activity))).toBe(true);
  });

  it('falls back to "unassigned" for traces with no subclass label', () => {
    const result = aggregateActivityBySubclassSeries([
      { timestamps: [0, 1], values: [1, 1] },
    ], { maxBins: 1 });

    expect(result.subclasses).toEqual(['unassigned']);
  });

  it('resamples to a fixed ~10 Hz rate regardless of session length', () => {
    const span = 5;
    const n = 500;
    const timestamps = Array.from({ length: n }, (_, i) => (i / (n - 1)) * span);
    const values = timestamps.map(() => 1);
    const result = aggregateActivityBySubclassSeries([{ cellSubclass: 'Pvalb', timestamps, values }]);

    // ~10 Hz over a 5 s span should land close to 50 output samples, not a
    // handful of multi-second-wide bins.
    expect(result.rows.length).toBeGreaterThanOrEqual(45);
    expect(result.rows.length).toBeLessThanOrEqual(51);
  });

  it('aggregates per-cell gene counts into mean-expression-by-cell-type rows', () => {
    const [geneA, geneB] = VISUAL_LEARNING_GENE_COLUMNS;
    const result = aggregateGeneExpressionByCellType([
      { cell_type: 'Exc-1', [geneA]: 2, [geneB]: 0 },
      { cell_type: 'Exc-1', [geneA]: 4, [geneB]: 2 },
      { cell_type: 'Pvalb-1', [geneA]: 10, [geneB]: 6 },
    ]);

    expect(result.cellTypes).toEqual(['Exc-1', 'Pvalb-1']);
    expect(result.genes).toBe(VISUAL_LEARNING_GENE_COLUMNS);
    expect(result.rows).toHaveLength(2 * VISUAL_LEARNING_GENE_COLUMNS.length);
    expect(result.rows.find((row) => row.cell_type === 'Exc-1' && row.gene === geneA).mean_expression).toBe(3);
    expect(result.rows.find((row) => row.cell_type === 'Pvalb-1' && row.gene === geneB).mean_expression).toBe(6);
    expect(result.cellCounts.get('Exc-1')).toBe(2);
    expect(result.cellCounts.get('Pvalb-1')).toBe(1);
  });

  it('restricts gene-expression cell counts to cells that made it into the physiology traces', () => {
    // Cell 2 is annotated but, e.g., its ROI fell outside this session's
    // packed trace range — it must not inflate the gene-expression "n".
    const cellRows = [
      { cell_id: '1', cell_type: 'Exc-1' },
      { cell_id: '2', cell_type: 'Exc-1' },
      { cell_id: '3', cell_type: 'Pvalb-1' },
    ];
    const traces = [
      { cellId: '1', cellType: 'Exc-1', timestamps: [0, 1], values: [1, 1] },
      { cellId: '3', cellType: 'Pvalb-1', timestamps: [0, 1], values: [1, 1] },
    ];

    const matchedIds = matchedCellIdsFromTraces(traces);
    const matchedRows = cellRows.filter((row) => matchedIds.has(row.cell_id));
    const geneExpression = aggregateGeneExpressionByCellType(matchedRows);
    const activityCellTypes = new Set(traces.map((trace) => trace.cellType));

    expect(geneExpression.cellCounts.get('Exc-1')).toBe(1);
    expect(geneExpression.cellCounts.get('Pvalb-1')).toBe(1);
    // Same population underlies both plots, so their cell-type sets agree
    // without either side hard-coding the other's counts.
    expect(new Set(geneExpression.cellTypes)).toEqual(activityCellTypes);
  });

  it('clips the task playback zoom window to the cell trace time range', () => {
    expect(normaliseActivityTimeDomain([10, 40], 0, 30)).toEqual([10, 30]);
    expect(normaliseActivityTimeDomain([-5, 8], 0, 30)).toEqual([0, 8]);
    expect(normaliseActivityTimeDomain(null, 0, 30)).toEqual([0, 30]);
  });
});

/**
 * fiber-photometry-view.test.js — Unit tests for pure helpers in
 * fiber_photometry/view.js.
 */

import { describe, it, expect } from 'vitest';
import { buildMissingTable, pivotLongFormRows } from '../fiber_photometry/view.js';

// ---------------------------------------------------------------------------
// buildMissingTable — uses pre-normalized investigators_normalized column
// ---------------------------------------------------------------------------

describe('buildMissingTable', () => {
  // Wide-form rows as produced by pivotLongFormRows after the SQL join.
  // investigators comes from asset_basics.investigators_normalized (already a
  // formatted comma-separated display-name string).

  function makeWideRow(overrides) {
    return {
      asset_name: 'asset_001',
      code_ocean: null,
      investigators: 'Nick Ponvert, Anna Mcdougal', // pre-normalized
      'Fiber_0/Target': '',
      'Fiber_0/Green': 'calcium',
      ...overrides,
    };
  }

  it('returns empty array when all fibers are complete', () => {
    const rows = [
      makeWideRow({ 'Fiber_0/Target': 'VTA', 'Fiber_0/Green': 'calcium' }),
    ];
    expect(buildMissingTable(rows)).toHaveLength(0);
  });

  it('flags a fiber with no target', () => {
    const rows = [
      makeWideRow({ 'Fiber_0/Target': '', 'Fiber_0/Green': 'calcium' }),
    ];
    const result = buildMissingTable(rows);
    expect(result).toHaveLength(1);
    expect(result[0].incompleteInfo).toContain('Fiber_0/Target');
  });

  it('flags a fiber where all color channels are missing', () => {
    const rows = [
      makeWideRow({ 'Fiber_0/Target': 'VTA', 'Fiber_0/Green': '', 'Fiber_0/Red': '' }),
    ];
    const result = buildMissingTable(rows);
    expect(result).toHaveLength(1);
    expect(result[0].incompleteInfo).toContain('Fiber_0: no intended measurement');
  });

  it('uses the investigators field directly without re-normalizing', () => {
    // investigators is already "Nick Ponvert, Anna Mcdougal" from the backend
    const rows = [
      makeWideRow({ 'Fiber_0/Target': '' }),
    ];
    const result = buildMissingTable(rows);
    expect(result[0].investigators).toBe('Nick Ponvert, Anna Mcdougal');
  });

  it('handles null investigators gracefully', () => {
    const rows = [
      makeWideRow({ investigators: null, 'Fiber_0/Target': '' }),
    ];
    const result = buildMissingTable(rows);
    expect(result[0].investigators).toBe('');
  });

  it('sorts result by asset_name', () => {
    const rows = [
      makeWideRow({ asset_name: 'b_asset', 'Fiber_0/Target': '' }),
      makeWideRow({ asset_name: 'a_asset', 'Fiber_0/Target': '' }),
    ];
    const result = buildMissingTable(rows);
    expect(result[0].asset_name).toBe('a_asset');
    expect(result[1].asset_name).toBe('b_asset');
  });
});

// ---------------------------------------------------------------------------
// pivotLongFormRows — passes investigators_normalized through to wideRow
// ---------------------------------------------------------------------------

describe('pivotLongFormRows with investigators_normalized', () => {
  it('copies investigators field from long row into wide row', () => {
    const longRows = [
      {
        asset_name: 'asset_001',
        fiber: 'Fiber_0',
        channel: 'Fiber 0 Green',
        targeted_structure: 'VTA',
        intended_measurement: 'calcium',
        subject_id: 'sub-001',
        project_name: 'TestProject',
        acquisition_start_time: '2025-01-01T00:00:00Z',
        data_level: 'raw',
        modalities: 'fib',
        genotype: 'wt/wt',
        location: 's3://bucket/path',
        code_ocean: null,
        investigators: 'Nick Ponvert',   // already normalized
        experimenters: 'Anna Mcdougal',
      },
    ];
    const wideRows = pivotLongFormRows(longRows);
    expect(wideRows).toHaveLength(1);
    expect(wideRows[0].investigators).toBe('Nick Ponvert');
  });
});

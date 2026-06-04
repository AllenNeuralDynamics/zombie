/**
 * sessions-view.test.js — Unit tests for pure helpers in sessions/view.js.
 */

import { describe, it, expect } from 'vitest';
import {
  getQuarterLabel, collectQuarters, applyFilters,
  countByExperimenter, countByProject, renderSessionRow,
} from '../sessions/view.js';

// ---------------------------------------------------------------------------
// getQuarterLabel
// ---------------------------------------------------------------------------

describe('getQuarterLabel', () => {
  it('returns correct quarter for each month', () => {
    expect(getQuarterLabel('2025-01-15T00:00:00Z')).toBe('2025-Q1');
    expect(getQuarterLabel('2025-04-01T00:00:00Z')).toBe('2025-Q2');
    expect(getQuarterLabel('2025-07-31T00:00:00Z')).toBe('2025-Q3');
    expect(getQuarterLabel('2025-10-01T00:00:00Z')).toBe('2025-Q4');
  });

  it('returns empty string for null or invalid', () => {
    expect(getQuarterLabel(null)).toBe('');
    expect(getQuarterLabel('')).toBe('');
    expect(getQuarterLabel('not-a-date')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// collectQuarters
// ---------------------------------------------------------------------------

describe('collectQuarters', () => {
  it('collects unique quarters from rows, sorted descending', () => {
    const rows = [
      { acquisition_start_time: '2025-01-10T00:00:00Z' },
      { acquisition_start_time: '2025-04-10T00:00:00Z' },
      { acquisition_start_time: '2025-01-20T00:00:00Z' },
      { acquisition_start_time: null },
    ];
    expect(collectQuarters(rows)).toEqual(['2025-Q2', '2025-Q1']);
  });
});

// ---------------------------------------------------------------------------
// applyFilters — exercises the code paths that use pre-normalized column data
// (instrument_id and experimenters come from backend-normalized columns)
// ---------------------------------------------------------------------------

describe('applyFilters', () => {
  // Rows as they arrive after the SQL aliasing: instrument_id is already
  // the short normalized name, experimenters is already comma-separated
  // display names produced by the backend.
  const ROWS = [
    {
      project_name: 'ProjectA',
      instrument_id: 'MESO.0',
      experimenters: 'Anna Mcdougal, Nick Ponvert',
      acquisition_start_time: '2025-01-15T00:00:00Z',
    },
    {
      project_name: 'ProjectB',
      instrument_id: 'BEH.1',
      experimenters: 'John Doe',
      acquisition_start_time: '2025-04-20T00:00:00Z',
    },
    {
      project_name: 'ProjectA',
      instrument_id: 'BEH.1',
      experimenters: 'Nick Ponvert',
      acquisition_start_time: '2025-01-20T00:00:00Z',
    },
  ];

  it('returns all rows when all filter sets are empty', () => {
    expect(applyFilters(ROWS, new Set(), new Set(), new Set())).toHaveLength(3);
  });

  it('filters by project', () => {
    const result = applyFilters(ROWS, new Set(['ProjectA']), new Set(), new Set());
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.project_name === 'ProjectA')).toBe(true);
  });

  it('filters by normalized instrument_id', () => {
    const result = applyFilters(ROWS, new Set(), new Set(['MESO.0']), new Set());
    expect(result).toHaveLength(1);
    expect(result[0].instrument_id).toBe('MESO.0');
  });

  it('filters by quarter', () => {
    const result = applyFilters(ROWS, new Set(), new Set(), new Set(['2025-Q1']));
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.acquisition_start_time?.startsWith('2025-01'))).toBe(true);
  });

  it('filters by experimenter display name (pre-normalized)', () => {
    const result = applyFilters(ROWS, new Set(), new Set(), new Set(), new Set(['Nick Ponvert']));
    expect(result).toHaveLength(2);
  });

  it('filters by experimenter excludes rows with no match', () => {
    const result = applyFilters(ROWS, new Set(), new Set(), new Set(), new Set(['John Doe']));
    expect(result).toHaveLength(1);
    expect(result[0].project_name).toBe('ProjectB');
  });

  it('combined project + instrument filter', () => {
    const result = applyFilters(ROWS, new Set(['ProjectA']), new Set(['BEH.1']), new Set());
    expect(result).toHaveLength(1);
    expect(result[0].instrument_id).toBe('BEH.1');
    expect(result[0].project_name).toBe('ProjectA');
  });
});

// ---------------------------------------------------------------------------
// countByExperimenter — uses pre-normalized experimenter display names
// ---------------------------------------------------------------------------

describe('countByExperimenter', () => {
  const ROWS = [
    { experimenters: 'Nick Ponvert', acquisition_start_time: '2025-01-01T00:00:00Z', acquisition_end_time: '2025-01-01T01:00:00Z' },
    { experimenters: 'Nick Ponvert', acquisition_start_time: '2025-01-02T00:00:00Z', acquisition_end_time: '2025-01-02T01:30:00Z' },
    { experimenters: 'Anna Mcdougal', acquisition_start_time: '2025-01-03T00:00:00Z', acquisition_end_time: '2025-01-03T02:00:00Z' },
    { experimenters: 'Anna Mcdougal, Nick Ponvert', acquisition_start_time: '2025-01-04T00:00:00Z', acquisition_end_time: '2025-01-04T00:15:00Z' },
    { experimenters: null, acquisition_start_time: '2025-01-05T00:00:00Z', acquisition_end_time: null },
  ];

  it('counts sessions per experimenter', () => {
    const result = countByExperimenter(ROWS);
    const nickRow = result.find((r) => r.experimenter === 'Nick Ponvert');
    expect(nickRow).toBeDefined();
    expect(nickRow.count).toBe(3); // rows 0, 1, 3
  });

  it('counts sessions for experimenter with a single entry', () => {
    const result = countByExperimenter(ROWS);
    const annaRow = result.find((r) => r.experimenter === 'Anna Mcdougal');
    expect(annaRow.count).toBe(2); // rows 2, 3
  });

  it('sorts result alphabetically by experimenter name', () => {
    const result = countByExperimenter(ROWS);
    const names = result.map((r) => r.experimenter);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('excludes rows with no experimenters from counts', () => {
    const result = countByExperimenter(ROWS);
    expect(result.find((r) => r.experimenter === '(none)')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// renderSessionRow — smoke-tests HTML output with pre-normalized columns
// ---------------------------------------------------------------------------

describe('renderSessionRow', () => {
  it('renders a table row with pre-normalized instrument_id', () => {
    const row = {
      subject_id: 'sub-001',
      acquisition_start_time: '2025-03-01T10:00:00Z',
      project_name: 'TestProject',
      instrument_id: 'MESO.0',          // already normalized by backend column
      experimenters: 'Nick Ponvert',    // already a display name from backend
      modalities: 'behavior',
      genotype: 'wt/wt',
    };
    const html = renderSessionRow(row);
    expect(html).toContain('<tr>');
    expect(html).toContain('MESO.0');
    expect(html).toContain('Nick Ponvert');
    expect(html).toContain('sub-001');
  });

  it('handles null fields without throwing', () => {
    const row = {
      subject_id: null,
      acquisition_start_time: null,
      project_name: null,
      instrument_id: null,
      experimenters: null,
      modalities: null,
      genotype: null,
    };
    expect(() => renderSessionRow(row)).not.toThrow();
    expect(renderSessionRow(row)).toContain('<tr>');
  });
});

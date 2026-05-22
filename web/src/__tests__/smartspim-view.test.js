/**
 * smartspim-view.test.js — Unit tests for pure helpers in smartspim/view.js.
 *
 * createSmartSpimView() requires a live coordinator + DOM and is not tested here.
 */

import { describe, it, expect } from 'vitest';
import {
  buildNeuroglancerLink,
  formatDatetime,
  isProcessed,
  renderSmartSpimRow,
  pivotLongFormRows,
  sortRows,
  uniqueValues,
  filterRows,
} from '../smartspim/view.js';

// ---------------------------------------------------------------------------
// buildNeuroglancerLink
// ---------------------------------------------------------------------------

describe('buildNeuroglancerLink', () => {
  it('returns an anchor tag for a valid URL', () => {
    const html = buildNeuroglancerLink('https://neuroglancer.example.com/#!...', 'Stitched');
    expect(html).toContain('<a ');
    expect(html).toContain('Stitched');
    expect(html).toContain('href=');
  });

  it('returns a dash placeholder for null', () => {
    expect(buildNeuroglancerLink(null, 'Seg')).toContain('—');
  });

  it('returns a dash placeholder for undefined', () => {
    expect(buildNeuroglancerLink(undefined, 'Quant')).toContain('—');
  });

  it('sets target="_blank" and rel="noopener noreferrer"', () => {
    const html = buildNeuroglancerLink('https://example.com', 'X');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('escapes double-quotes in the URL', () => {
    const html = buildNeuroglancerLink('https://example.com/a"b', 'X');
    expect(html).not.toContain('"b');
    expect(html).toContain('&quot;');
  });
});

// ---------------------------------------------------------------------------
// formatDatetime
// ---------------------------------------------------------------------------

describe('formatDatetime', () => {
  it('formats an ISO UTC string to YYYY-MM-DD HH:MM', () => {
    expect(formatDatetime('2024-03-15T09:05:00Z')).toBe('2024-03-15 09:05');
  });

  it('handles ISO string with timezone offset', () => {
    const result = formatDatetime('2024-01-31T16:23:16-08:00');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('returns empty string for null', () => {
    expect(formatDatetime(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(formatDatetime(undefined)).toBe('');
  });

  it('returns the original string for unparseable input', () => {
    expect(formatDatetime('not-a-date')).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// isProcessed
// ---------------------------------------------------------------------------

describe('isProcessed', () => {
  it('returns true for boolean true', () => {
    expect(isProcessed({ processed: true })).toBe(true);
  });

  it('returns true for string "true"', () => {
    expect(isProcessed({ processed: 'true' })).toBe(true);
  });

  it('returns true for string "Yes"', () => {
    expect(isProcessed({ processed: 'Yes' })).toBe(true);
  });

  it('returns false for boolean false', () => {
    expect(isProcessed({ processed: false })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isProcessed({ processed: null })).toBe(false);
  });

  it('returns false when field is absent', () => {
    expect(isProcessed({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pivotLongFormRows
// ---------------------------------------------------------------------------

describe('pivotLongFormRows', () => {
  const longRows = [
    {
      name: 'SmartSPIM_568105_2024-01-31',
      channel: 'Ex_488_Em_525',
      segmentation_link: 'https://neuroglancer.example.com/#!seg1',
      quantification_link: 'https://neuroglancer.example.com/#!quant1',
      processing_end_time: '2024-02-15T13:39:23Z',
      stitched_link: 'https://neuroglancer.example.com/#!stitched',
      processed: true,
      subject_id: '568105',
      project_name: 'BrainVAST',
      acquisition_start_time: '2024-01-31T16:23:16Z',
      genotype: 'Rorb-IRES2-Cre-neo/wt',
      location: 's3://bucket/asset/',
      code_ocean: 'abc123',
      experimenters: 'Alice, Bob',
    },
    {
      name: 'SmartSPIM_568105_2024-01-31',
      channel: 'Ex_561_Em_600',
      segmentation_link: null,
      quantification_link: null,
      processing_end_time: '2024-02-15T13:39:23Z',
      stitched_link: 'https://neuroglancer.example.com/#!stitched',
      processed: true,
      subject_id: '568105',
      project_name: 'BrainVAST',
      acquisition_start_time: '2024-01-31T16:23:16Z',
      genotype: 'Rorb-IRES2-Cre-neo/wt',
      location: 's3://bucket/asset/',
      code_ocean: 'abc123',
      experimenters: 'Alice, Bob',
    },
  ];

  it('produces one wide row per asset', () => {
    const wide = pivotLongFormRows(longRows);
    expect(wide).toHaveLength(1);
  });

  it('collects channel names', () => {
    const wide = pivotLongFormRows(longRows);
    expect(wide[0]._channels).toContain('Ex_488_Em_525');
    expect(wide[0]._channels).toContain('Ex_561_Em_600');
  });

  it('stores newline-joined channels string', () => {
    const wide = pivotLongFormRows(longRows);
    expect(wide[0].channels).toContain('Ex_488_Em_525');
    expect(wide[0].channels).toContain('\n');
  });

  it('carries segmentation link for first channel', () => {
    const wide = pivotLongFormRows(longRows);
    expect(wide[0]['_seg_Ex_488_Em_525']).toBe('https://neuroglancer.example.com/#!seg1');
  });

  it('copies basics fields from first row', () => {
    const wide = pivotLongFormRows(longRows);
    expect(wide[0].subject_id).toBe('568105');
    expect(wide[0].project_name).toBe('BrainVAST');
    expect(wide[0].experimenters).toBe('Alice, Bob');
  });

  it('handles empty input', () => {
    expect(pivotLongFormRows([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderSmartSpimRow
// ---------------------------------------------------------------------------

describe('renderSmartSpimRow', () => {
  const baseRow = {
    name: 'SmartSPIM_568105_2024-01-31',
    subject_id: '568105',
    project_name: 'BrainVAST',
    genotype: 'Rorb-IRES2-Cre-neo/wt',
    acquisition_start_time: '2024-01-31T16:23:16Z',
    processing_end_time: '2024-02-15T13:39:23Z',
    stitched_link: 'https://neuroglancer.example.com/#!stitched',
    processed: true,
    experimenters: 'Alice, Bob',
    location: 's3://bucket/asset/',
    code_ocean: 'abc123',
    _channels: ['Ex_488_Em_525', 'Ex_561_Em_600'],
    channels: 'Ex_488_Em_525\nEx_561_Em_600',
    '_seg_Ex_488_Em_525': 'https://neuroglancer.example.com/#!seg1',
    '_quant_Ex_488_Em_525': 'https://neuroglancer.example.com/#!quant1',
    '_seg_Ex_561_Em_600': null,
    '_quant_Ex_561_Em_600': null,
  };

  const defaultCols = ['subject_id', 'project_name', 'genotype', 'acquisition_start_time', 'processing_end_time', 'channels', 'processed'];

  it('produces a <tr> element', () => {
    const html = renderSmartSpimRow(baseRow, defaultCols);
    expect(html).toMatch(/^<tr>/);
    expect(html).toMatch(/<\/tr>$/);
  });

  it('includes subject_id', () => {
    expect(renderSmartSpimRow(baseRow, defaultCols)).toContain('568105');
  });

  it('includes channel names', () => {
    const html = renderSmartSpimRow(baseRow, defaultCols);
    expect(html).toContain('Ex_488_Em_525');
    expect(html).toContain('Ex_561_Em_600');
  });

  it('renders stitched link in link cell', () => {
    expect(renderSmartSpimRow(baseRow, defaultCols)).toContain('Stitched');
  });

  it('renders seg link for channel with data', () => {
    expect(renderSmartSpimRow(baseRow, defaultCols)).toContain('Seg');
  });

  it('renders CO and QC links', () => {
    const html = renderSmartSpimRow(baseRow, defaultCols);
    expect(html).toContain('CO');
    expect(html).toContain('QC');
  });

  it('renders processed badge Yes when processed is true', () => {
    expect(renderSmartSpimRow(baseRow, defaultCols)).toContain('badge-yes');
  });

  it('renders processed badge No when processed is false', () => {
    const html = renderSmartSpimRow({ ...baseRow, processed: false }, defaultCols);
    expect(html).toContain('badge-no');
  });

  it('handles missing fields without throwing', () => {
    expect(() => renderSmartSpimRow({}, defaultCols)).not.toThrow();
  });

  it('escapes HTML characters in text fields', () => {
    const html = renderSmartSpimRow({ ...baseRow, genotype: '<b>Test</b>' }, defaultCols);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

// ---------------------------------------------------------------------------
// sortRows
// ---------------------------------------------------------------------------

describe('sortRows', () => {
  const rows = [
    { subject_id: 'C', acquisition_start_time: '2024-03-01' },
    { subject_id: 'A', acquisition_start_time: '2024-01-01' },
    { subject_id: 'B', acquisition_start_time: '2024-02-01' },
  ];

  it('sorts ascending', () => {
    const sorted = sortRows([...rows], 'subject_id', 'asc');
    expect(sorted.map((r) => r.subject_id)).toEqual(['A', 'B', 'C']);
  });

  it('sorts descending', () => {
    const sorted = sortRows([...rows], 'subject_id', 'desc');
    expect(sorted.map((r) => r.subject_id)).toEqual(['C', 'B', 'A']);
  });

  it('handles missing column values', () => {
    const r = [{ subject_id: 'B' }, {}, { subject_id: 'A' }];
    const sorted = sortRows(r, 'subject_id', 'asc');
    expect(sorted[0].subject_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// uniqueValues
// ---------------------------------------------------------------------------

describe('uniqueValues', () => {
  it('returns sorted unique non-empty values', () => {
    const rows = [
      { institution: 'AIND' },
      { institution: 'AIBS' },
      { institution: 'AIND' },
      { institution: null },
      { institution: '' },
    ];
    expect(uniqueValues(rows, 'institution')).toEqual(['AIBS', 'AIND']);
  });

  it('returns empty array for empty rows', () => {
    expect(uniqueValues([], 'institution')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterRows
// ---------------------------------------------------------------------------

describe('filterRows', () => {
  const rows = [
    { subject_id: '100', institution: 'AIND', channels: 'Ex_488_Em_525\nEx_561_Em_600' },
    { subject_id: '200', institution: 'AIBS', channels: 'Ex_561_Em_600' },
    { subject_id: '300', institution: 'AIND', channels: 'Ex_445_Em_469' },
  ];

  it('returns all rows when no filters active', () => {
    expect(filterRows(rows, { subject_id: '', institution: '' })).toHaveLength(3);
  });

  it('filters by exact institution', () => {
    const result = filterRows(rows, { institution: 'AIND' });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.institution === 'AIND')).toBe(true);
  });

  it('filters case-insensitively', () => {
    expect(filterRows(rows, { institution: 'aind' })).toHaveLength(2);
  });

  it('applies multiple filters conjunctively', () => {
    const result = filterRows(rows, { institution: 'AIND', channels: '488' });
    expect(result).toHaveLength(1);
    expect(result[0].subject_id).toBe('100');
  });

  it('returns empty array when no rows match', () => {
    expect(filterRows(rows, { institution: 'NONEXISTENT' })).toHaveLength(0);
  });
});

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
  institutionSlices,
  buildPieSvg,
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
// renderSmartSpimRow
// ---------------------------------------------------------------------------

describe('renderSmartSpimRow', () => {
  const baseRow = {
    subject_id: '568105',
    genotype: 'Rorb-IRES2-Cre-neo/wt',
    institution: 'AIND',
    acquisition_start_time: '2024-01-31T16:23:16Z',
    processing_end_time: '2024-02-15T13:39:23Z',
    stitched_link: 'https://neuroglancer.example.com/#!stitched',
    processed: true,
    name: 'SmartSPIM_568105_2024-01-31',
    channel_1: 'Ex_488_Em_525',
    segmentation_link_1: 'https://neuroglancer.example.com/#!seg1',
    quantification_link_1: 'https://neuroglancer.example.com/#!quant1',
    channel_2: 'Ex_561_Em_600',
    segmentation_link_2: 'https://neuroglancer.example.com/#!seg2',
    quantification_link_2: 'https://neuroglancer.example.com/#!quant2',
    channel_3: null,
    segmentation_link_3: null,
    quantification_link_3: null,
  };

  it('produces a <tr> element', () => {
    const html = renderSmartSpimRow(baseRow);
    expect(html).toMatch(/^<tr>/);
    expect(html).toMatch(/<\/tr>$/);
  });

  it('includes subject_id', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('568105');
  });

  it('includes institution', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('AIND');
  });

  it('includes channel_1', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('Ex_488_Em_525');
  });

  it('includes channel_2', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('Ex_561_Em_600');
  });

  it('renders stitched link', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('Stitched');
  });

  it('renders seg links for populated channels', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('Seg');
  });

  it('renders quant links for populated channels', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('Quant');
  });

  it('renders processed badge Yes when processed is true', () => {
    expect(renderSmartSpimRow(baseRow)).toContain('badge-yes');
  });

  it('renders processed badge No when processed is false', () => {
    const html = renderSmartSpimRow({ ...baseRow, processed: false });
    expect(html).toContain('badge-no');
  });

  it('renders dash when stitched_link is null', () => {
    const html = renderSmartSpimRow({ ...baseRow, stitched_link: null });
    expect(html).toContain('—');
  });

  it('handles missing fields without throwing', () => {
    expect(() => renderSmartSpimRow({})).not.toThrow();
  });

  it('escapes HTML characters in text fields', () => {
    const html = renderSmartSpimRow({ ...baseRow, genotype: '<b>Test</b>' });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

// ---------------------------------------------------------------------------
// institutionSlices
// ---------------------------------------------------------------------------

describe('institutionSlices', () => {
  const rows = [
    { institution: 'AIND' },
    { institution: 'AIND' },
    { institution: 'AIBS' },
    { institution: 'AIND' },
    { institution: 'AIBS' },
  ];

  it('returns slices sorted descending by count', () => {
    const slices = institutionSlices(rows);
    expect(slices[0].institution).toBe('AIND');
    expect(slices[0].count).toBe(3);
    expect(slices[1].institution).toBe('AIBS');
    expect(slices[1].count).toBe(2);
  });

  it('fractions sum to 1', () => {
    const slices = institutionSlices(rows);
    const total = slices.reduce((s, x) => s + x.fraction, 0);
    expect(total).toBeCloseTo(1);
  });

  it('returns empty array for empty input', () => {
    expect(institutionSlices([])).toEqual([]);
  });

  it('treats null institution as "Unknown"', () => {
    const slices = institutionSlices([{ institution: null }]);
    expect(slices[0].institution).toBe('Unknown');
  });
});

// ---------------------------------------------------------------------------
// buildPieSvg
// ---------------------------------------------------------------------------

describe('buildPieSvg', () => {
  it('returns empty string for empty slices', () => {
    expect(buildPieSvg([])).toBe('');
  });

  it('returns an SVG string', () => {
    const slices = [
      { institution: 'AIND', count: 3, fraction: 0.6 },
      { institution: 'AIBS', count: 2, fraction: 0.4 },
    ];
    const svg = buildPieSvg(slices);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('includes institution names in legend', () => {
    const slices = [
      { institution: 'AIND', count: 3, fraction: 0.6 },
      { institution: 'AIBS', count: 2, fraction: 0.4 },
    ];
    const svg = buildPieSvg(slices);
    expect(svg).toContain('AIND');
    expect(svg).toContain('AIBS');
  });

  it('includes path elements for each slice', () => {
    const slices = [
      { institution: 'AIND', count: 10, fraction: 1.0 },
    ];
    const svg = buildPieSvg(slices);
    expect(svg).toContain('<path');
  });

  it('escapes HTML in institution names', () => {
    const slices = [
      { institution: '<Evil>', count: 5, fraction: 1.0 },
    ];
    const svg = buildPieSvg(slices);
    expect(svg).not.toContain('<Evil>');
    expect(svg).toContain('&lt;Evil&gt;');
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
    { subject_id: '100', institution: 'AIND', channel: 'Ex_488_Em_525' },
    { subject_id: '200', institution: 'AIBS', channel: 'Ex_561_Em_600' },
    { subject_id: '300', institution: 'AIND', channel: 'Ex_445_Em_469' },
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
    const result = filterRows(rows, { institution: 'AIND', channel: '488' });
    expect(result).toHaveLength(1);
    expect(result[0].subject_id).toBe('100');
  });

  it('returns empty array when no rows match', () => {
    expect(filterRows(rows, { institution: 'NONEXISTENT' })).toHaveLength(0);
  });
});

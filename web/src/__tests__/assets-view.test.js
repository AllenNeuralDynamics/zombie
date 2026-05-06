/**
 * assets-view.test.js — Unit tests for pure helpers in assets-view.js.
 *
 * createAssetsView() requires a live coordinator + DOM and is not tested here.
 */

import { describe, it, expect } from 'vitest';
import {
  buildS3ConsoleUrl,
  buildQcLink,
  buildMetadataLink,
  buildCoLink,
  formatDatetime,
  renderAssetRow,
  sortRows,
  uniqueValues,
  filterRows,
} from '../assets/view.js';

// ---------------------------------------------------------------------------
// buildS3ConsoleUrl
// ---------------------------------------------------------------------------

describe('buildS3ConsoleUrl', () => {
  it('converts a standard s3:// path to an S3 console URL', () => {
    const url = buildS3ConsoleUrl('s3://aind-data/my-project/asset/');
    expect(url).toBe(
      'https://s3.console.aws.amazon.com/s3/buckets/aind-data?prefix=my-project/asset/',
    );
  });

  it('adds a trailing slash to the prefix when not present', () => {
    const url = buildS3ConsoleUrl('s3://my-bucket/some/path');
    expect(url).toContain('prefix=some/path/');
  });

  it('does not double-add trailing slash when already present', () => {
    const url = buildS3ConsoleUrl('s3://my-bucket/key/');
    expect(url).toContain('prefix=key/');
    expect(url).not.toContain('prefix=key//');
  });

  it('handles a bucket-only URI (no key)', () => {
    const url = buildS3ConsoleUrl('s3://just-a-bucket');
    expect(url).toBe('https://s3.console.aws.amazon.com/s3/buckets/just-a-bucket');
  });

  it('returns null for non-s3 strings', () => {
    expect(buildS3ConsoleUrl('https://example.com/file')).toBeNull();
    expect(buildS3ConsoleUrl('not-a-url')).toBeNull();
  });

  it('returns null for falsy input', () => {
    expect(buildS3ConsoleUrl(null)).toBeNull();
    expect(buildS3ConsoleUrl('')).toBeNull();
    expect(buildS3ConsoleUrl(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildQcLink
// ---------------------------------------------------------------------------

describe('buildQcLink', () => {
  it('returns the QC portal URL with encoded asset name', () => {
    const url = buildQcLink('my_asset_2024-01-01');
    expect(url).toBe('https://qc.allenneuraldynamics.org/view?name=my_asset_2024-01-01');
  });

  it('percent-encodes spaces in asset names', () => {
    expect(buildQcLink('asset name')).toContain('asset%20name');
  });

  it('returns null for falsy input', () => {
    expect(buildQcLink(null)).toBeNull();
    expect(buildQcLink('')).toBeNull();
    expect(buildQcLink(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildMetadataLink
// ---------------------------------------------------------------------------

describe('buildMetadataLink', () => {
  it('returns the metadata portal URL with encoded asset name', () => {
    const url = buildMetadataLink('my-asset');
    expect(url).toBe('https://metadata-portal.allenneuraldynamics.org/view?name=my-asset');
  });

  it('returns null for falsy input', () => {
    expect(buildMetadataLink(null)).toBeNull();
    expect(buildMetadataLink('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildCoLink
// ---------------------------------------------------------------------------

describe('buildCoLink', () => {
  it('returns a Code Ocean data-asset URL', () => {
    const url = buildCoLink('abc-123');
    expect(url).toContain('codeocean.allenneuraldynamics.org');
    expect(url).toContain('/data-assets/abc-123');
  });

  it('does not use the /capsule/ path', () => {
    const url = buildCoLink('abc-123');
    expect(url).not.toContain('/capsule/');
  });

  it('returns null for falsy input', () => {
    expect(buildCoLink(null)).toBeNull();
    expect(buildCoLink('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatDatetime
// ---------------------------------------------------------------------------

describe('formatDatetime', () => {
  it('formats an ISO datetime to YYYY-MM-DD HH:MM (UTC)', () => {
    expect(formatDatetime('2024-03-15T14:30:00Z')).toBe('2024-03-15 14:30');
  });

  it('handles datetime strings with milliseconds', () => {
    expect(formatDatetime('2024-06-01T08:05:00.000Z')).toBe('2024-06-01 08:05');
  });

  it('returns empty string for falsy values', () => {
    expect(formatDatetime(null)).toBe('');
    expect(formatDatetime('')).toBe('');
    expect(formatDatetime(undefined)).toBe('');
  });

  it('returns the raw string for invalid dates', () => {
    expect(formatDatetime('not-a-date')).toBe('not-a-date');
  });
});

// ---------------------------------------------------------------------------
// renderAssetRow
// ---------------------------------------------------------------------------

describe('renderAssetRow', () => {
  const row = {
    _id: 'id-001',
    name: 'ecephys_12345_2024-01-01',
    subject_id: '12345',
    acquisition_start_time: '2024-01-01T10:00:00Z',
    project_name: 'MyProject',
    modalities: 'ecephys',
    data_level: 'raw',
    genotype: 'wt',
    location: 's3://aind-data/ecephys/asset/',
    code_ocean: 'capsule-xyz',
    process_date: null,
  };

  it('returns a <tr> string', () => {
    const html = renderAssetRow(row);
    expect(html).toMatch(/^<tr>/);
    expect(html).toMatch(/<\/tr>$/);
  });

  it('includes the subject_id', () => {
    expect(renderAssetRow(row)).toContain('12345');
  });

  it('includes formatted acquisition time', () => {
    expect(renderAssetRow(row)).toContain('2024-01-01 10:00');
  });

  it('includes S3 console link', () => {
    const html = renderAssetRow(row);
    expect(html).toContain('s3.console.aws.amazon.com');
  });

  it('includes QC, metadata, and CO links', () => {
    const html = renderAssetRow(row);
    expect(html).toContain('qc.allenneuraldynamics.org');
    expect(html).toContain('metadata-portal.allenneuraldynamics.org');
    expect(html).toContain('codeocean.allenneuraldynamics.org');
  });

  it('renders fallback "—" when code_ocean is missing', () => {
    const html = renderAssetRow({ ...row, code_ocean: null });
    expect(html).toContain('no-link');
  });

  it('handles missing optional fields without throwing', () => {
    expect(() => renderAssetRow({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sortRows
// ---------------------------------------------------------------------------

describe('sortRows', () => {
  const rows = [
    { subject_id: 'B', acquisition_start_time: '2024-02-01T00:00:00Z' },
    { subject_id: 'A', acquisition_start_time: '2024-03-01T00:00:00Z' },
    { subject_id: 'C', acquisition_start_time: '2024-01-01T00:00:00Z' },
  ];

  it('sorts ascending by a string column', () => {
    const sorted = sortRows([...rows], 'subject_id', 'asc');
    expect(sorted.map((r) => r.subject_id)).toEqual(['A', 'B', 'C']);
  });

  it('sorts descending by a string column', () => {
    const sorted = sortRows([...rows], 'subject_id', 'desc');
    expect(sorted.map((r) => r.subject_id)).toEqual(['C', 'B', 'A']);
  });

  it('sorts by datetime strings lexicographically', () => {
    const sorted = sortRows([...rows], 'acquisition_start_time', 'asc');
    expect(sorted[0].acquisition_start_time).toContain('2024-01-01');
    expect(sorted[2].acquisition_start_time).toContain('2024-03-01');
  });

  it('treats null values as empty string (sorts first in asc)', () => {
    const withNull = [...rows, { subject_id: null, acquisition_start_time: null }];
    const sorted = sortRows(withNull, 'subject_id', 'asc');
    expect(sorted[0].subject_id).toBeNull();
  });

  it('modifies the array in-place and returns it', () => {
    const arr = [{ subject_id: 'B' }, { subject_id: 'A' }];
    const result = sortRows(arr, 'subject_id', 'asc');
    expect(result).toBe(arr); // same reference
  });
});

// ---------------------------------------------------------------------------
// uniqueValues
// ---------------------------------------------------------------------------

describe('uniqueValues', () => {
  const rows = [
    { project_name: 'Alpha', data_level: 'raw' },
    { project_name: 'Beta',  data_level: 'raw' },
    { project_name: 'Alpha', data_level: 'derived' },
    { project_name: null,    data_level: '' },
  ];

  it('returns unique non-null, non-empty values sorted', () => {
    expect(uniqueValues(rows, 'project_name')).toEqual(['Alpha', 'Beta']);
  });

  it('deduplicates values', () => {
    expect(uniqueValues(rows, 'data_level')).toEqual(['derived', 'raw']);
  });

  it('excludes null and empty-string values', () => {
    const vals = uniqueValues(rows, 'project_name');
    expect(vals).not.toContain(null);
    expect(vals).not.toContain('');
  });

  it('returns an empty array when all values are null/empty', () => {
    expect(uniqueValues([{ x: null }, { x: '' }], 'x')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// filterRows
// ---------------------------------------------------------------------------

describe('filterRows', () => {
  const rows = [
    { subject_id: '123', project_name: 'Alpha', data_level: 'raw' },
    { subject_id: '456', project_name: 'Beta',  data_level: 'derived' },
    { subject_id: '789', project_name: 'Alpha', data_level: 'derived' },
  ];

  it('returns all rows when all filters are empty strings', () => {
    expect(filterRows(rows, { subject_id: '', project_name: '' })).toHaveLength(3);
  });

  it('filters by exact value (select-style)', () => {
    const result = filterRows(rows, { project_name: 'Alpha' });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.project_name === 'Alpha')).toBe(true);
  });

  it('filters case-insensitively (substring match)', () => {
    const result = filterRows(rows, { project_name: 'alpha' });
    expect(result).toHaveLength(2);
  });

  it('returns an empty array when no rows match', () => {
    expect(filterRows(rows, { project_name: 'Gamma' })).toHaveLength(0);
  });

  it('applies multiple filters with AND logic', () => {
    const result = filterRows(rows, { project_name: 'Alpha', data_level: 'derived' });
    expect(result).toHaveLength(1);
    expect(result[0].subject_id).toBe('789');
  });

  it('handles null cell values without throwing', () => {
    const withNull = [{ subject_id: null, project_name: 'X' }];
    expect(() => filterRows(withNull, { subject_id: '1' })).not.toThrow();
  });
});

/**
 * settings.test.js — Unit tests for pure functions in settings.js.
 *
 * Only the URL helper functions and DOM-free exports are tested here.
 * initSettings() requires a live DOM + Mosaic coordinator and is covered by
 * future integration / browser tests.
 */

import { describe, it, expect } from 'vitest';
import {
  getInitialProjectsFromUrl,
  getInitialDataTypesFromUrl,
  getInitialExtraFiltersFromUrl,
  encodeExtraFilters,
  buildSettingsUrl,
} from '../settings.js';

// ---------------------------------------------------------------------------
// getInitialProjectsFromUrl
// ---------------------------------------------------------------------------

describe('getInitialProjectsFromUrl', () => {
  it('returns an empty array when the param is absent', () => {
    expect(getInitialProjectsFromUrl('')).toEqual([]);
    expect(getInitialProjectsFromUrl('?dataTypes=qc')).toEqual([]);
  });

  it('returns a single project name', () => {
    expect(getInitialProjectsFromUrl('?projects=my-project')).toEqual(['my-project']);
  });

  it('returns multiple project names split by comma', () => {
    expect(getInitialProjectsFromUrl('?projects=foo,bar')).toEqual(['foo', 'bar']);
  });

  it('decodes URL-encoded project names', () => {
    expect(getInitialProjectsFromUrl('?projects=my%20project')).toEqual(['my project']);
  });

  it('trims whitespace around each name', () => {
    expect(getInitialProjectsFromUrl('?projects=foo%20,%20bar')).toEqual(['foo', 'bar']);
  });

  it('filters out empty entries from double commas', () => {
    expect(getInitialProjectsFromUrl('?projects=foo,,bar,')).toEqual(['foo', 'bar']);
  });
});

// ---------------------------------------------------------------------------
// getInitialDataTypesFromUrl
// ---------------------------------------------------------------------------

describe('getInitialDataTypesFromUrl', () => {
  it('returns an empty array when the param is absent', () => {
    expect(getInitialDataTypesFromUrl('')).toEqual([]);
    expect(getInitialDataTypesFromUrl('?projects=foo')).toEqual([]);
  });

  it('returns a single data type', () => {
    expect(getInitialDataTypesFromUrl('?dataTypes=quality_control')).toEqual([
      'quality_control',
    ]);
  });

  it('returns multiple data types split by comma', () => {
    expect(getInitialDataTypesFromUrl('?dataTypes=quality_control,fiber_photometry')).toEqual([
      'quality_control',
      'fiber_photometry',
    ]);
  });

  it('trims whitespace around each type name', () => {
    expect(getInitialDataTypesFromUrl('?dataTypes=qc%20,%20fp')).toEqual(['qc', 'fp']);
  });

  it('filters out empty entries from trailing/double commas', () => {
    expect(getInitialDataTypesFromUrl('?dataTypes=qc,,fp,')).toEqual(['qc', 'fp']);
  });
});

// ---------------------------------------------------------------------------
// getInitialExtraFiltersFromUrl
// ---------------------------------------------------------------------------

describe('getInitialExtraFiltersFromUrl', () => {
  it('returns an empty array when the param is absent', () => {
    expect(getInitialExtraFiltersFromUrl('')).toEqual([]);
    expect(getInitialExtraFiltersFromUrl('?projects=foo')).toEqual([]);
  });

  it('parses a single filter with one value', () => {
    const result = getInitialExtraFiltersFromUrl('?extraFilters=genotype%3Awt');
    expect(result).toEqual([{ column: 'genotype', values: ['wt'] }]);
  });

  it('parses a single filter with multiple pipe-separated values', () => {
    const result = getInitialExtraFiltersFromUrl('?extraFilters=data_level%3Araw%7Cderived');
    expect(result).toEqual([{ column: 'data_level', values: ['raw', 'derived'] }]);
  });

  it('parses multiple comma-separated filter entries', () => {
    const result = getInitialExtraFiltersFromUrl(
      '?extraFilters=genotype%3Awt,data_level%3Araw',
    );
    expect(result).toEqual([
      { column: 'genotype', values: ['wt'] },
      { column: 'data_level', values: ['raw'] },
    ]);
  });

  it('drops entries with no column or no values', () => {
    const result = getInitialExtraFiltersFromUrl('?extraFilters=%3Awt,genotype%3A');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// encodeExtraFilters
// ---------------------------------------------------------------------------

describe('encodeExtraFilters', () => {
  it('returns empty string for empty array', () => {
    expect(encodeExtraFilters([])).toBe('');
  });

  it('encodes a single filter with one value', () => {
    const encoded = encodeExtraFilters([{ column: 'genotype', values: ['wt'] }]);
    expect(encoded).toContain('genotype');
    expect(encoded).toContain('wt');
    expect(encoded).toContain(':');
  });

  it('encodes multiple values with pipe separator', () => {
    const encoded = encodeExtraFilters([{ column: 'data_level', values: ['raw', 'derived'] }]);
    expect(encoded).toContain('raw');
    expect(encoded).toContain('derived');
    expect(encoded).toContain('|');
  });

  it('skips filters with no values', () => {
    const encoded = encodeExtraFilters([
      { column: 'genotype', values: [] },
      { column: 'data_level', values: ['raw'] },
    ]);
    expect(encoded).not.toContain('genotype');
    expect(encoded).toContain('data_level');
  });

  it('round-trips through getInitialExtraFiltersFromUrl', () => {
    const filters = [
      { column: 'data_level', values: ['raw', 'derived'] },
      { column: 'genotype', values: ['wt'] },
    ];
    const encoded = encodeExtraFilters(filters);
    const search = `?extraFilters=${encoded}`;
    expect(getInitialExtraFiltersFromUrl(search)).toEqual(filters);
  });
});

// ---------------------------------------------------------------------------
// buildSettingsUrl
// ---------------------------------------------------------------------------

describe('buildSettingsUrl', () => {
  it('returns empty string when everything is empty', () => {
    expect(buildSettingsUrl([], [], [])).toBe('');
  });

  it('includes the projects param when projects are set', () => {
    const url = buildSettingsUrl(['proj-a'], [], []);
    expect(url).toContain('projects=proj-a');
  });

  it('comma-joins multiple projects', () => {
    const url = buildSettingsUrl(['foo', 'bar'], [], []);
    expect(url).toContain('projects=foo');
    expect(url).toContain('bar');
  });

  it('includes the dataTypes param when types are enabled', () => {
    const url = buildSettingsUrl([], ['quality_control', 'fiber'], []);
    expect(url).toContain('dataTypes=quality_control');
  });

  it('includes the extraFilters param when filters are set', () => {
    const url = buildSettingsUrl([], [], [{ column: 'genotype', values: ['wt'] }]);
    expect(url).toContain('extraFilters=');
    expect(url).toContain('genotype');
  });

  it('removes projects param when projects array is empty', () => {
    const url = buildSettingsUrl([], ['qc'], [], '?projects=old&dataTypes=old');
    expect(url).not.toContain('projects=');
    expect(url).toContain('dataTypes=qc');
  });

  it('removes dataTypes param when types array is empty', () => {
    const url = buildSettingsUrl(['proj'], [], [], '?projects=old&dataTypes=qc');
    expect(url).toContain('projects=proj');
    expect(url).not.toContain('dataTypes=');
  });

  it('removes extraFilters param when filters array is empty', () => {
    const url = buildSettingsUrl(['p'], [], [], '?extraFilters=genotype%3Awt');
    expect(url).not.toContain('extraFilters=');
  });

  it('preserves unrelated existing params from baseSearch', () => {
    const url = buildSettingsUrl(['proj'], ['qc'], [], '?other=value');
    expect(url).toContain('other=value');
    expect(url).toContain('projects=proj');
  });

  it('round-trips projects through getInitialProjectsFromUrl', () => {
    const url = buildSettingsUrl(['round-trip', 'test'], [], []);
    expect(getInitialProjectsFromUrl(url)).toEqual(['round-trip', 'test']);
  });

  it('round-trips dataTypes through getInitialDataTypesFromUrl', () => {
    const url = buildSettingsUrl([], ['quality_control', 'fp'], []);
    expect(getInitialDataTypesFromUrl(url)).toEqual(['quality_control', 'fp']);
  });

  it('round-trips extraFilters through getInitialExtraFiltersFromUrl', () => {
    const filters = [{ column: 'data_level', values: ['raw'] }];
    const url = buildSettingsUrl([], [], filters);
    expect(getInitialExtraFiltersFromUrl(url)).toEqual(filters);
  });
});

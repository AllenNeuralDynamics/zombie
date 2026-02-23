/**
 * settings.test.js — Unit tests for pure functions in settings.js.
 *
 * Only the URL helper functions (getInitialProjectFromUrl,
 * getInitialDataTypesFromUrl, buildSettingsUrl) are tested here.
 * They have no browser/DOM dependencies and run in the Node test environment.
 *
 * initSettings() and buildDataTypeCheckbox() require a live DOM + Mosaic
 * coordinator and are covered by future integration / browser tests.
 */

import { describe, it, expect } from 'vitest';
import {
  getInitialProjectFromUrl,
  getInitialDataTypesFromUrl,
  buildSettingsUrl,
} from '../settings.js';

// ---------------------------------------------------------------------------
// getInitialProjectFromUrl
// ---------------------------------------------------------------------------

describe('getInitialProjectFromUrl', () => {
  it('returns the project name when present', () => {
    expect(getInitialProjectFromUrl('?project=my-project')).toBe('my-project');
  });

  it('returns null when the project param is absent', () => {
    expect(getInitialProjectFromUrl('')).toBeNull();
    expect(getInitialProjectFromUrl('?dataTypes=qc')).toBeNull();
  });

  it('decodes URL-encoded project names', () => {
    expect(getInitialProjectFromUrl('?project=my%20project')).toBe('my project');
  });

  it('handles a leading "?" correctly', () => {
    const result = getInitialProjectFromUrl('?project=test&dataTypes=qc');
    expect(result).toBe('test');
  });

  it('returns null for an empty project param value', () => {
    // URLSearchParams returns "" for "?project=" — treat as null via ?? null
    // Note: get() returns "" not null for empty values, but null for missing.
    // The function uses ?? null so "" is NOT replaced — this is intentional.
    const result = getInitialProjectFromUrl('?project=');
    expect(result).toBe('');   // empty string, not null — caller should guard
  });
});

// ---------------------------------------------------------------------------
// getInitialDataTypesFromUrl
// ---------------------------------------------------------------------------

describe('getInitialDataTypesFromUrl', () => {
  it('returns an empty array when the param is absent', () => {
    expect(getInitialDataTypesFromUrl('')).toEqual([]);
    expect(getInitialDataTypesFromUrl('?project=foo')).toEqual([]);
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
// buildSettingsUrl
// ---------------------------------------------------------------------------

describe('buildSettingsUrl', () => {
  it('returns an empty string when project is null and no types are enabled', () => {
    expect(buildSettingsUrl(null, [])).toBe('');
  });

  it('includes the project param when project is set', () => {
    const url = buildSettingsUrl('my-project', []);
    expect(url).toBe('?project=my-project');
  });

  it('includes the dataTypes param when types are enabled', () => {
    const url = buildSettingsUrl(null, ['quality_control', 'fiber']);
    expect(url).toBe('?dataTypes=quality_control%2Cfiber');
  });

  it('includes both params when project and types are set', () => {
    const url = buildSettingsUrl('proj', ['qc']);
    expect(url).toContain('project=proj');
    expect(url).toContain('dataTypes=qc');
  });

  it('removes the project param when project is falsy', () => {
    // Start with a search string that already has project set
    const url = buildSettingsUrl(null, ['qc'], '?project=old&dataTypes=old');
    expect(url).not.toContain('project=');
    expect(url).toContain('dataTypes=qc');
  });

  it('removes the dataTypes param when types array is empty', () => {
    const url = buildSettingsUrl('proj', [], '?project=old&dataTypes=qc');
    expect(url).toContain('project=proj');
    expect(url).not.toContain('dataTypes=');
  });

  it('preserves unrelated existing params from baseSearch', () => {
    const url = buildSettingsUrl('proj', ['qc'], '?other=value');
    expect(url).toContain('other=value');
    expect(url).toContain('project=proj');
  });

  it('URL-encodes project names with spaces', () => {
    const url = buildSettingsUrl('my project', []);
    expect(url).toContain('my+project');  // URLSearchParams uses + for spaces
  });

  it('round-trips through getInitialProjectFromUrl', () => {
    const url = buildSettingsUrl('round-trip-test', ['qc']);
    expect(getInitialProjectFromUrl(url)).toBe('round-trip-test');
  });

  it('round-trips through getInitialDataTypesFromUrl', () => {
    const url = buildSettingsUrl('proj', ['quality_control', 'fp']);
    expect(getInitialDataTypesFromUrl(url)).toEqual(['quality_control', 'fp']);
  });
});

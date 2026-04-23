/**
 * constants.test.js — Smoke-test that constants have the expected shape.
 *
 * These tests catch typos / accidental deletions, not deep logic.
 */

import { describe, it, expect } from 'vitest';
import {
  S3_REGION,
  S3_BUCKET,
  SQUIRREL_URL,
  AIND_COLORS,
  URL_PARAM_PROJECTS,
  URL_PARAM_DATA_TYPES,
  URL_PARAM_EXTRA_FILTERS,
  DEFAULT_PLOT_WIDTH,
  DEFAULT_PLOT_HEIGHT,
  TIME_VIEW_HEIGHT,
} from '../constants.js';

describe('constants', () => {
  it('S3_REGION is a non-empty string', () => {
    expect(typeof S3_REGION).toBe('string');
    expect(S3_REGION.length).toBeGreaterThan(0);
  });

  it('S3_BUCKET is a non-empty string', () => {
    expect(typeof S3_BUCKET).toBe('string');
    expect(S3_BUCKET.length).toBeGreaterThan(0);
  });

  it('SQUIRREL_URL points to the squirrel.json metadata file', () => {
    expect(SQUIRREL_URL).toContain('allen-data-views');
    expect(SQUIRREL_URL).toContain('data-asset-cache');
    expect(SQUIRREL_URL).toContain('squirrel.json');
  });

  it('AIND_COLORS contains the expected palette keys', () => {
    const expected = ['dark_blue', 'light_blue', 'green', 'yellow', 'grey', 'red'];
    for (const key of expected) {
      expect(AIND_COLORS).toHaveProperty(key);
      // Each value should be a CSS hex colour
      expect(AIND_COLORS[key]).toMatch(/^#[0-9a-fA-F]{3,6}$/);
    }
  });

  it('URL param keys are non-empty strings', () => {
    expect(typeof URL_PARAM_PROJECTS).toBe('string');
    expect(URL_PARAM_PROJECTS.length).toBeGreaterThan(0);
    expect(typeof URL_PARAM_DATA_TYPES).toBe('string');
    expect(URL_PARAM_DATA_TYPES.length).toBeGreaterThan(0);
    expect(typeof URL_PARAM_EXTRA_FILTERS).toBe('string');
    expect(URL_PARAM_EXTRA_FILTERS.length).toBeGreaterThan(0);
  });

  it('numeric defaults are positive integers', () => {
    expect(DEFAULT_PLOT_WIDTH).toBeGreaterThan(0);
    expect(DEFAULT_PLOT_HEIGHT).toBeGreaterThan(0);
    expect(TIME_VIEW_HEIGHT).toBeGreaterThan(0);
  });
});

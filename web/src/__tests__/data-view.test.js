/**
 * data-view.test.js — Unit tests for pure helpers in data-view.js.
 *
 * Only pure helpers are tested here; createDataView() requires a live
 * coordinator + DOM and is out of scope for unit testing.
 */

import { describe, it, expect } from 'vitest';
import { getInitialColumns, buildDotMarkOptions, isTemporalType, isObjectType, isNumericType } from '../data-view.js';
import { AIND_COLORS } from '../constants.js';

// ---------------------------------------------------------------------------
// isTemporalType
// ---------------------------------------------------------------------------

describe('isTemporalType', () => {
  it('returns true for TIMESTAMP', () => expect(isTemporalType('TIMESTAMP')).toBe(true));
  it('returns true for TIMESTAMPTZ', () => expect(isTemporalType('TIMESTAMPTZ')).toBe(true));
  it('returns true for TIMESTAMP WITH TIME ZONE', () => expect(isTemporalType('TIMESTAMP WITH TIME ZONE')).toBe(true));
  it('returns true for DATE', () => expect(isTemporalType('DATE')).toBe(true));
  it('returns true for TIMESTAMP_MS', () => expect(isTemporalType('TIMESTAMP_MS')).toBe(true));
  it('is case-insensitive', () => expect(isTemporalType('timestamp')).toBe(true));
  it('returns false for VARCHAR', () => expect(isTemporalType('VARCHAR')).toBe(false));
  it('returns false for BIGINT', () => expect(isTemporalType('BIGINT')).toBe(false));
  it('returns false for null', () => expect(isTemporalType(null)).toBe(false));
  it('returns false for undefined', () => expect(isTemporalType(undefined)).toBe(false));
});

// ---------------------------------------------------------------------------
// isObjectType
// ---------------------------------------------------------------------------

describe('isObjectType', () => {
  it('returns true for JSON', () => expect(isObjectType('JSON')).toBe(true));
  it('returns true for STRUCT(...)', () => expect(isObjectType('STRUCT(x INT, y INT)')).toBe(true));
  it('returns true for MAP(VARCHAR, INT)', () => expect(isObjectType('MAP(VARCHAR, INT)')).toBe(true));
  it('returns true for ARRAY(INT)', () => expect(isObjectType('ARRAY(INT)')).toBe(true));
  it('returns true for LIST', () => expect(isObjectType('LIST')).toBe(true));
  it('returns true for UNION(...)', () => expect(isObjectType('UNION(a INT, b VARCHAR)')).toBe(true));
  it('is case-insensitive', () => expect(isObjectType('struct(x INT)')).toBe(true));
  it('returns false for VARCHAR', () => expect(isObjectType('VARCHAR')).toBe(false));
  it('returns false for DOUBLE', () => expect(isObjectType('DOUBLE')).toBe(false));
  it('returns false for TIMESTAMP', () => expect(isObjectType('TIMESTAMP')).toBe(false));
  it('returns false for null', () => expect(isObjectType(null)).toBe(false));
  it('returns false for undefined', () => expect(isObjectType(undefined)).toBe(false));
});

// ---------------------------------------------------------------------------
// getInitialColumns
// ---------------------------------------------------------------------------

describe('getInitialColumns', () => {
  it('returns nulls for an empty array', () => {
    expect(getInitialColumns([])).toEqual({ x: null, y: null, by: null });
  });

  it('uses first column for x, second for y', () => {
    const result = getInitialColumns(['ts', 'value', 'modality']);
    expect(result.x).toBe('ts');
    expect(result.y).toBe('value');
  });

  it('falls back to first column for y when only one column exists', () => {
    const result = getInitialColumns(['ts']);
    expect(result.x).toBe('ts');
    expect(result.y).toBe('ts');
  });

  it('always sets by to null', () => {
    expect(getInitialColumns(['a', 'b', 'c']).by).toBeNull();
  });

  it('handles a non-array gracefully', () => {
    expect(getInitialColumns(null)).toEqual({ x: null, y: null, by: null });
  });
});

// ---------------------------------------------------------------------------
// buildDotMarkOptions
// ---------------------------------------------------------------------------

describe('buildDotMarkOptions', () => {
  it('passes xCol and yCol through to x and y', () => {
    const opts = buildDotMarkOptions('ts', 'val', null);
    expect(opts.x).toBe('ts');
    expect(opts.y).toBe('val');
  });

  it('uses static fill colour when byCol is null', () => {
    const opts = buildDotMarkOptions('ts', 'val', null);
    expect(opts.fill).toBe(AIND_COLORS.light_blue);
  });

  it('uses custom fallback fill colour', () => {
    const opts = buildDotMarkOptions('ts', 'val', null, [], null, '#ff0000');
    expect(opts.fill).toBe('#ff0000');
  });

  it('uses byCol string as fill channel when provided', () => {
    const opts = buildDotMarkOptions('ts', 'val', 'modality');
    expect(opts.fill).toBe('modality');
  });

  it('sets a sensible default radius and opacity', () => {
    const opts = buildDotMarkOptions('ts', 'val', null);
    expect(opts.r).toBeGreaterThan(0);
    expect(opts.fillOpacity).toBeGreaterThan(0);
    expect(opts.fillOpacity).toBeLessThanOrEqual(1);
  });

  it('does not set tip or channels when tooltipCols is empty', () => {
    const opts = buildDotMarkOptions('ts', 'val', null, []);
    expect(opts.tip).toBeUndefined();
    expect(opts.channels).toBeUndefined();
  });

  it('sets tip:true and channels when tooltipCols are provided', () => {
    const opts = buildDotMarkOptions('ts', 'val', null, ['asset_name', 'stage']);
    expect(opts.tip).toBe(true);
    expect(opts.channels).toEqual({ asset_name: 'asset_name', stage: 'stage' });
  });
});

// ---------------------------------------------------------------------------
// isNumericType
// ---------------------------------------------------------------------------

describe('isNumericType', () => {
  it('returns true for INTEGER', () => expect(isNumericType('INTEGER')).toBe(true));
  it('returns true for BIGINT', () => expect(isNumericType('BIGINT')).toBe(true));
  it('returns true for DOUBLE', () => expect(isNumericType('DOUBLE')).toBe(true));
  it('returns true for FLOAT', () => expect(isNumericType('FLOAT')).toBe(true));
  it('returns true for DECIMAL(10,2)', () => expect(isNumericType('DECIMAL(10,2)')).toBe(true));
  it('returns true for NUMERIC(5,3)', () => expect(isNumericType('NUMERIC(5,3)')).toBe(true));
  it('returns true for lowercase double', () => expect(isNumericType('double')).toBe(true));
  it('returns false for VARCHAR', () => expect(isNumericType('VARCHAR')).toBe(false));
  it('returns false for TIMESTAMP', () => expect(isNumericType('TIMESTAMP')).toBe(false));
  it('returns false for BOOLEAN', () => expect(isNumericType('BOOLEAN')).toBe(false));
  it('returns false for null', () => expect(isNumericType(null)).toBe(false));
  it('returns false for undefined', () => expect(isNumericType(undefined)).toBe(false));
});


import { describe, it, expect } from 'vitest';
import { buildFilterCondition, buildInstrumentExclusion } from '../lib/platform-overview/helpers.js';

describe('buildInstrumentExclusion', () => {
  it('is empty without excluded instruments', () => {
    expect(buildInstrumentExclusion(null)).toBe('');
    expect(buildInstrumentExclusion({ type: 'modality', value: 'fib' })).toBe('');
    expect(buildInstrumentExclusion({ excludeInstrumentIds: [] }, { nameCol: 'asset_name' })).toBe('');
  });

  it('filters asset_basics instrument_id directly, keeping null instruments', () => {
    expect(buildInstrumentExclusion({ excludeInstrumentIds: ['HSFP-1', "o'brien"] }))
      .toBe(" AND (instrument_id IS NULL OR instrument_id NOT IN ('HSFP-1', 'o''brien'))");
  });

  it('matches a name column against asset_basics, skipping null names', () => {
    expect(buildInstrumentExclusion({ excludeInstrumentIds: ['HSFP-1'] }, { nameCol: 'asset_name' }))
      .toBe(" AND asset_name NOT IN (SELECT name FROM asset_basics WHERE name IS NOT NULL AND instrument_id IN ('HSFP-1'))");
  });
});

describe('buildFilterCondition', () => {
  it('is unchanged for filters without exclusions', () => {
    expect(buildFilterCondition({ type: 'modality', value: 'fib' })).toBe("list_contains(modalities, 'fib')");
    expect(buildFilterCondition(null)).toBe('1=1');
  });

  it('appends the instrument exclusion', () => {
    expect(buildFilterCondition({ type: 'modality', value: 'fib', excludeInstrumentIds: ['HSFP'] }))
      .toBe("list_contains(modalities, 'fib') AND (instrument_id IS NULL OR instrument_id NOT IN ('HSFP'))");
  });
});

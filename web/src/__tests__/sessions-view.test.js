/**
 * sessions-view.test.js — Unit tests for pure helpers in sessions/view.js.
 */

import { describe, it, expect } from 'vitest';
import { normalizeInstrumentId, normalizeInstrumentIdSql, INSTRUMENT_ID_REGEX } from '../lib/utils.js';

describe('normalizeInstrumentId', () => {
  it('returns a bare ID unchanged (no spacers to strip)', () => {
    expect(normalizeInstrumentId('MESO.0')).toBe('MESO.0');
    expect(normalizeInstrumentId('BEH.1')).toBe('BEH.1');
  });

  it('extracts name from <location>_<name>_<YYYYMMDD>', () => {
    expect(normalizeInstrumentId('323_MESO.0_20241219')).toBe('MESO.0');
    expect(normalizeInstrumentId('440_BEH.2_20230601')).toBe('BEH.2');
  });

  it('extracts name from <location>_<name>_<YYYY-MM-DD>', () => {
    expect(normalizeInstrumentId('323_MESO.0_2024-12-19')).toBe('MESO.0');
  });

  it('extracts name from <location>-<name>_<YYYYMMDD>', () => {
    expect(normalizeInstrumentId('323-MESO.0_20241219')).toBe('MESO.0');
  });

  it('extracts name and strips spacers from multi-part names', () => {
    expect(normalizeInstrumentId('323-MESO.0_extra_20241219')).toBe('MESO.0extra');
    expect(normalizeInstrumentId('446_7C_DIG_20260527')).toBe('7CDIG');
  });

  it('handles null and empty string', () => {
    expect(normalizeInstrumentId(null)).toBe('');
    expect(normalizeInstrumentId('')).toBe('');
  });

  it('extracts name from <location>_<name>_<YYMMDD> (short year 23-26)', () => {
    expect(normalizeInstrumentId('323_MESO.0_241219')).toBe('MESO.0');
    expect(normalizeInstrumentId('440_BEH.2_230601')).toBe('BEH.2');
    expect(normalizeInstrumentId('440_BEH.2_260101')).toBe('BEH.2');
  });

  it('does not match short-year dates outside 23-26, strips spacers from raw ID', () => {
    expect(normalizeInstrumentId('323_MESO.0_221219')).toBe('323MESO.0221219');
    expect(normalizeInstrumentId('323_MESO.0_270101')).toBe('323MESO.0270101');
  });

  it('strips spacers from IDs with no recognised date suffix', () => {
    expect(normalizeInstrumentId('323_MESO.0_notadate')).toBe('323MESO.0notadate');
  });

  it('strips spacer characters from the extracted name', () => {
    expect(normalizeInstrumentId('446_7C_20260527')).toBe('7C');
    expect(normalizeInstrumentId('446_7-C_20260527')).toBe('7C');
  });
});

describe('normalizeInstrumentIdSql', () => {
  it('returns a non-empty SQL string', () => {
    const sql = normalizeInstrumentIdSql('instrument_id');
    expect(typeof sql).toBe('string');
    expect(sql.length).toBeGreaterThan(0);
  });

  it('embeds the same regex as INSTRUMENT_ID_REGEX', () => {
    const sql = normalizeInstrumentIdSql('instrument_id');
    expect(sql).toContain(INSTRUMENT_ID_REGEX);
  });

  it('references the provided column name', () => {
    expect(normalizeInstrumentIdSql('instrument_id')).toContain('instrument_id');
    expect(normalizeInstrumentIdSql('rig_col')).toContain('rig_col');
  });

  it('includes spacer-stripping regexp_replace', () => {
    const sql = normalizeInstrumentIdSql('instrument_id');
    expect(sql).toContain("'[_-]'");
  });
});

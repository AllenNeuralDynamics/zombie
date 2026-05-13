/**
 * sessions-view.test.js — Unit tests for pure helpers in sessions/view.js.
 */

import { describe, it, expect } from 'vitest';
import { normalizeInstrumentId } from '../sessions/view.js';

describe('normalizeInstrumentId', () => {
  it('returns a bare ID unchanged', () => {
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

  it('extracts name from <location>-<name>_<morename>_<YYYYMMDD>', () => {
    expect(normalizeInstrumentId('323-MESO.0_extra_20241219')).toBe('MESO.0_extra');
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

  it('does not match short-year dates outside 23-26', () => {
    expect(normalizeInstrumentId('323_MESO.0_221219')).toBe('323_MESO.0_221219');
    expect(normalizeInstrumentId('323_MESO.0_270101')).toBe('323_MESO.0_270101');
  });

  it('does not mangle IDs with no date suffix', () => {
    expect(normalizeInstrumentId('323_MESO.0_notadate')).toBe('323_MESO.0_notadate');
  });
});

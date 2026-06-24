/**
 * log-server.test.js — Unit tests for the eng-logtools client helpers.
 */
import { describe, it, expect } from 'vitest';
import {
  quarterDateRange,
  pickTableForRange,
  parseLogTimestamp,
  logRowToSession,
  learnInstrumentMap,
  mergeLogSessions,
  normalizeLogInstrument,
} from '../lib/log-server.js';

describe('quarterDateRange', () => {
  it('returns Jan-Apr range for Q1', () => {
    expect(quarterDateRange('2025-Q1')).toEqual({ startDate: '2025-01-01', endDate: '2025-04-01' });
  });
  it('returns Oct-Jan(next year) for Q4', () => {
    expect(quarterDateRange('2025-Q4')).toEqual({ startDate: '2025-10-01', endDate: '2026-01-01' });
  });
  it('returns null for invalid input', () => {
    expect(quarterDateRange('')).toBeNull();
    expect(quarterDateRange('2025-Q9')).toBeNull();
    expect(quarterDateRange(null)).toBeNull();
  });
});

describe('pickTableForRange', () => {
  it('uses last_2week for recent start', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(pickTableForRange(today, today)).toBe('last_2week');
  });
  it('uses log_server for very old data', () => {
    expect(pickTableForRange('2020-01-01', '2020-04-01')).toBe('log_server');
  });
});

describe('parseLogTimestamp', () => {
  it('parses MySQL-style datetime as UTC', () => {
    const iso = parseLogTimestamp('2026-06-24 09:04:35.537751');
    expect(iso).toBe('2026-06-24T09:04:35.537Z');
  });
  it('returns null for empty', () => {
    expect(parseLogTimestamp(null)).toBeNull();
    expect(parseLogTimestamp('')).toBeNull();
  });
});

describe('normalizeLogInstrument', () => {
  it('returns raw when no learned map', () => {
    expect(normalizeLogInstrument('MESO.1')).toBe('MESO.1');
  });
  it('uses learned map when provided', () => {
    expect(normalizeLogInstrument('MESO.1', { 'MESO.1': '440_MESO.1' })).toBe('440_MESO.1');
  });
  it('returns empty string for falsy input', () => {
    expect(normalizeLogInstrument('')).toBe('');
    expect(normalizeLogInstrument(null)).toBe('');
  });
});

describe('logRowToSession', () => {
  const sample = {
    datetime: '2026-06-24T17:25:30',
    client_address: 'BEH.D-Box1 / W10DTMJ0JCMZ8',
    instrument_id: 'BEH.D-Box1',
    version: '1.2.3',
    fields: {
      MID: '853120',
      UID: 'robyn.naidoo',
      Action: 'Completed',
      Resource_ID: 'TRAINING_6_psycode_passive_5uL_reward',
      Duration_min: '60.0',
      Return_code: '0',
      Long_frames: '0',
    },
  };

  it('extracts subject, end time, start time (end minus Duration_min)', () => {
    const row = logRowToSession(sample);
    expect(row.source).toBe('log');
    expect(row.subject_id).toBe('853120');
    expect(row.acquisition_end_time).toBe('2026-06-24T17:25:30.000Z');
    expect(row.acquisition_start_time).toBe('2026-06-24T16:25:30.000Z');
    expect(row.experimenters).toEqual(['robyn.naidoo']);
    expect(row.instrument_id).toBe('BEH.D-Box1');
    expect(row.modalities).toContain('behavior');
    expect(row.log_resource_id).toBe('TRAINING_6_psycode_passive_5uL_reward');
    expect(row.log_duration_min).toBe(60);
    expect(row.log_return_code).toBe('0');
  });

  it('falls back to end time when Duration_min missing', () => {
    const row = logRowToSession({
      datetime: '2026-01-01T00:00:00',
      fields: { MID: '1', UID: 'x', Action: 'Completed' },
    });
    expect(row.acquisition_end_time).toBe('2026-01-01T00:00:00.000Z');
    expect(row.acquisition_start_time).toBe('2026-01-01T00:00:00.000Z');
    expect(row.log_duration_min).toBeNull();
  });

  it('applies instrumentMap', () => {
    const row = logRowToSession(sample, { instrumentMap: { 'BEH.D-Box1': 'Behavior-D-Box1' } });
    expect(row.instrument_id).toBe('Behavior-D-Box1');
  });

  it('handles missing fields', () => {
    const row = logRowToSession({ datetime: '2026-01-01T00:00:00', fields: {} });
    expect(row.subject_id).toBeNull();
    expect(row.experimenters).toEqual([]);
    expect(row.log_resource_id).toBe('');
  });
});

describe('learnInstrumentMap', () => {
  it('maps log prefix to most common matching existing instrument_id', () => {
    const existing = [
      { instrument_id: 'Behavior-D-Box1' },
      { instrument_id: 'Behavior-D-Box1' },
      { instrument_id: 'NeuropixelsRig-1' },
      { instrument_id: 'something-else' },
    ];
    const logs = [{ instrument_id: 'BEH.D-Box1' }, { instrument_id: 'NP.1-Stim' }];
    const map = learnInstrumentMap(existing, logs);
    expect(map['BEH.D-Box1']).toBeUndefined();
    expect(map).toEqual({});
  });
  it('matches when token overlaps case-insensitively', () => {
    const existing = [{ instrument_id: 'meso.2-rig' }];
    const logs = [{ instrument_id: 'MESO.2' }];
    expect(learnInstrumentMap(existing, logs)).toEqual({ 'MESO.2': 'meso.2-rig' });
  });
  it('omits prefix when no match', () => {
    expect(learnInstrumentMap([{ instrument_id: 'foo' }], [{ instrument_id: 'MESO.1' }])).toEqual({});
  });
});

describe('mergeLogSessions', () => {
  const existing = [
    {
      subject_id: '845939',
      acquisition_start_time: '2026-06-24T09:00:00Z',
      name: 'multiplane-ophys_1782314737_2026-06-24_09-04-35',
    },
    {
      subject_id: '111111',
      acquisition_start_time: '2026-06-20T10:00:00Z',
      name: 'other_asset_111111',
    },
  ];

  it('matches by subject + same UTC day', () => {
    const logs = [
      logRowToSession({
        datetime: '2026-06-24T10:30:00',
        fields: { MID: '845939', UID: 'x', Action: 'Completed', Duration_min: '60' },
      }),
    ];
    const out = mergeLogSessions(existing, logs);
    expect(out.matchedCount).toBe(1);
    expect(out.added).toEqual([]);
  });

  it('matches even when log start crosses midnight after subtracting duration', () => {
    const logs = [
      logRowToSession({
        datetime: '2026-06-20T23:30:00',
        fields: { MID: '111111', UID: 'x', Action: 'Completed', Duration_min: '30' },
      }),
    ];
    const out = mergeLogSessions(existing, logs);
    expect(out.matchedCount).toBe(1);
  });

  it('adds rows that do not match an existing subject/day', () => {
    const logs = [
      logRowToSession({
        datetime: '2026-06-22T08:00:00',
        fields: { MID: '222222', UID: 'y', Action: 'Completed', Duration_min: '15' },
      }),
    ];
    const out = mergeLogSessions(existing, logs);
    expect(out.matchedCount).toBe(0);
    expect(out.added.length).toBe(1);
    expect(out.added[0].subject_id).toBe('222222');
    expect(out.merged.length).toBe(existing.length + 1);
  });
});

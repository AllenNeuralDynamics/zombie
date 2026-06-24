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
    client_address: 'MESO.2-Acq / DT901154',
    instrument_id: 'MESO.2',
    version: '0.3.6.dev0',
    fields: {
      Action: 'Acquisition Report Generated',
      'Report Status': 'Success -',
      OphysSessionID: '1782314737',
      UID: 'Sam Seid',
      MID: '845939',
      Date_timestamp: '2026-06-24 09:04:35.537751',
      Stimulus: 'TRAINING_3_images_G_7ul_reward',
    },
  };

  it('extracts subject, session, time, experimenter', () => {
    const row = logRowToSession(sample);
    expect(row.source).toBe('log');
    expect(row.subject_id).toBe('845939');
    expect(row.log_session_id).toBe('1782314737');
    expect(row.acquisition_start_time).toBe('2026-06-24T09:04:35.537Z');
    expect(row.experimenters).toEqual(['Sam Seid']);
    expect(row.instrument_id).toBe('MESO.2');
    expect(row.modalities).toContain('behavior');
    expect(row.log_stimulus).toBe('TRAINING_3_images_G_7ul_reward');
  });

  it('applies instrumentMap', () => {
    const row = logRowToSession(sample, { instrumentMap: { 'MESO.2': '442_MESO.2' } });
    expect(row.instrument_id).toBe('442_MESO.2');
  });

  it('handles missing fields', () => {
    const row = logRowToSession({ datetime: '2026-01-01T00:00:00', fields: {} });
    expect(row.subject_id).toBeNull();
    expect(row.log_session_id).toBeNull();
    expect(row.experimenters).toEqual([]);
  });
});

describe('learnInstrumentMap', () => {
  it('maps log prefix to most common matching existing instrument_id', () => {
    const existing = [
      { instrument_id: '440_MESO.1' },
      { instrument_id: '440_MESO.1' },
      { instrument_id: '442_MESO.2' },
      { instrument_id: 'something-else' },
    ];
    const logs = [{ instrument_id: 'MESO.1' }, { instrument_id: 'MESO.2' }];
    expect(learnInstrumentMap(existing, logs)).toEqual({
      'MESO.1': '440_MESO.1',
      'MESO.2': '442_MESO.2',
    });
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

  it('matches by session id embedded in asset name', () => {
    const logs = [
      logRowToSession({
        fields: {
          MID: '845939',
          OphysSessionID: '1782314737',
          Date_timestamp: '2026-06-24 09:04:35',
        },
      }),
    ];
    const out = mergeLogSessions(existing, logs);
    expect(out.matchedCount).toBe(1);
    expect(out.added).toEqual([]);
  });

  it('matches by subject + same UTC day even without session id', () => {
    const logs = [
      logRowToSession({
        fields: { MID: '111111', Date_timestamp: '2026-06-20 23:30:00' },
      }),
    ];
    const out = mergeLogSessions(existing, logs);
    expect(out.matchedCount).toBe(1);
    expect(out.added.length).toBe(0);
  });

  it('adds rows that do not match', () => {
    const logs = [
      logRowToSession({
        fields: { MID: '222222', OphysSessionID: '9999', Date_timestamp: '2026-06-22 08:00:00' },
      }),
    ];
    const out = mergeLogSessions(existing, logs);
    expect(out.matchedCount).toBe(0);
    expect(out.added.length).toBe(1);
    expect(out.added[0].subject_id).toBe('222222');
    expect(out.merged.length).toBe(existing.length + 1);
  });
});

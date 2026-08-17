import { describe, it, expect } from 'vitest';
import {
  assetStatus,
  buildAssetTimeline,
  countByStatus,
  formatDuration,
  median,
  percentile,
  portalVisibleAt,
  relativeSegments,
  summarizeStages,
} from '../timeline/timeline-model.js';

/**
 * Explicit UTC epoch ms — never interpreted through the test runner's own
 * timezone, so these tests pass identically wherever they run. Where a test
 * cares about the Pacific release rule, the expected values are computed by
 * hand against the known PDT (UTC-7, summer) / PST (UTC-8, winter) offset for
 * the chosen date rather than by re-deriving them from the function under
 * test.
 */
const utc = (y, m, d, h = 0, min = 0, s = 0) => Date.UTC(y, m - 1, d, h, min, s, 0);
const iso = (ms) => new Date(ms).toISOString();

describe('portalVisibleAt', () => {
  it('releases the same day when processing finishes before 06:00 Pacific (PDT, summer)', () => {
    // 2026-07-14 09:00Z = 2026-07-14 02:00 PDT (UTC-7) — well before 06:00, so
    // it waits only for *this* day's release, not the next one.
    const processed = utc(2026, 7, 14, 9, 0);
    const visible = portalVisibleAt(processed);
    expect(iso(visible)).toBe('2026-07-14T13:00:00.000Z');
    expect((visible - processed) / 36e5).toBeCloseTo(4, 5);
  });

  it('releases the next day when processing finishes at or after 06:00 Pacific (PDT, summer)', () => {
    // 2026-07-14 20:30Z = 2026-07-14 13:30 PDT — after 06:00, so it misses
    // today's release and waits for tomorrow's.
    const visible = portalVisibleAt(utc(2026, 7, 14, 20, 30));
    expect(iso(visible)).toBe('2026-07-15T13:00:00.000Z');
  });

  it('releases the next day when processing finishes at or after 06:00 Pacific (PST, winter)', () => {
    // 2026-01-14 20:00Z = 2026-01-14 12:00 PST (UTC-8) — after 06:00.
    const visible = portalVisibleAt(utc(2026, 1, 14, 20, 0));
    expect(iso(visible)).toBe('2026-01-15T14:00:00.000Z');
  });

  it('treats exactly 06:00:00 Pacific as already released — zero wait', () => {
    const processed = utc(2026, 7, 14, 13, 0, 0); // exactly 06:00:00 PDT
    expect(portalVisibleAt(processed)).toBe(processed);
  });

  it('caps the wait just under 24 hours — the longest possible gap', () => {
    // One second after 06:00 Pacific is the worst case: it just misses today's
    // release and must wait almost a full day for tomorrow's.
    const processed = utc(2026, 7, 14, 13, 0, 1); // 06:00:01 PDT
    const visible = portalVisibleAt(processed);
    const waitHours = (visible - processed) / 36e5;
    expect(waitHours).toBeGreaterThan(23.99);
    expect(waitHours).toBeLessThan(24);
  });

  it('is unaffected by the timezone the code happens to run in', () => {
    // A Pacific 13:30 instant expressed in UTC, regardless of the host
    // runtime's own local timezone (which Intl.DateTimeFormat with an
    // explicit `timeZone` option never consults).
    const visible = portalVisibleAt(utc(2026, 7, 14, 20, 30));
    expect(iso(visible)).toBe('2026-07-15T13:00:00.000Z');
  });

  it('rolls over a month boundary on the Pacific calendar', () => {
    // 2026-07-31 20:00Z = 2026-07-31 13:00 PDT (after 06:00).
    const visible = portalVisibleAt(utc(2026, 7, 31, 20, 0));
    expect(iso(visible)).toBe('2026-08-01T13:00:00.000Z');
  });

  it('rolls over a year boundary on the Pacific calendar', () => {
    // 2026-12-31 20:00Z = 2026-12-31 12:00 PST (after 06:00).
    const visible = portalVisibleAt(utc(2026, 12, 31, 20, 0));
    expect(iso(visible)).toBe('2027-01-01T14:00:00.000Z');
  });

  it('returns null when processing has not completed', () => {
    expect(portalVisibleAt(null)).toBeNull();
    expect(portalVisibleAt(undefined)).toBeNull();
    expect(portalVisibleAt(NaN)).toBeNull();
  });
});

describe('buildAssetTimeline', () => {
  // acqStart 07-10 10:00Z, acqEnd 11:00Z, uploaded 15:00Z, processed 07-11
  // 03:00Z (= 07-10 20:00 PDT) → releases 07-11 06:00 PDT = 07-11 13:00Z.
  const row = {
    name: 'FIP_123_2026-07-10_10-00-00',
    subject_id: '123',
    project_name: 'Proj',
    modalities: ['fib'],
    derived_name: 'FIP_123_processed',
    acq_start_ms: utc(2026, 7, 10, 10, 0),
    acq_end_ms: utc(2026, 7, 10, 11, 0),
    uploaded_ms: utc(2026, 7, 10, 15, 0),
    processed_ms: utc(2026, 7, 11, 3, 0),
  };

  it('emits one segment per stage with correct durations', () => {
    const t = buildAssetTimeline(row, { nowMs: utc(2026, 7, 20) });
    expect(t.segments.map((s) => s.stage)).toEqual([
      'acquisition', 'upload', 'processing', 'release',
    ]);
    const hours = Object.fromEntries(t.segments.map((s) => [s.stage, s.hours]));
    expect(hours.acquisition).toBeCloseTo(1, 5);
    expect(hours.upload).toBeCloseTo(4, 5);
    expect(hours.processing).toBeCloseTo(12, 5);
    // processed 07-11 03:00Z → visible 07-11 13:00Z (06:00 PDT) = 10 h
    expect(hours.release).toBeCloseTo(10, 5);
  });

  // From acquisition END, so the session's own length never counts as latency.
  it('spans acquisition end to portal visibility in totalHours', () => {
    const t = buildAssetTimeline(row, { nowMs: utc(2026, 7, 20) });
    expect(t.totalHours).toBeCloseTo(26, 5);
  });

  it('has no totalHours when the acquisition end time is missing', () => {
    const t = buildAssetTimeline({ ...row, acq_end_ms: null }, { nowMs: utc(2026, 7, 20) });
    expect(t.totalHours).toBeNull();
  });

  it('drops segments whose bounding milestone is missing', () => {
    const t = buildAssetTimeline(
      { ...row, uploaded_ms: null, processed_ms: null },
      { nowMs: utc(2026, 7, 20) },
    );
    expect(t.segments.map((s) => s.stage)).toEqual(['acquisition']);
    expect(t.totalHours).toBeNull();
    expect(t.milestones.visible).toBeNull();
  });

  it('drops backwards segments rather than rendering a negative bar', () => {
    // Upload stamped before the acquisition's own end time — clocks disagree
    // across systems, so the upload stage is simply not charted.
    const t = buildAssetTimeline(
      { ...row, uploaded_ms: utc(2026, 7, 10, 10, 30) },
      { nowMs: utc(2026, 7, 20) },
    );
    expect(t.segments.map((s) => s.stage)).not.toContain('upload');
    expect(t.milestones.uploaded).toBe(utc(2026, 7, 10, 10, 30));
  });

  it('defaults modalities to an array when absent', () => {
    const t = buildAssetTimeline({ ...row, modalities: null }, { nowMs: utc(2026, 7, 20) });
    expect(t.modalities).toEqual([]);
  });
});

describe('assetStatus', () => {
  const visible = utc(2026, 7, 12, 13, 0);

  it('reports uploading before an upload timestamp exists', () => {
    expect(assetStatus({ uploaded: null, processed: null, visible: null }, 0)).toBe('uploading');
  });

  it('reports processing once uploaded but not processed', () => {
    expect(assetStatus({ uploaded: 1, processed: null, visible: null }, 0)).toBe('processing');
  });

  it('reports pending-release until the release moment passes', () => {
    expect(assetStatus({ uploaded: 1, processed: 2, visible }, visible - 1))
      .toBe('pending-release');
  });

  it('reports visible at and after the release moment', () => {
    expect(assetStatus({ uploaded: 1, processed: 2, visible }, visible)).toBe('visible');
  });
});

describe('relativeSegments', () => {
  it('shifts acquisition start to hour zero', () => {
    const t = buildAssetTimeline({
      name: 'a',
      modalities: [],
      acq_start_ms: utc(2026, 7, 10, 10, 0),
      acq_end_ms: utc(2026, 7, 10, 12, 0),
      uploaded_ms: utc(2026, 7, 10, 13, 0),
      processed_ms: null,
    }, { nowMs: utc(2026, 7, 20) });
    const rel = relativeSegments(t);
    expect(rel[0].x1).toBe(0);
    expect(rel[0].x2).toBeCloseTo(2, 5);
    expect(rel[1].x1).toBeCloseTo(2, 5);
    expect(rel[1].x2).toBeCloseTo(3, 5);
  });

  it('returns nothing without an acquisition start', () => {
    const t = buildAssetTimeline({ name: 'a', modalities: [], acq_start_ms: null }, { nowMs: 0 });
    expect(relativeSegments(t)).toEqual([]);
  });
});

describe('median / percentile', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('takes the middle value for an odd count', () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it('ignores non-finite values and empty input', () => {
    expect(median([])).toBeNull();
    expect(median([NaN, 2, 4])).toBe(3);
  });

  it('uses nearest-rank for percentiles', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.9)).toBeNull();
  });
});

describe('summarizeStages', () => {
  it('summarizes only the stages that have segments', () => {
    const mk = (uploadHours) => buildAssetTimeline({
      name: `a${uploadHours}`,
      modalities: [],
      acq_start_ms: utc(2026, 7, 10, 0, 0),
      acq_end_ms: utc(2026, 7, 10, 1, 0),
      uploaded_ms: utc(2026, 7, 10, 1 + uploadHours, 0),
      processed_ms: null,
    }, { nowMs: utc(2026, 7, 20) });

    const summary = summarizeStages([mk(2), mk(4), mk(6)]);
    const byStage = Object.fromEntries(summary.map((s) => [s.stage, s]));
    expect(byStage.upload.n).toBe(3);
    expect(byStage.upload.medianHours).toBeCloseTo(4, 5);
    expect(byStage.processing.n).toBe(0);
    expect(byStage.processing.medianHours).toBeNull();
  });

  it('always returns all four stages in pipeline order', () => {
    expect(summarizeStages([]).map((s) => s.stage))
      .toEqual(['acquisition', 'upload', 'processing', 'release']);
  });
});

describe('countByStatus', () => {
  it('tallies each status', () => {
    const counts = countByStatus([
      { status: 'visible' }, { status: 'visible' }, { status: 'processing' },
    ]);
    expect(counts).toEqual({
      visible: 2, 'pending-release': 0, processing: 1, uploading: 0,
    });
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(0.5)).toBe('30 min');
    expect(formatDuration(4.25)).toBe('4.3 h');
    expect(formatDuration(72)).toBe('3.0 d');
  });

  it('handles sub-minute and missing values', () => {
    expect(formatDuration(0.001)).toBe('<1 min');
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(NaN)).toBe('—');
  });
});

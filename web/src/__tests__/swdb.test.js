/**
 * swdb.test.js — unit tests for the SWDB dashboard's pure logic: cache URL
 * construction, asset-name validation, set summarising, the Dynamic Routing
 * session adapter, and the eye/performance normalisers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { summariseSets, setInfo, datasetInfo } from '../swdb/sets.js';
import { buildLickResponses, buildEpochSpans } from '../swdb/dr-session.js';
import { cleanEyeRows, decimate } from '../swdb/eye-view.js';
import { normalisePerformance } from '../swdb/performance-view.js';

// The URL helpers read the resolved cache version from lib/metadata.js.
vi.mock('../lib/metadata.js', () => ({ getResolvedVersion: () => 'bdc-v0.39' }));

const {
  sessionsUrl,
  partitionUrl,
  subjectPartitionUrl,
  assertSubjectId,
  assertAssetName,
  SWDB_TABLES,
  listSwdbDatasets,
} = await import('../swdb/data.js');

const ASSET = 'ecephys_664851_2023-11-13_12-49-51_nwb_2026-07-24_13-29-15';

// ---------------------------------------------------------------------------
// Cache URLs + validation
// ---------------------------------------------------------------------------

describe('swdb cache urls', () => {
  it('builds the unpartitioned sessions url', () => {
    expect(sessionsUrl()).toBe(
      'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/bdc-v0.39/platform_swdb_sessions.pqt',
    );
  });

  it('builds a hive-partitioned url for one asset', () => {
    expect(partitionUrl(SWDB_TABLES.trials, ASSET)).toBe(
      'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/bdc-v0.39'
        + `/platform_swdb_trials/asset_name=${ASSET}/data.pqt`,
    );
  });

  it('accepts a well-formed asset name', () => {
    expect(assertAssetName(ASSET)).toBe(ASSET);
  });

  it('builds subject-partitioned Visual Learning urls', () => {
    expect(subjectPartitionUrl(SWDB_TABLES.visualLearningCellGene, '782149')).toBe(
      'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/bdc-v0.39'
        + '/platform_visual_learning_cell_gene/subject_id=782149/data.pqt',
    );
    expect(assertSubjectId('782149')).toBe('782149');
  });

  it.each(['782149/other', 'subject', '', null])('rejects unsafe subject id %s', (bad) => {
    expect(() => assertSubjectId(bad)).toThrow(/Invalid SWDB subject id/);
  });

  it.each([
    ["nope'; DROP TABLE x; --", 'sql quote'],
    ['../../etc/passwd', 'path traversal'],
    ['has space', 'whitespace'],
    ['', 'empty'],
    [null, 'null'],
  ])('rejects %s (%s)', (bad) => {
    // Asset names come from the query string and are interpolated into both a URL
    // and a SQL string, so anything unexpected must be refused outright.
    expect(() => assertAssetName(bad)).toThrow(/Invalid SWDB asset name/);
  });
});

// ---------------------------------------------------------------------------
// Set summaries
// ---------------------------------------------------------------------------

const sessionRow = (over = {}) => ({
  set_id: 'dynamic-routing',
  asset_name: 'a1',
  subject_id: '664851',
  session_date: '2023-11-13',
  session_duration_s: 3600,
  n_trials: 100,
  n_units: 1000,
  n_licks: 500,
  has_eye_tracking: true,
  has_units: true,
  has_optotagging: false,
  has_rf_mapping: true,
  ...over,
});

describe('summariseSets', () => {
  it('aggregates counts, subjects and date span per set', () => {
    const sets = summariseSets([
      sessionRow(),
      sessionRow({ asset_name: 'a2', subject_id: '667252', session_date: '2025-02-04', n_trials: 50 }),
      // same subject twice must count once
      sessionRow({ asset_name: 'a3', session_date: '2024-01-01', n_trials: 25 }),
    ]);

    expect(sets).toHaveLength(1);
    const set = sets[0];
    expect(set.setId).toBe('dynamic-routing');
    expect(set.title).toBe('Dynamic Routing');
    expect(set.nAssets).toBe(3);
    expect(set.nSubjects).toBe(2);
    expect(set.nTrials).toBe(175);
    expect(set.totalHours).toBeCloseTo(3);
    expect(set.firstDate).toBe('2023-11-13');
    expect(set.lastDate).toBe('2025-02-04');
  });

  it('reports a modality present when any asset has it', () => {
    const [set] = summariseSets([
      sessionRow({ has_optotagging: false }),
      sessionRow({ asset_name: 'a2', has_optotagging: true }),
    ]);
    expect(set.modalities.optotagging).toBe(true);
    expect(set.modalities.eye).toBe(true);
  });

  it('splits multiple sets', () => {
    const sets = summariseSets([sessionRow(), sessionRow({ set_id: 'other', asset_name: 'b1' })]);
    expect(sets.map((s) => s.setId)).toEqual(['dynamic-routing', 'other']);
  });

  it('falls back to the raw id for an unknown set', () => {
    // a cache that ships a new set before the frontend knows about it must render
    expect(setInfo('brand-new').title).toBe('brand-new');
    const [set] = summariseSets([sessionRow({ set_id: 'brand-new' })]);
    expect(set.title).toBe('brand-new');
  });
});

describe('published SWDB datasets', () => {
  it('discovers only SWDB dataset tables from the registry', () => {
    const datasets = listSwdbDatasets({
      acorns: [
        { name: 'asset_basics' },
        { name: 'swdb_2025_v1dd' },
        { name: 'swdb_2025_bci' },
      ],
    });
    expect(datasets.map((dataset) => dataset.name)).toEqual([
      'swdb_2025_bci',
      'swdb_2025_v1dd',
    ]);
  });

  it('provides display copy with a safe fallback', () => {
    expect(datasetInfo('swdb_2025_bci').title).toBe('Brain-Computer Interface');
    expect(datasetInfo('swdb_2025_new_set').title).toBe('new set');
  });
});

// ---------------------------------------------------------------------------
// DR session adapter helpers
// ---------------------------------------------------------------------------

describe('buildLickResponses', () => {
  const lick = (t, value) => ({ kind: 'lick', t, value });

  it('shifts licks onto the trial-relative clock', () => {
    const out = buildLickResponses([lick(110, 1), lick(120, 1)], 100, 100);
    expect([...out.t]).toEqual([10, 20]);
  });

  it('drops contact events that failed the is_likely_lick check', () => {
    const out = buildLickResponses([lick(110, 1), lick(115, 0), lick(120, 1)], 100, 100);
    expect([...out.t]).toEqual([10, 20]);
  });

  it('keeps every lick when the flag is absent', () => {
    const out = buildLickResponses(
      [{ kind: 'lick', t: 110 }, { kind: 'lick', t: 120 }],
      100,
      100,
    );
    expect([...out.t]).toEqual([10, 20]);
  });

  it('clamps licks outside the playable window', () => {
    // pre-task spontaneous-reward licks would otherwise land at negative times
    const out = buildLickResponses([lick(50, 1), lick(110, 1), lick(9999, 1)], 100, 100);
    expect([...out.t]).toEqual([10]);
  });

  it('returns sorted times', () => {
    const out = buildLickResponses([lick(130, 1), lick(110, 1), lick(120, 1)], 100, 100);
    expect([...out.t]).toEqual([10, 20, 30]);
  });

  it('handles an empty lick stream', () => {
    expect(buildLickResponses([], 0, 10).t.length).toBe(0);
  });
});

describe('buildEpochSpans', () => {
  it('shifts and sorts epochs, keeping negative starts', () => {
    // epochs before the first trial are meaningful context, not errors
    const spans = buildEpochSpans(
      [
        { kind: 'epoch', label: 'DynamicRouting1', t: 3117, t_stop: 6757 },
        { kind: 'epoch', label: 'RFMapping', t: 105, t_stop: 976 },
      ],
      3117,
    );
    expect(spans.map((s) => s.label)).toEqual(['RFMapping', 'DynamicRouting1']);
    expect(spans[0].start_t).toBe(105 - 3117);
    expect(spans[1].start_t).toBe(0);
  });

  it('falls back to a zero-length span when t_stop is missing', () => {
    const [span] = buildEpochSpans([{ kind: 'epoch', label: 'x', t: 10 }], 0);
    expect(span.stop_t).toBe(10);
  });

  it('labels unlabelled epochs', () => {
    const [span] = buildEpochSpans([{ kind: 'epoch', t: 0, t_stop: 1 }], 0);
    expect(span.label).toBe('epoch');
  });
});

// ---------------------------------------------------------------------------
// Eye tracking
// ---------------------------------------------------------------------------

describe('cleanEyeRows', () => {
  const frame = (over = {}) => ({
    timestamps: 100,
    pupil_area: 50,
    pupil_center_x: 12,
    pupil_center_y: 8,
    eye_center_x: 10,
    eye_center_y: 10,
    pupil_is_bad_frame: false,
    ...over,
  });

  it('computes gaze relative to the eye centre', () => {
    const [row] = cleanEyeRows([frame()], 0);
    expect(row.gaze_x).toBe(2);
    expect(row.gaze_y).toBe(-2);
  });

  it('shifts timestamps by t0', () => {
    expect(cleanEyeRows([frame()], 40)[0].t).toBe(60);
  });

  it('drops frames whose pupil fit failed', () => {
    expect(cleanEyeRows([frame({ pupil_is_bad_frame: true })], 0)).toHaveLength(0);
  });

  it('drops frames with a non-finite area or time', () => {
    expect(cleanEyeRows([frame({ pupil_area: null }), frame({ timestamps: NaN })], 0)).toHaveLength(0);
  });
});

describe('decimate', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ i }));

  it('returns the input untouched when already small enough', () => {
    const small = rows.slice(0, 10);
    expect(decimate(small, 100)).toBe(small);
  });

  it('thins to at most maxPoints', () => {
    expect(decimate(rows, 100).length).toBeLessThanOrEqual(100);
  });

  it('samples by stride rather than averaging', () => {
    // averaging across a blink boundary would invent unmeasured pupil values
    const out = decimate(rows, 100);
    expect(out[0].i).toBe(0);
    expect(out[1].i).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe('normalisePerformance', () => {
  it('coerces bigints and orders by block', () => {
    const rows = normalisePerformance([
      { block_index: 1n, n_trials: 60n, hit_rate: 0.5, rewarded_modality: 'aud' },
      { block_index: 0n, n_trials: 90n, hit_rate: 0.9, rewarded_modality: 'vis' },
    ]);
    expect(rows.map((r) => r.block)).toEqual([0, 1]);
    expect(rows[0].nTrials).toBe(90);
    expect(rows[0].rewardedMod).toBe('vis');
  });

  it('maps null and non-finite metrics to null rather than NaN', () => {
    const [row] = normalisePerformance([
      { block_index: 0, vis_dprime: null, aud_dprime: undefined, cross_modality_dprime: 'n/a' },
    ]);
    expect(row.visDprime).toBeNull();
    expect(row.audDprime).toBeNull();
    expect(row.crossDprime).toBeNull();
  });

  it('keeps a legitimate zero d-prime', () => {
    const [row] = normalisePerformance([{ block_index: 0, cross_modality_dprime: 0 }]);
    expect(row.crossDprime).toBe(0);
  });
});

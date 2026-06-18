import { describe, it, expect } from 'vitest';
import {
  trialTableUrl,
  eventTableUrl,
  _normalizeTrial,
  _bucketEvents,
  lastLE,
  firstGE,
  findTrialAt,
} from '../dynamic_foraging/data-loader.js';
import { _buildStepData, _splitLicks } from '../dynamic_foraging/prob-plot.js';
import { _groupBySubject } from '../dynamic_foraging/player.js';

describe('df data-loader · url builders', () => {
  it('builds the per-subject trial table URL', () => {
    expect(trialTableUrl('754372')).toBe(
      'https://aind-scratch-data.s3.us-west-2.amazonaws.com/aind-dynamic-foraging-cache/trial_table/subject_id=754372/754372.parquet',
    );
  });
  it('builds the per-subject event table URL', () => {
    expect(eventTableUrl(754372)).toBe(
      'https://aind-scratch-data.s3.us-west-2.amazonaws.com/aind-dynamic-foraging-cache/event_table/subject_id=754372/754372.parquet',
    );
  });
});

describe('df data-loader · _normalizeTrial', () => {
  it('coerces BigInt / bool to plain numbers', () => {
    const out = _normalizeTrial({
      trial: 3n,
      goCue_t: 12.5,
      choice_t: 13.1,
      reward_t: 13.3,
      response: 0,
      earned: true,
      pL: 0.5,
      pR: 0.1,
      rewardedL: true,
      rewardedR: false,
      autoL: 0,
      autoR: 0,
    });
    expect(out.trial).toBe(3);
    expect(out.earned).toBe(1);
    expect(out.rewardedL).toBe(1);
    expect(out.rewardedR).toBe(0);
    expect(out.pL).toBe(0.5);
    expect(out.response).toBe(0);
  });
  it('maps NaN / null to null', () => {
    const out = _normalizeTrial({
      trial: 1, goCue_t: NaN, choice_t: null, reward_t: undefined,
      response: 2, earned: 0, pL: NaN, pR: 0.2,
      rewardedL: 0, rewardedR: 0, autoL: 0, autoR: 0,
    });
    expect(out.goCue_t).toBeNull();
    expect(out.choice_t).toBeNull();
    expect(out.reward_t).toBeNull();
    expect(out.pL).toBeNull();
    expect(out.pR).toBe(0.2);
  });
});

describe('df data-loader · _bucketEvents', () => {
  it('partitions events by kind and side', () => {
    const rows = [
      { t: 0.0, event: 'goCue_start_time' },
      { t: 1.2, event: 'left_lick_time' },
      { t: 1.4, event: 'left_lick_time' },
      { t: 2.0, event: 'right_lick_time' },
      { t: 2.5, event: 'left_reward_delivery_time' },
      { t: 3.0, event: 'right_reward_delivery_time' },
      { t: 4.0, event: 'unknown_event' },           // ignored
      { t: 'bad', event: 'left_lick_time' },        // ignored: non-finite
    ];
    const out = _bucketEvents(rows);
    expect(Array.from(out.licks.t)).toEqual([1.2, 1.4, 2.0]);
    expect(Array.from(out.licks.side)).toEqual([0, 0, 1]);
    expect(Array.from(out.rewards.t)).toEqual([2.5, 3.0]);
    expect(Array.from(out.rewards.side)).toEqual([0, 1]);
    expect(Array.from(out.goCues)).toEqual([0.0]);
  });
});

describe('df data-loader · binary search helpers', () => {
  const arr = [0.5, 1.0, 2.0, 5.5, 9.9];
  it('lastLE returns -1 below the start', () => {
    expect(lastLE(arr, 0.0)).toBe(-1);
  });
  it('lastLE on exact hit', () => {
    expect(lastLE(arr, 2.0)).toBe(2);
  });
  it('lastLE between entries', () => {
    expect(lastLE(arr, 3.0)).toBe(2);   // 2.0 ≤ 3.0 < 5.5
  });
  it('lastLE above the end', () => {
    expect(lastLE(arr, 100)).toBe(4);
  });
  it('firstGE smallest index with arr[i] ≥ t', () => {
    expect(firstGE(arr, 3.0)).toBe(3);   // 5.5 is first ≥ 3.0
    expect(firstGE(arr, 0.5)).toBe(0);
    expect(firstGE(arr, 9.91)).toBe(arr.length);
  });
  it('lastLE handles empty array', () => {
    expect(lastLE([], 5)).toBe(-1);
  });
});

describe('df data-loader · findTrialAt', () => {
  const trials = [
    { trial: 0, goCue_t: 0.0 },
    { trial: 1, goCue_t: 5.5 },
    { trial: 2, goCue_t: 12.0 },
    { trial: 3, goCue_t: 20.0 },
  ];
  it('returns -1 before first cue', () => {
    expect(findTrialAt(trials, -1)).toBe(-1);
  });
  it('returns the trial whose goCue ≤ t', () => {
    expect(findTrialAt(trials, 0)).toBe(0);
    expect(findTrialAt(trials, 8)).toBe(1);
    expect(findTrialAt(trials, 12)).toBe(2);
    expect(findTrialAt(trials, 100)).toBe(3);
  });
  it('returns -1 for an empty list', () => {
    expect(findTrialAt([], 0)).toBe(-1);
  });
});

describe('df prob-plot · _buildStepData', () => {
  it('emits one point per trial plus a sentinel at sessionEnd', () => {
    const trials = [
      { trial: 0, goCue_t: 0.0, pL: 0.5, pR: 0.1 },
      { trial: 1, goCue_t: 10.0, pL: 0.4, pR: 0.2 },
      { trial: 2, goCue_t: 20.0, pL: 0.3, pR: 0.3 },
    ];
    const out = _buildStepData(trials, 50);
    expect(out).toEqual([
      { t: 0.0, pL: 0.5, pR: 0.1 },
      { t: 10.0, pL: 0.4, pR: 0.2 },
      { t: 20.0, pL: 0.3, pR: 0.3 },
      { t: 50,  pL: 0.3, pR: 0.3 },
    ]);
  });
  it('drops trials with non-finite cue time or probabilities', () => {
    const trials = [
      { trial: 0, goCue_t: 1.0, pL: 0.5, pR: 0.1 },
      { trial: 1, goCue_t: null, pL: 0.5, pR: 0.1 },
      { trial: 2, goCue_t: 2.0, pL: NaN,  pR: 0.1 },
      { trial: 3, goCue_t: 3.0, pL: 0.4,  pR: 0.1 },
    ];
    const out = _buildStepData(trials, 10);
    expect(out.length).toBe(3);   // 2 valid trials + sentinel
    expect(out[0].t).toBe(1.0);
    expect(out[1].t).toBe(3.0);
    expect(out[2].t).toBe(10);
  });
  it('returns empty when no trials are valid', () => {
    expect(_buildStepData([], 50)).toEqual([]);
  });
});

describe('df prob-plot · _splitLicks', () => {
  it('partitions lick events by side, dropping non-finite times', () => {
    const licks = {
      t:    Float64Array.from([0.1, 0.2, 0.3, 0.4, NaN]),
      side: Uint8Array.from(  [0,   1,   0,   1,   0]),
    };
    const { lickL, lickR } = _splitLicks(licks);
    expect(lickL.map((r) => r.t)).toEqual([0.1, 0.3]);
    expect(lickR.map((r) => r.t)).toEqual([0.2, 0.4]);
  });
  it('handles empty input', () => {
    expect(_splitLicks({ t: new Float64Array(), side: new Uint8Array() }))
      .toEqual({ lickL: [], lickR: [] });
  });
});

describe('df player · _groupBySubject', () => {
  it('groups rows by stringified subject_id, preserving order', () => {
    const rows = [
      { subject_id: 754372, session_date: '2024-10-22' },
      { subject_id: '754372', session_date: '2024-10-21' },
      { subject_id: 758435, session_date: '2024-06-12' },
    ];
    const g = _groupBySubject(rows);
    expect([...g.keys()]).toEqual(['754372', '758435']);
    expect(g.get('754372').map((r) => r.session_date)).toEqual(['2024-10-22', '2024-10-21']);
    expect(g.get('758435').length).toBe(1);
  });
  it('returns empty map for empty input', () => {
    expect(_groupBySubject([]).size).toBe(0);
  });
});

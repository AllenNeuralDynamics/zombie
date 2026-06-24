import { describe, it, expect } from 'vitest';
import {
  trialsUrl,
  _normalizeTrial,
  _buildBlocks,
  _buildStimEvents,
  _stimKind,
  _buildResponseEvents,
  _buildRewardEvents,
  lastLE,
  findStimAt,
  findTrialAt,
  findBlockAt,
} from '../dynamic_routing/data-loader.js';
import {
  _buildBlockSpans,
  _buildRateSteps,
  _arrayToRows,
} from '../dynamic_routing/event-plot.js';
import { _groupBySubject } from '../dynamic_routing/player.js';

describe('dr data-loader · url builders', () => {
  it('builds the per-session trials URL', () => {
    expect(trialsUrl('762526_2025-03-20')).toBe(
      'https://aind-scratch-data.s3.us-west-2.amazonaws.com/dynamic-routing/cache/nwb_components/v0.0.272/trials/762526_2025-03-20.parquet',
    );
  });
});

describe('dr data-loader · _normalizeTrial', () => {
  it('coerces BigInt / bool to plain JS numbers, preserves modality string', () => {
    const out = _normalizeTrial({
      trial_index: 5n,
      block_index: 0n,
      rewarded_modality: 'vis',
      stim_name: 'vis1',
      start_time: 10.0,
      stop_time: 14.5,
      stim_start_time: 11.2,
      stim_stop_time: 11.7,
      response_window_start_time: 11.3,
      response_window_stop_time: 12.3,
      response_time: 11.6,
      reward_time: 11.65,
      is_response: true,
      is_correct: true,
      is_hit: true,
      is_miss: false,
      is_false_alarm: false,
      is_correct_reject: false,
      is_target: true,
      is_nontarget: false,
      is_catch: false,
      is_aud_target: false,
      is_vis_target: true,
      is_aud_nontarget: false,
      is_vis_nontarget: false,
      is_rewarded: true,
      is_noncontingent_reward: false,
    });
    expect(out.trial).toBe(5);
    expect(out.block).toBe(0);
    expect(out.rewardedMod).toBe('vis');
    expect(out.stim).toBe('vis1');
    expect(out.isHit).toBe(1);
    expect(out.isRewarded).toBe(1);
    expect(out.response_t).toBe(11.6);
  });
  it('maps null / NaN / undefined to null and false booleans to 0', () => {
    const out = _normalizeTrial({
      trial_index: 1,
      block_index: 0,
      rewarded_modality: 'aud',
      stim_name: 'sound2',
      start_time: 0, stop_time: NaN,
      stim_start_time: null, stim_stop_time: undefined,
      response_window_start_time: 1, response_window_stop_time: 2,
      response_time: null, reward_time: null,
      is_response: false, is_correct: false, is_hit: false,
      is_miss: false, is_false_alarm: false, is_correct_reject: false,
      is_target: false, is_nontarget: true, is_catch: false,
      is_aud_target: false, is_vis_target: false,
      is_aud_nontarget: true, is_vis_nontarget: false,
      is_rewarded: false, is_noncontingent_reward: false,
    });
    expect(out.stop_t).toBeNull();
    expect(out.stim_t).toBeNull();
    expect(out.response_t).toBeNull();
    expect(out.isResp).toBe(0);
    expect(out.isAudNontg).toBe(1);
  });
});

describe('dr data-loader · _buildBlocks', () => {
  it('aggregates per-block counts and time ranges', () => {
    const trials = [
      { trial: 0, block: 0, rewardedMod: 'aud', start_t: 10, stop_t: 12,
        isResp: 1, isRewarded: 1, isHit: 1, isMiss: 0, isFA: 0, isCR: 0,
        isTarget: 1, isNontarget: 0 },
      { trial: 1, block: 0, rewardedMod: 'aud', start_t: 13, stop_t: 15,
        isResp: 0, isRewarded: 0, isHit: 0, isMiss: 1, isFA: 0, isCR: 0,
        isTarget: 1, isNontarget: 0 },
      { trial: 2, block: 0, rewardedMod: 'aud', start_t: 16, stop_t: 18,
        isResp: 1, isRewarded: 0, isHit: 0, isMiss: 0, isFA: 1, isCR: 0,
        isTarget: 0, isNontarget: 1 },
      { trial: 3, block: 1, rewardedMod: 'vis', start_t: 20, stop_t: 22,
        isResp: 0, isRewarded: 0, isHit: 0, isMiss: 0, isFA: 0, isCR: 1,
        isTarget: 0, isNontarget: 1 },
    ];
    const blocks = _buildBlocks(trials);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      block: 0, rewardedMod: 'aud',
      start_t: 10, stop_t: 18,
      n: 3, n_resp: 2, n_rew: 1, n_hit: 1, n_miss: 1, n_fa: 1, n_cr: 0,
      n_target: 2, n_nontarget: 1,
    });
    expect(blocks[1].block).toBe(1);
    expect(blocks[1].n).toBe(1);
  });
  it('returns empty for empty input', () => {
    expect(_buildBlocks([])).toEqual([]);
  });
});

describe('dr data-loader · _stimKind / _buildStimEvents', () => {
  it('classifies trials by stim flags', () => {
    expect(_stimKind({ isCatch: 1 })).toBe('catch');
    expect(_stimKind({ isVisTarget: 1 })).toBe('vis_target');
    expect(_stimKind({ isAudNontg: 1 })).toBe('aud_nontarget');
    // Falls back on stim name when flags missing
    expect(_stimKind({ stim: 'vis1' })).toBe('vis_target');
    expect(_stimKind({ stim: 'sound2' })).toBe('aud_nontarget');
    expect(_stimKind({})).toBe('unknown');
  });
  it('emits one event per trial with a stim onset', () => {
    const trials = [
      { stim_t: 1.0, stim_end_t: 1.5, stim: 'vis1', isVisTarget: 1, block: 0, rewardedMod: 'vis', trial: 0 },
      { stim_t: null, stim_end_t: null, stim: 'catch', isCatch: 1, block: 0, rewardedMod: 'vis', trial: 1 },
      { stim_t: 3.5, stim_end_t: 4.0, stim: 'sound1', isAudTarget: 1, block: 1, rewardedMod: 'aud', trial: 2 },
    ];
    const events = _buildStimEvents(trials);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ t: 1.0, kind: 'vis_target', stim: 'vis1', duration: 0.5 });
    expect(events[1]).toMatchObject({ t: 3.5, kind: 'aud_target', stim: 'sound1' });
  });
});

describe('dr data-loader · response / reward builders', () => {
  it('builds response events from response_time, sorted', () => {
    const trials = [
      { response_t: 3.0 },
      { response_t: null },
      { response_t: 1.5 },
      { response_t: 2.0 },
    ];
    const out = _buildResponseEvents(trials);
    expect(Array.from(out.t)).toEqual([1.5, 2.0, 3.0]);
  });
  it('builds reward events with auto flag', () => {
    const trials = [
      { reward_t: 5.0, isAutoRew: 0 },
      { reward_t: null, isAutoRew: 1 },
      { reward_t: 7.5, isAutoRew: 1 },
    ];
    const out = _buildRewardEvents(trials);
    expect(Array.from(out.t)).toEqual([5.0, 7.5]);
    expect(Array.from(out.auto)).toEqual([0, 1]);
  });
});

describe('dr data-loader · binary-search helpers', () => {
  const arr = [0.5, 1.0, 2.0, 5.5, 9.9];
  it('lastLE returns -1 below the start', () => {
    expect(lastLE(arr, 0.0)).toBe(-1);
  });
  it('lastLE on exact hit', () => {
    expect(lastLE(arr, 2.0)).toBe(2);
  });
  it('lastLE between entries', () => {
    expect(lastLE(arr, 3.0)).toBe(2);
  });
  it('lastLE above the end', () => {
    expect(lastLE(arr, 100)).toBe(4);
  });

  const stims = [
    { t: 1.0, kind: 'vis_target' },
    { t: 3.0, kind: 'aud_target' },
    { t: 5.0, kind: 'catch' },
  ];
  it('findStimAt returns null before the first', () => {
    expect(findStimAt(stims, 0.5)).toBeNull();
  });
  it('findStimAt returns most-recent stim at or before t', () => {
    expect(findStimAt(stims, 3.0).kind).toBe('aud_target');
    expect(findStimAt(stims, 4.99).kind).toBe('aud_target');
    expect(findStimAt(stims, 5.0).kind).toBe('catch');
    expect(findStimAt(stims, 100).kind).toBe('catch');
  });

  const trials = [{ start_t: 10 }, { start_t: 20 }, { start_t: 30 }];
  it('findTrialAt returns -1 before the first', () => {
    expect(findTrialAt(trials, 9)).toBe(-1);
  });
  it('findTrialAt returns index of trial containing t', () => {
    expect(findTrialAt(trials, 15)).toBe(0);
    expect(findTrialAt(trials, 20)).toBe(1);
    expect(findTrialAt(trials, 100)).toBe(2);
  });

  const blocks = [{ start_t: 5 }, { start_t: 50 }];
  it('findBlockAt switches at block boundaries', () => {
    expect(findBlockAt(blocks, 0)).toBe(-1);
    expect(findBlockAt(blocks, 20)).toBe(0);
    expect(findBlockAt(blocks, 50)).toBe(1);
    expect(findBlockAt(blocks, 99)).toBe(1);
  });
});

describe('dr event-plot · _buildBlockSpans', () => {
  it('builds contiguous spans ending at sessionEndS', () => {
    const blocks = [
      { block: 0, rewardedMod: 'aud', start_t: 10, stop_t: 200 },
      { block: 1, rewardedMod: 'vis', start_t: 200, stop_t: 400 },
    ];
    const spans = _buildBlockSpans(blocks, 500);
    expect(spans).toEqual([
      { x1: 10,  x2: 200, rewardedMod: 'aud', block: 0 },
      { x1: 200, x2: 500, rewardedMod: 'vis', block: 1 },
    ]);
  });
});

describe('dr event-plot · _buildRateSteps', () => {
  const blocks = [
    { start_t: 100, n_target: 20, n_hit: 18, n_nontarget: 18, n_fa: 0 },
    { start_t: 200, n_target: 20, n_hit:  5, n_nontarget: 18, n_fa: 9 },
  ];
  it('builds target-rate step lines with sessionEnd sentinel', () => {
    const steps = _buildRateSteps(blocks, 300, 'target');
    expect(steps).toEqual([
      { t: 100, rate: 0.9 },
      { t: 200, rate: 0.25 },
      { t: 300, rate: 0.25 },
    ]);
  });
  it('builds FA-rate step lines', () => {
    const steps = _buildRateSteps(blocks, 300, 'fa');
    expect(steps[0]).toEqual({ t: 100, rate: 0 });
    expect(steps[1]).toEqual({ t: 200, rate: 0.5 });
  });
  it('skips blocks with zero denominator', () => {
    expect(_buildRateSteps([{ start_t: 0, n_target: 0, n_hit: 0 }], 100, 'target')).toEqual([]);
  });
});

describe('dr event-plot · _arrayToRows', () => {
  it('drops non-finite entries', () => {
    const out = _arrayToRows(Float64Array.from([1, NaN, 2, Infinity, 3]));
    expect(out).toEqual([{ t: 1 }, { t: 2 }, { t: 3 }]);
  });
  it('handles null/undefined', () => {
    expect(_arrayToRows(null)).toEqual([]);
    expect(_arrayToRows(undefined)).toEqual([]);
  });
});

describe('dr player · _groupBySubject', () => {
  it('groups sessions by subject preserving order', () => {
    const rows = [
      { subject_id: 1, session_id: '1_2024-01-02', session_date: '2024-01-02' },
      { subject_id: 1, session_id: '1_2024-01-01', session_date: '2024-01-01' },
      { subject_id: 2, session_id: '2_2024-01-03', session_date: '2024-01-03' },
    ];
    const map = _groupBySubject(rows);
    expect([...map.keys()]).toEqual(['1', '2']);
    expect(map.get('1')).toHaveLength(2);
    expect(map.get('1')[0].session_date).toBe('2024-01-02');
    expect(map.get('2')[0].session_date).toBe('2024-01-03');
  });
});

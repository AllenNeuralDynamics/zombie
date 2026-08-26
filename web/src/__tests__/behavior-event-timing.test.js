import { describe, expect, it } from 'vitest';
import {
  buildEventTimingFromRows,
  chooseDefaultEventStream,
  makeEventStream,
} from '../lib/behaviors/event-timing.js';
import { buildVrfEventTiming } from '../vr_foraging/nwb-loader.js';

describe('shared behavior event timing', () => {
  it('normalizes row sources into sorted relative event streams', () => {
    const timing = buildEventTimingFromRows([
      { trial: 2, go: 4, reward: Number.NaN },
      { trial: 1, go: 1, reward: 2 },
    ], [
      { key: 'go_cue', label: 'Go cue', column: 'go' },
      { key: 'reward', label: 'Reward', column: 'reward' },
    ], { source: 'test', referenceTime: 100 });

    expect(timing.referenceTime).toBe(100);
    expect(timing.streams[0]).toMatchObject({
      key: 'go_cue',
      times: [1, 4],
      occurrences: [{ id: 1, t: 1 }, { id: 2, t: 4 }],
    });
    expect(timing.streams[1].times).toEqual([2]);
  });

  it('chooses a useful default without knowing the source platform', () => {
    const streams = [
      makeEventStream('trial_start', 'Trial start', [0]),
      makeEventStream('odor_onset', 'Odor onset', [1]),
    ];
    expect(chooseDefaultEventStream(streams).key).toBe('odor_onset');
  });
});

describe('VR-foraging event timing', () => {
  it('uses the first trial start as the shared Harp-clock origin', () => {
    const timing = buildVrfEventTiming({
      start_time: [100, 110],
      stop_time: [105, 115],
      odor_onset_time: [101, 111],
      choice_cue_time: [102, Number.NaN],
      reward_onset_time: [103, 113],
    });

    expect(timing.referenceTime).toBe(100);
    expect(timing.streams.map((stream) => stream.key)).toEqual([
      'trial_start', 'odor_onset', 'choice_cue', 'reward_onset', 'trial_stop',
    ]);
    expect(timing.streams.find((stream) => stream.key === 'odor_onset').times).toEqual([1, 11]);
    expect(timing.streams.find((stream) => stream.key === 'choice_cue').times).toEqual([2]);
  });
});

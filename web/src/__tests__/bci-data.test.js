import { describe, expect, it } from 'vitest';
import {
  findBciBehaviorPrefix,
  findBciProcessingPrefix,
  findBciTrialAt,
  normalizeBciTrials,
} from '../bci/data.js';
import {
  detectPlaybackPlatform,
  isBciProject,
  isVisualCodingOphysProject,
} from '../lib/behaviors/session-playback.js';

const ASSET = 'single-plane-ophys_767715_2025-02-17_17-41-50_processed_2025-08-05_01-05-20';

function column(data, shape = [data.length]) {
  return { data, shape };
}

describe('BCI asset discovery', () => {
  const xml = `<ListBucketResult>
    <CommonPrefixes><Prefix>${ASSET}/MOp2_3_0/</Prefix></CommonPrefixes>
    <CommonPrefixes><Prefix>${ASSET}/original_metadata/</Prefix></CommonPrefixes>
    <CommonPrefixes><Prefix>${ASSET}/${ASSET}_behavior_nwb/</Prefix></CommonPrefixes>
  </ListBucketResult>`;

  it('finds the separate behavior NWB-Zarr root', () => {
    expect(findBciBehaviorPrefix(xml, ASSET))
      .toBe(`${ASSET}/${ASSET}_behavior_nwb/`);
  });

  it('finds the processing root without confusing it with metadata or behavior', () => {
    expect(findBciProcessingPrefix(xml, ASSET)).toBe(`${ASSET}/MOp2_3_0/`);
  });
});

describe('BCI project routing', () => {
  it('recognizes BCI project-name variants', () => {
    expect(isBciProject('Brain-Computer Interface')).toBe(true);
    expect(isBciProject('BCI single neuron stimulation')).toBe(true);
    expect(isBciProject('ordinary pophys')).toBe(false);
  });

  it('selects the isolated player from the acquisition project name', () => {
    expect(detectPlaybackPlatform({
      type: 'Acquisition',
      modalities: ['behavior', 'pophys'],
      data: { _project_name: 'Brain-Computer Interface' },
    })).toBe('bci');
  });
});

describe('Visual Coding Ophys routing', () => {
  it('recognizes the canonical project name', () => {
    expect(isVisualCodingOphysProject('Allen Brain Observatory - Visual Coding Ophys')).toBe(true);
  });

  it('selects the isolated Visual Coding Ophys viewer', () => {
    expect(detectPlaybackPlatform({
      type: 'Acquisition',
      modalities: ['pophys', 'behavior-videos'],
      data: { _project_name: 'Allen Brain Observatory - Visual Coding Ophys' },
    })).toBe('visual_coding_ophys');
  });
});

describe('BCI trial normalization', () => {
  it('shifts session-clock timestamps and preserves task events', () => {
    const data = normalizeBciTrials({
      start_time: column([100, 104, 109]),
      stop_time: column([103, 108, 113]),
      go_cue: column([1, 1.5, 2]),
      hit: column([1, 0, 1]),
      lick_L: column([
        0, 1.2, 2.1,
        0.5, 0, 0,
        0, 0.8, 0,
      ], [3, 3]),
      reward_time: column([2, 0, 2.5]),
      threshold_crossing_times: column([1.7, 0, 2.2]),
      zaber_step_times: column([
        0.4, 1.1,
        0.7, 0,
        0.3, 1.2,
      ], [3, 2]),
      conditioned_neuron_x: column([107.3, 107.3, 110]),
      conditioned_neuron_y: column([137.19, 137.19, 138]),
      closest_roi: column([48, 48, 51]),
    });

    expect(data.sessionClockStart).toBe(100);
    expect(data.sessionEnd).toBe(13);
    expect(data.trials[0]).toMatchObject({
      index: 1,
      start: 0,
      stop: 3,
      goCue: 1,
      threshold: 1.7,
      reward: 2,
      hit: true,
      targetX: 107.3,
      targetY: 137.19,
      roi: 48,
    });
    expect(data.trials[0].licks).toEqual([1.2, 2.1]);
    expect(data.trials[0].zaberSteps).toEqual([0.4, 1.1]);
    expect(data.trials[1].reward).toBeNull();
    expect(data.counts).toMatchObject({
      trials: 3,
      hits: 2,
      rewards: 2,
      thresholdCrossings: 2,
      licks: 4,
      zaberSteps: 5,
    });
    expect(data.targetChanges).toEqual([
      { trial: 1, targetX: 107.3, targetY: 137.19, roi: 48 },
      { trial: 3, targetX: 110, targetY: 138, roi: 51 },
    ]);
  });

  it('locates a trial by the relative session clock', () => {
    const trials = [
      { start: 0, stop: 3 },
      { start: 4, stop: 8 },
      { start: 9, stop: 13 },
    ];
    expect(findBciTrialAt(trials, -0.1)).toBe(-1);
    expect(findBciTrialAt(trials, 0)).toBe(0);
    expect(findBciTrialAt(trials, 5)).toBe(1);
    expect(findBciTrialAt(trials, 13)).toBe(2);
    expect(findBciTrialAt(trials, 14)).toBe(-1);
  });
});

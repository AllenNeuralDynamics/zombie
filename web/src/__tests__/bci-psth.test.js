import { describe, expect, it } from 'vitest';
import { bciPsthEvents, computeBciPsth } from '../bci/psth.js';

describe('BCI PSTH helpers', () => {
  it('exposes the NWB event streams with usable timestamps', () => {
    const streams = bciPsthEvents({
      trials: [{ start: 0 }],
      goCues: [{ t: 1 }],
      zaberSteps: [{ t: 2 }],
      thresholdCrossings: [],
      licks: [{ t: 3 }],
      rewards: [{ t: 4 }],
    });
    expect(streams.map((stream) => stream.key)).toEqual([
      'trial_start', 'go_cue', 'spout_step', 'lick', 'reward',
    ]);
  });

  it('averages calcium samples around events and reports usable events', () => {
    const trace = Float32Array.from({ length: 100 }, (_, i) => i < 50 ? 1 : 3);
    const result = computeBciPsth(
      trace,
      { traceStart: 0, frameRate: 10 },
      0,
      [5],
      { pre: 2, post: 2, bins: 4 },
    );
    expect(result.usableEvents).toBe(1);
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0].mean).toBe(1);
    expect(result.rows[2].mean).toBe(3);
  });
});

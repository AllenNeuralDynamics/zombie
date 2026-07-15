import { describe, it, expect } from 'vitest';
import {
  interpTrace,
  baselineTrace,
  censorWindows,
  computePsthSeries,
  PSTH_GRID,
  PSTH_PRE,
  PSTH_POST,
} from '../fiber_photometry/fib-playback.js';

function findAt(series, t) {
  let best = null;
  let bestD = Infinity;
  for (const d of series) {
    const dd = Math.abs(d.t - t);
    if (dd < bestD) { bestD = dd; best = d; }
  }
  return best;
}

function sineRows({ nTrials = 6, dt = 0.005, pre = PSTH_PRE - 0.25, post = PSTH_POST + 0.25, evSpacing = 100, channel = 'G' } = {}) {
  const rows = [];
  for (let k = 0; k < nTrials; k++) {
    const ev = k * evSpacing;
    for (let t = pre; t <= post + 1e-9; t += dt) {
      const tr = Math.round(t * 1000) / 1000;
      rows.push({ trial: k, channel, ev_t: ev, t_rel: tr, v: Math.sin(2 * Math.PI * tr) });
    }
  }
  return rows;
}

function constRows({ trial, ev_t, value, channel = 'G', pre = PSTH_PRE - 0.25, post = PSTH_POST + 0.25, dt = 0.02 }) {
  const rows = [];
  for (let t = pre; t <= post + 1e-9; t += dt) {
    rows.push({ trial, channel, ev_t, t_rel: Math.round(t * 1000) / 1000, v: value });
  }
  return rows;
}

describe('interpTrace', () => {
  it('interpolates onto the grid and does not extrapolate outside the sample range', () => {
    const samples = [{ t: -1, v: 1 }, { t: 0, v: 2 }, { t: 1, v: 3 }];
    const out = interpTrace(samples, PSTH_PRE, PSTH_POST);

    const idx = (t) => PSTH_GRID.findIndex((g) => Math.abs(g - t) < 1e-9);
    expect(out[idx(-1)]).toBeCloseTo(1, 6);
    expect(out[idx(-0.5)]).toBeCloseTo(1.5, 6);
    expect(out[idx(0)]).toBeCloseTo(2, 6);
    expect(out[idx(0.5)]).toBeCloseTo(2.5, 6);
    expect(out[idx(1)]).toBeCloseTo(3, 6);

    // Outside [minT, maxT] must be NaN (no extrapolation).
    expect(Number.isNaN(out[idx(-1.5)])).toBe(true);
    expect(Number.isNaN(out[idx(1.5)])).toBe(true);
    expect(Number.isNaN(out[0])).toBe(true);
  });

  it('respects the censor window bounds', () => {
    const samples = [{ t: -2, v: 5 }, { t: 5, v: 5 }];
    const out = interpTrace(samples, -1, 2);
    const idx = (t) => PSTH_GRID.findIndex((g) => Math.abs(g - t) < 1e-9);
    expect(out[idx(0)]).toBeCloseTo(5, 6);
    expect(Number.isNaN(out[idx(-1.5)])).toBe(true);
    expect(Number.isNaN(out[idx(3)])).toBe(true);
  });

  it('returns all NaN for fewer than two samples', () => {
    const out = interpTrace([{ t: 0, v: 1 }], PSTH_PRE, PSTH_POST);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe('censorWindows', () => {
  it('truncates each window at the neighbouring event', () => {
    const rows = [
      { trial: 0, ev_t: 0 },
      { trial: 1, ev_t: 1 },
      { trial: 2, ev_t: 100 },
    ];
    const w = censorWindows(rows);
    // First event: no previous, next gap 1 -> hi = min(POST, 1)
    expect(w.get(0)).toEqual({ lo: -Math.min(2, Infinity), hi: 1 });
    // Middle event: prev gap 1 -> lo = -min(2,1); next gap 99 -> hi = min(5,99)
    expect(w.get(1)).toEqual({ lo: -1, hi: 5 });
    // Last event: prev gap 99 -> lo = -min(2,99); no next
    expect(w.get(2)).toEqual({ lo: -2, hi: 5 });
  });
});

describe('baselineTrace', () => {
  it('subtracts the mean over the pre-event window [-baselineSec, 0)', () => {
    const trace = PSTH_GRID.map((t) => (t < 0 ? 5 : 10));
    const out = baselineTrace(trace, 0.2);
    const idx = (t) => PSTH_GRID.findIndex((g) => Math.abs(g - t) < 1e-9);
    expect(out[idx(-0.1)]).toBeCloseTo(0, 6);
    expect(out[idx(0)]).toBeCloseTo(5, 6);
    expect(out[idx(1)]).toBeCloseTo(5, 6);
  });

  it('returns the trace unchanged when baselineSec is not positive', () => {
    const trace = PSTH_GRID.map(() => 3);
    expect(baselineTrace(trace, 0)).toBe(trace);
  });
});

describe('computePsthSeries — event-triggered averaging', () => {
  it('recovers a sinusoid through trial averaging (mirrors aind event_triggered_response test)', () => {
    const { allMean, channels } = computePsthSeries(sineRows());
    expect(channels).toEqual(['G']);
    expect(findAt(allMean, 0).mean).toBeCloseTo(0, 2);
    expect(findAt(allMean, 0.25).mean).toBeCloseTo(1, 2);
    expect(findAt(allMean, 0.5).mean).toBeCloseTo(0, 2);
    expect(findAt(allMean, 0.75).mean).toBeCloseTo(-1, 2);
    expect(findAt(allMean, 1).mean).toBeCloseTo(0, 2);
  });

  it('has no edge artifact when samples bracket the window (finite mean at every grid point)', () => {
    const rows = [
      ...constRows({ trial: 0, ev_t: 0, value: 4 }),
      ...constRows({ trial: 1, ev_t: 100, value: 6 }),
    ];
    const { allMean } = computePsthSeries(rows);
    // One mean entry per grid point, all finite and equal to the average (5).
    expect(allMean).toHaveLength(PSTH_GRID.length);
    for (const d of allMean) {
      expect(Number.isFinite(d.mean)).toBe(true);
      expect(d.mean).toBeCloseTo(5, 6);
    }
    // Specifically the first and last grid points (edges) are correct.
    expect(findAt(allMean, PSTH_PRE).mean).toBeCloseTo(5, 6);
    expect(findAt(allMean, PSTH_POST).mean).toBeCloseTo(5, 6);
  });

  it('censors samples past a neighbouring event (mirrors aind censor test)', () => {
    const rows = [
      ...constRows({ trial: 0, ev_t: 0, value: 10 }),
      ...constRows({ trial: 1, ev_t: 1, value: 20 }),
    ];
    const { allMean } = computePsthSeries(rows);
    // Within both censor windows -> both trials contribute -> mean 15.
    expect(findAt(allMean, 0.5).mean).toBeCloseTo(15, 6);
    // Past trial 0's next event (t > 1) -> only trial 1 -> mean 20.
    expect(findAt(allMean, 2).mean).toBeCloseTo(20, 6);
    // Before trial 1's previous event (t < -1) -> only trial 0 -> mean 10.
    expect(findAt(allMean, -1.5).mean).toBeCloseTo(10, 6);
  });

  it('computes SEM across trials (zero when all trials agree)', () => {
    const rows = [
      ...constRows({ trial: 0, ev_t: 0, value: 7 }),
      ...constRows({ trial: 1, ev_t: 100, value: 7 }),
      ...constRows({ trial: 2, ev_t: 200, value: 7 }),
    ];
    const { allMean } = computePsthSeries(rows);
    const d = findAt(allMean, 0);
    expect(d.mean).toBeCloseTo(7, 6);
    expect(d.lo).toBeCloseTo(7, 6);
    expect(d.hi).toBeCloseTo(7, 6);
  });

  it('applies a per-trial baseline subtraction when baselineSec > 0', () => {
    // Baseline (pre-event) value 2, post-event value 5.
    function stepRows(trial, ev_t) {
      const rows = [];
      for (let t = PSTH_PRE - 0.25; t <= PSTH_POST + 0.25 + 1e-9; t += 0.02) {
        const tr = Math.round(t * 1000) / 1000;
        rows.push({ trial, channel: 'G', ev_t, t_rel: tr, v: tr < 0 ? 2 : 5 });
      }
      return rows;
    }
    const rows = [...stepRows(0, 0), ...stepRows(1, 100)];
    const { allMean } = computePsthSeries(rows, 0.2);
    expect(findAt(allMean, -0.1).mean).toBeCloseTo(0, 6);
    expect(findAt(allMean, 1).mean).toBeCloseTo(3, 6);
  });
});

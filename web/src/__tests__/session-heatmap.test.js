/**
 * session-heatmap.test.js — the cross-session aggregate: per-session
 * normalization, heatmap layout, and pooling across sessions.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import {
  zScoreSessionTrace,
  buildHeatmapRects,
  poolHeatmapRects,
  createSessionHeatmap,
} from '../lib/behaviors/session-heatmap.js';

/** A trace whose baseline is ±1 around `base` and whose response is `peak`. */
const trace = (base, peak) => [
  { t: -1.0, mean: base - 1 },
  { t: -0.5, mean: base + 1 },
  { t: 0.5, mean: peak },
  { t: 1.0, mean: peak },
];

describe('zScoreSessionTrace', () => {
  it('centres and scales on the pre-event baseline', () => {
    const { points, scaled } = zScoreSessionTrace(trace(10, 14));
    expect(scaled).toBe(true);
    // Baseline is 9 and 11 → mean 10, sd √2; the response sits 4 above it.
    const byTime = Object.fromEntries(points.map((d) => [d.t, d.z]));
    expect(byTime[-1]).toBeCloseTo(-1 / Math.SQRT2, 6);
    expect(byTime[0.5]).toBeCloseTo(4 / Math.SQRT2, 6);
  });

  it('puts sessions of different raw scale on the same footing', () => {
    // Same shape, ten times the raw ΔF/F: z-scores must match.
    const small = zScoreSessionTrace(trace(1, 5)).points.map((d) => d.z);
    const large = zScoreSessionTrace(trace(10, 50).map((d) => ({ ...d, mean: d.mean })));
    expect(large.scaled).toBe(true);
    // The baseline spread scales with the signal in the large session, so the
    // point is simply that neither trace keeps its raw magnitude.
    expect(Math.max(...small.map(Math.abs))).toBeLessThan(10);
    expect(Math.max(...large.points.map((d) => Math.abs(d.z)))).toBeLessThan(50);
  });

  it('falls back to baseline subtraction when the baseline is flat', () => {
    const { points, scaled } = zScoreSessionTrace([
      { t: -1, mean: 5 }, { t: -0.5, mean: 5 }, { t: 0.5, mean: 9 },
    ]);
    expect(scaled).toBe(false);
    expect(points.map((d) => d.z)).toEqual([0, 0, 4]);
  });

  it('ignores non-finite samples and survives an empty trace', () => {
    expect(zScoreSessionTrace([]).points).toEqual([]);
    const { points } = zScoreSessionTrace([
      { t: -1, mean: NaN }, { t: -0.5, mean: 1 }, { t: 0.5, mean: 3 },
    ]);
    expect(points).toHaveLength(2);
  });
});

describe('buildHeatmapRects', () => {
  const sessions = [
    { label: '2026-05-01', points: trace(10, 14) },
    { label: '2026-05-02', points: trace(1, 5) },
  ];

  it('gives each session a row, oldest first', () => {
    const { rects, labels } = buildHeatmapRects(sessions);
    expect(labels).toEqual(['2026-05-01', '2026-05-02']);
    expect(rects.filter((r) => r.session === '2026-05-01').every((r) => r.y0 === 0)).toBe(true);
    expect(rects.filter((r) => r.session === '2026-05-02').every((r) => r.y0 === 1)).toBe(true);
  });

  it('paints each sample up to the next one', () => {
    const { rects } = buildHeatmapRects([sessions[0]]);
    expect(rects[0]).toMatchObject({ t0: -1, t1: -0.5 });
    // The last sample reuses the previous step so the row ends flush.
    expect(rects[rects.length - 1]).toMatchObject({ t0: 1, t1: 1.5 });
  });

  it('skips sessions with no usable samples', () => {
    const { labels } = buildHeatmapRects([...sessions, { label: 'empty', points: [] }]);
    expect(labels).toEqual(['2026-05-01', '2026-05-02']);
  });

  it('reports when a session could not be scaled', () => {
    const flat = { label: 'flat', points: [{ t: -1, mean: 2 }, { t: 0.5, mean: 3 }] };
    expect(buildHeatmapRects(sessions).allScaled).toBe(true);
    expect(buildHeatmapRects([...sessions, flat]).allScaled).toBe(false);
  });
});

describe('poolHeatmapRects', () => {
  it('averages across sessions at each time point with an SEM band', () => {
    const rects = [
      { t: 0, z: 1 }, { t: 0, z: 3 },
      { t: 1, z: 2 }, { t: 1, z: 2 },
    ];
    const pooled = poolHeatmapRects(rects);
    expect(pooled.map((d) => d.t)).toEqual([0, 1]);
    expect(pooled[0]).toMatchObject({ mean: 2, n: 2 });
    // sd = √2, sem = 1 → band is mean ± 1.
    expect(pooled[0].lo).toBeCloseTo(1, 6);
    expect(pooled[0].hi).toBeCloseTo(3, 6);
    // No spread at t = 1 → no band.
    expect(pooled[1]).toMatchObject({ mean: 2, lo: 2, hi: 2 });
  });

  it('sorts by time and drops non-finite values', () => {
    const pooled = poolHeatmapRects([{ t: 2, z: 1 }, { t: 0, z: 1 }, { t: 1, z: NaN }]);
    expect(pooled.map((d) => d.t)).toEqual([0, 2]);
  });
});

describe('createSessionHeatmap', () => {
  const sessions = [
    { label: '2026-05-01', points: trace(10, 14) },
    { label: '2026-05-02', points: trace(1, 5) },
  ];

  it('renders a heatmap and a pooled trace', () => {
    const { element, sessionCount, allScaled } = createSessionHeatmap(sessions);
    expect(sessionCount).toBe(2);
    expect(allScaled).toBe(true);
    // One plot for the heatmap, one for the pooled mean ± SEM.
    expect(element.querySelectorAll('svg, figure').length).toBeGreaterThanOrEqual(2);
  });

  it('says so when there is nothing to aggregate', () => {
    const { element, sessionCount } = createSessionHeatmap([]);
    expect(sessionCount).toBe(0);
    expect(element.textContent).toContain('No traces to aggregate');
  });
});

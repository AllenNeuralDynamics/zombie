/**
 * vrf-odor-color.test.js — regression guard that VR-foraging colours are keyed
 * by ODOR IDENTITY (patch_label), never by the running patch instance index.
 *
 * The bug this pins: reward sites were coloured via patchColor(patch_index), so
 * the same odor (e.g. "odor_90") got a different colour in every patch and none
 * matched the odor legend. Colours must depend on patch_label only.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { buildOdorPalette, odorBandColor } from '../vr_foraging/theme.js';
import { buildBands } from '../vr_foraging/trace-plot.js';

/** Two patches share odor "odor_90" but have different patch_index (0 and 2). */
function sites() {
  return [
    { patch_index: 0, patch_label: 'odor_90', site_label: 'RewardSite', start_time_s: 0, stop_time_s: 1 },
    { patch_index: 1, patch_label: 'odor_10', site_label: 'RewardSite', start_time_s: 1, stop_time_s: 2 },
    { patch_index: 2, patch_label: 'odor_90', site_label: 'RewardSite', start_time_s: 2, stop_time_s: 3 },
    { patch_index: 3, patch_label: 'odor_10', site_label: 'RewardSite', start_time_s: 3, stop_time_s: 4 },
    { patch_index: 0, patch_label: 'odor_90', site_label: 'InterPatch', start_time_s: 4, stop_time_s: 5 },
  ];
}

describe('buildOdorPalette', () => {
  it('maps by odor label, giving distinct colours to distinct odors', () => {
    const pal = buildOdorPalette(sites());
    expect(pal.get('odor_90')).toBeTruthy();
    expect(pal.get('odor_10')).toBeTruthy();
    expect(pal.get('odor_90')).not.toBe(pal.get('odor_10'));
  });

  it('is deterministic — same sites yield the same mapping', () => {
    expect([...buildOdorPalette(sites())]).toEqual([...buildOdorPalette(sites())]);
  });
});

describe('odorBandColor', () => {
  it('gives the SAME colour to same-odor reward sites at different patch_index', () => {
    const pal = buildOdorPalette(sites());
    const s = sites();
    const a = s[0]; // odor_90, patch_index 0
    const b = s[2]; // odor_90, patch_index 2
    expect(a.patch_index).not.toBe(b.patch_index);
    expect(odorBandColor(a, pal)).toBe(odorBandColor(b, pal));
    // ...and that colour is the odor-keyed palette colour, not an index colour.
    expect(odorBandColor(a, pal)).toBe(pal.get('odor_90'));
  });

  it('gives DIFFERENT colours to different odors', () => {
    const pal = buildOdorPalette(sites());
    const s = sites();
    expect(odorBandColor(s[0], pal)).not.toBe(odorBandColor(s[1], pal));
  });
});

describe('trace-plot buildBands', () => {
  it('colours same-odor reward bands identically regardless of patch_index', () => {
    const bands = buildBands(sites());
    // Reward bands for odor_90 are at t=0 and t=2; they must share a colour.
    const b0 = bands.find((b) => b.x1 === 0);
    const b2 = bands.find((b) => b.x1 === 2);
    expect(b0.color).toBe(b2.color);
    // odor_10 band differs.
    const b1 = bands.find((b) => b.x1 === 1);
    expect(b0.color).not.toBe(b1.color);
  });
});

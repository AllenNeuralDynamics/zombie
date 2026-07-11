/**
 * vrf-altviews-smoke.test.js — smoke tests that the Patch-ethogram and
 * Aligned Observable-Plot builders render an <svg> from synthetic session
 * data without throwing.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { createPatchEthogram } from '../vr_foraging/patch-ethogram.js';
import { createAlignedPlot } from '../vr_foraging/aligned-plot.js';

function synthData() {
  const sites = [];
  let t = 0;
  for (let p = 0; p < 4; p++) {
    for (let s = 0; s < 3; s++) {
      const isReward = s > 0;
      sites.push({
        patch_index: p,
        patch_label: `Odor${p % 2 === 0 ? 'A' : 'B'}`,
        site_label: s === 0 ? 'InterPatch' : 'RewardSite',
        site_in_patch_index: s,
        block_index: p < 2 ? 0 : 1,
        start_time_s: t,
        stop_time_s: t + 2,
        has_choice: isReward,
        choice_cue_time_s: isReward ? t + 0.5 : null,
        has_reward: isReward && s === 1,
        reward_onset_time_s: isReward && s === 1 ? t + 1.0 : null,
      });
      t += 2;
    }
  }
  const pos_t = [];
  const pos_cm = [];
  for (let i = 0; i <= t * 20; i++) { pos_t.push(i / 20); pos_cm.push(i * 3); }
  return {
    sites,
    traces: {
      t0_offset: 0,
      pos_t: Float64Array.from(pos_t),
      pos_cm: Float64Array.from(pos_cm),
      lick_t: [1.1, 3.2, 5.4, 7.1, 9.3],
      force_reward_t: [4.9],
    },
  };
}

describe('vrf alt-view builders', () => {
  it('patch ethogram renders an svg', () => {
    const { element } = createPatchEthogram(synthData());
    document.body.appendChild(element);
    element.querySelector('.pe-count').dispatchEvent(new Event('input'));
    expect(element.querySelector('svg')).toBeTruthy();
  });

  it('aligned plot renders an svg and toggles group', () => {
    const { element } = createAlignedPlot(synthData());
    document.body.appendChild(element);
    element.querySelector('.al-event').dispatchEvent(new Event('change'));
    const grp = element.querySelector('.al-group');
    grp.checked = true;
    grp.dispatchEvent(new Event('change'));
    expect(element.querySelector('svg')).toBeTruthy();
  });
});

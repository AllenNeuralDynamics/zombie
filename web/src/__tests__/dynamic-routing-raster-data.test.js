import { describe, expect, it } from 'vitest';
import {
  assertRasterAssetName,
  buildConditionPanels,
  buildRasterRows,
  classifyTrial,
  findNwbZarrPrefix,
  normalizeTrialRows,
} from '../dynamic_routing_raster/data.js';

describe('dynamic-routing raster condition adapter', () => {
  it('classifies target status independently from reward outcome', () => {
    expect(classifyTrial({
      stim: 'vis1', isVisTarget: true, isTarget: true, isNontarget: false, isCatch: false,
    })).toBe('visual_target');
    expect(classifyTrial({
      stim: 'sound2', isAudNontarget: true, isTarget: false, isNontarget: true,
      isCatch: false, isRewarded: true,
    })).toBe('auditory_nontarget');
  });

  it('normalizes real-looking trials and preserves both contexts', () => {
    const trials = normalizeTrialRows([
      {
        trial_index: 0, block_index: 0, rewarded_modality: 'vis', stim_name: 'vis1',
        stim_start_time: 10, is_target: true, is_nontarget: false, is_catch: false,
        is_vis_target: true,
      },
      {
        trial_index: 1, block_index: 1, rewarded_modality: 'aud', stim_name: 'sound2',
        stim_start_time: 20, is_target: false, is_nontarget: true, is_catch: false,
        is_aud_nontarget: true,
      },
    ]);
    expect(trials.map((trial) => trial.condition)).toEqual(['visual_target', 'auditory_nontarget']);
    expect(buildConditionPanels(trials).map((panel) => panel.key)).toEqual([
      'vis_visual_target', 'aud_auditory_nontarget',
    ]);
  });

  it('builds onset-relative raster rows for each trial', () => {
    const trials = [
      { trial: 4, stimStart: 10 },
      { trial: 5, stimStart: 20 },
    ];
    expect(buildRasterRows([9, 10.25, 19.5, 22.1], trials, -1, 2)).toEqual([
      { relative: -1, row: 0, trial: 4 },
      { relative: 0.25, row: 0, trial: 4 },
      { relative: -0.5, row: 1, trial: 5 },
    ]);
  });
});

describe('dynamic-routing raster asset helpers', () => {
  it('validates asset names before using them in public URLs', () => {
    expect(assertRasterAssetName('ecephys_742903-2024.10')).toBe('ecephys_742903-2024.10');
    expect(() => assertRasterAssetName('bad/name')).toThrow(/Invalid ecephys asset name/);
  });

  it('discovers a top-level NWB-Zarr child', () => {
    const xml = '<CommonPrefixes><Prefix>asset/session.nwb.zarr/</Prefix></CommonPrefixes>';
    expect(findNwbZarrPrefix(xml, 'asset')).toBe('asset/session.nwb.zarr/');
    expect(findNwbZarrPrefix(xml, 'other')).toBeNull();
  });
});

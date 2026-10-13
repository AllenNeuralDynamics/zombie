import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as zarr from 'zarrita';
import { loadVrfSession, selectVrfLayout } from '../vr_foraging/nwb-loader.js';

vi.mock('zarrita', () => ({
  FetchStore: vi.fn(),
  root: vi.fn(() => ({ resolve: (path) => path })),
  open: vi.fn(),
  get: vi.fn(),
}));

const legacyMetadata = {
  data_processes: [{
    name: 'VR Foraging NWB Packaging Process',
    code: { version: 'bff875c29c82ce46ee6b3e0e86fd5101556124b5' },
  }],
};
const modernMetadata = (version) => ({
  data_processes: [{
    name: 'primary-nwb-packaging-vr-foraging',
    code: { version },
    output_parameters: { packaging_version: version },
  }],
});

describe('VR-foraging packaging versions', () => {
  it('keeps the legacy commit-based packager separate from release versions', () => {
    expect(selectVrfLayout(legacyMetadata).legacy).toBe(true);
  });

  it.each(['0.0.6', '0.0.19', '0.20.0', '0.21.0', '0.23.0', '0.24.0', '1.0.0'])(
    'uses the processed DynamicTable layout for %s', (version) => {
      expect(selectVrfLayout(modernMetadata(version)).positionTime)
        .toBe('processing/behavior/position_velocity/timestamp');
    },
  );

  it('handles the first NWB export before position and velocity were combined', () => {
    expect(selectVrfLayout(modernMetadata('0.0.5')).position)
      .toBe('processing/behavior/Position/position/data');
  });

  it('rejects missing or unrecognized metadata before guessing array paths', () => {
    expect(() => selectVrfLayout({})).toThrow(/metadata is missing/);
    expect(() => selectVrfLayout(modernMetadata('unknown'))).toThrow(/Unrecognized/);
    expect(() => selectVrfLayout(modernMetadata('0.0.4'))).toThrow(/unsupported/);
  });
});

describe('VR-foraging playback normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    zarr.get.mockImplementation(async (array) => ({ data: array }));
  });
  afterEach(() => vi.unstubAllGlobals());

  function installSession(modern, { forceRewards = true } = {}) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => modern ? modernMetadata('0.23.0') : legacyMetadata,
    }));
    const columns = {
      site_index: [0n, 1n], start_time: [100, 110], stop_time: [110, 120],
      start_position: [5, 15], length: [10, 10], site_label: ['InterSite', 'RewardSite'],
      patch_label: ['A', 'A'], patch_index: [0n, 0n], block_index: [0n, 0n],
      [modern ? 'site_index_in_patch' : 'site_in_patch_index']: [0n, 1n],
      [modern ? 'site_index_in_patch_by_type' : 'site_by_type_in_patch_index']: [0n, 0n],
      reward_probability: [NaN, 0.5], has_choice: [false, true], choice_cue_time: [NaN, 112],
      has_reward: [false, true], reward_onset_time: [NaN, 114], reward_delay_duration: [NaN, 2],
      has_waited_reward_delay: [NaN, 1], odor_onset_time: [NaN, 111], reward_amount: [NaN, 5],
    };
    const arrays = Object.fromEntries(Object.entries(columns).map(([key, value]) => [`intervals/trials/${key}`, value]));
    const layout = selectVrfLayout(modern ? modernMetadata('0.23.0') : legacyMetadata);
    arrays[layout.position] = modern ? [5, 15, 25] : [0, 5, 15, 25];
    arrays[layout.positionTime] = modern ? [100, 110, 120] : [0, 100, 110, 120];
    // Repeated true values distinguish explicit onsets from sampled states.
    arrays[layout.lick] = [false, true, true, false, true];
    arrays[layout.lickTime] = [100, 101, 102, 103, 104];
    if (forceRewards) arrays[layout.forceReward] = [105];
    zarr.open.mockImplementation(async (path) => {
      if (!(path in arrays)) throw new Error(`Missing fixture array: ${path}`);
      return arrays[path];
    });
  }

  it.each([false, true])('normalizes sites, clocks and traces (processed=%s)', async (modern) => {
    installSession(modern);
    const result = await loadVrfSession('valid-asset');
    expect(result.sites[1]).toMatchObject({
      site_index: 1, site_in_patch_index: 1, site_by_type_in_patch_index: 0,
      start_time_s: 10, stop_time_s: 20, choice_cue_time_s: 12,
      reward_onset_time_s: 14, reward_delay_duration_s: 2, reward_amount_ul: 5,
    });
    expect(result.sites[0].reward_probability).toBeNull();
    expect(Array.from(result.traces.pos_t)).toEqual([0, 10, 20]);
    expect(Array.from(result.traces.pos_cm)).toEqual([5, 15, 25]);
    expect(result.traces.lick_t).toEqual(modern ? [1, 2, 4] : [1, 4]);
    expect(result.traces.force_reward_t).toEqual([5]);
    expect(result.traces.t0_offset).toBe(100);
  });

  it('allows an absent optional force-reward stream', async () => {
    installSession(true, { forceRewards: false });
    expect((await loadVrfSession('valid-asset')).traces.force_reward_t).toEqual([]);
  });

  it('still rejects a missing required trace', async () => {
    installSession(true);
    const open = zarr.open.getMockImplementation();
    zarr.open.mockImplementation((path) => {
      if (path === 'processing/behavior/licks/data') throw new Error('Missing licks');
      return open(path);
    });
    await expect(loadVrfSession('valid-asset')).rejects.toThrow('Missing licks');
  });

  it('passes cancellation to metadata and Zarr fetches', async () => {
    installSession(true);
    const ctrl = new AbortController();
    await loadVrfSession('valid-asset', { signal: ctrl.signal });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/processing.json'), { signal: ctrl.signal });
    expect(zarr.FetchStore).toHaveBeenCalledWith(expect.any(String), { overrides: { signal: ctrl.signal } });
  });

  it('stops after metadata if the session is cancelled', async () => {
    installSession(true);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(loadVrfSession('valid-asset', { signal: ctrl.signal })).rejects.toThrow('aborted');
    expect(zarr.open).not.toHaveBeenCalled();
  });

  it('reports metadata HTTP failures without exposing an asset URL', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(loadVrfSession('valid-asset')).rejects.toThrow('Unable to read VR-foraging packaging metadata (404)');
  });
});

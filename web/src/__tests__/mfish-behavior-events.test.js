import { describe, expect, it, vi } from 'vitest';

const arrays = new Map();

vi.mock('zarrita', () => ({
  FetchStore: class FetchStore {
    constructor(url) { this.url = url; }
  },
  root: () => ({ resolve: (path) => path }),
  open: async (path) => path,
  get: async (path, selection) => {
    if (!arrays.has(path)) throw new Error(`missing fixture array: ${path}`);
    const value = arrays.get(path);
    if (Number.isInteger(selection?.[0])
        && Array.isArray(value)
        && Array.isArray(value[0])
        && Array.isArray(value[0][0])) {
      const plane = value[selection[0]];
      return { data: plane, shape: [plane.length, plane[0]?.length ?? 0] };
    }
    return { data: value, shape: Array.isArray(value) ? [value.length] : [] };
  },
}));

const {
  createStimulusTemplateLoader,
  findBehaviorNwbPrefix,
  findStimulusTemplateGroups,
  loadBehaviorEventsFromUrl,
} = await import('../mfish/behavior-events.js');

describe('mFISH behavior NWB discovery', () => {
  it('finds the actual inner NWB root instead of guessing its filename', () => {
    const asset = 'multiplane-ophys_800995_2025-08-15_12-44-14_processed_2025-08-16_00-00-00';
    const xml = `<ListBucketResult>
      <CommonPrefixes><Prefix>${asset}/figures/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>${asset}/multiplane-ophys_800995_2025-08-15_12-44-14.nwb/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>${asset}/behavior.nwb.zarr/</Prefix></CommonPrefixes>
    </ListBucketResult>`;

    expect(findBehaviorNwbPrefix(xml, asset)).toBe(`${asset}/behavior.nwb.zarr/`);
  });

  it('accepts legacy .nwb Zarr roots', () => {
    const asset = 'processed-session';
    expect(findBehaviorNwbPrefix(
      `<CommonPrefixes><Prefix>${asset}/raw-session.nwb/</Prefix></CommonPrefixes>`,
      asset,
    )).toBe(`${asset}/raw-session.nwb/`);
  });

  it('discovers a template group and reads only the requested image plane', async () => {
    arrays.clear();
    arrays.set('stimulus/templates/TestImageSet/control_description', ['im063', 'im077']);
    arrays.set('stimulus/templates/TestImageSet/data', [
      [[1, 2], [3, 4]],
      [[5, 6], [7, 8]],
    ]);
    const xml = '<CommonPrefixes><Prefix>behavior.nwb.zarr/stimulus/templates/TestImageSet/</Prefix></CommonPrefixes>';
    const fetch = vi.fn(async () => ({
      ok: true,
      text: async () => xml,
    }));
    vi.stubGlobal('fetch', fetch);

    try {
      const baseUrl = 'https://example.test/behavior.nwb.zarr';
      expect(findStimulusTemplateGroups(xml, baseUrl)).toEqual(['TestImageSet']);

      const loader = createStimulusTemplateLoader(baseUrl);
      const image = await loader.get('im077');
      expect(image).toMatchObject({ shape: [2, 2], data: [[5, 6], [7, 8]] });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await loader.get('im077')).toBe(image);
      expect(await loader.get('not-in-stack')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('mFISH image-stage behavior parser', () => {
  it('parses image flashes, changes, rewards, licks, and running speed', async () => {
    arrays.clear();
    arrays.set('intervals/stimulus_presentations/start_time', [100, 100.75]);
    arrays.set('intervals/stimulus_presentations/stop_time', [100.25, 101]);
    arrays.set('intervals/stimulus_presentations/image_name', ['im063', 'im077']);
    arrays.set('intervals/stimulus_presentations/is_change', [0, 1]);
    arrays.set('intervals/stimulus_presentations/omitted', [0, 0]);
    arrays.set('intervals/trials/change_time', [100.75]);
    arrays.set('intervals/trials/reward_time', [101]);
    arrays.set('processing/behavior/licks/timestamps', [100.2, 100.8]);
    arrays.set('processing/running/speed/timestamps', [99, 102]);
    arrays.set('processing/running/speed/data', [0, 4]);

    const data = await loadBehaviorEventsFromUrl('https://example.test/behavior.nwb.zarr');

    expect(data.variant).toBe('images');
    expect(data.stimuli).toHaveLength(2);
    expect(data.stimuli[1]).toMatchObject({ t: 100.75, tEnd: 101, label: 'im077', isChange: true });
    expect([...data.changes]).toEqual([100.75]);
    expect([...data.rewards]).toEqual([101]);
    expect([...data.licks]).toEqual([100.2, 100.8]);
    expect(data.running.t.length).toBe(2);
    expect(data.counts).toMatchObject({ stimuli: 2, changes: 1, rewards: 1, licks: 2 });
  });

  it('decimates running speed to a fixed ~10 Hz rate, not a fixed total-point budget', async () => {
    arrays.clear();
    arrays.set('intervals/stimulus_presentations/start_time', [100, 100.75]);
    arrays.set('intervals/stimulus_presentations/stop_time', [100.25, 101]);
    arrays.set('intervals/stimulus_presentations/image_name', ['im063', 'im077']);
    arrays.set('intervals/stimulus_presentations/is_change', [0, 1]);
    arrays.set('intervals/stimulus_presentations/omitted', [0, 0]);
    arrays.set('intervals/trials/change_time', [100.75]);
    arrays.set('intervals/trials/reward_time', [101]);
    arrays.set('processing/behavior/licks/timestamps', [100.2, 100.8]);

    // A long (50 min), densely-sampled (100 Hz) running trace. The old fixed
    // 3000-point budget would collapse this to ~1 Hz; the fix should hold
    // output resolution near 10 Hz regardless of how long the session is.
    const spanS = 3000;
    const nativeHz = 100;
    const n = spanS * nativeHz;
    arrays.set('processing/running/speed/timestamps', Array.from({ length: n }, (_, i) => i / nativeHz));
    arrays.set('processing/running/speed/data', Array.from({ length: n }, () => 0));

    const data = await loadBehaviorEventsFromUrl('https://example.test/behavior.nwb.zarr');
    const outputHz = data.running.t.length / spanS;

    expect(outputHz).toBeGreaterThan(5);
    expect(outputHz).toBeLessThanOrEqual(11);
  });

  it('does not turn an unrecognized NWB layout into a fake one-second session', async () => {
    arrays.clear();
    await expect(loadBehaviorEventsFromUrl('https://example.test/behavior.nwb.zarr'))
      .rejects.toThrow(/stimulus_presentations\/start_time/);
  });
});

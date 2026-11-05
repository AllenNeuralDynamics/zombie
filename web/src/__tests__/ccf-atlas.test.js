import { describe, expect, it, vi } from 'vitest';
import {
  buildCcfLayer,
  CCF_ATLAS_ID,
  CCF_GRAPHQL_URL,
  CCF_ROOT_SEGMENT,
  CCF_SOURCE,
  ccfColorMap,
  fetchCcfStructures,
} from '../lib/ccf-atlas.js';

describe('shared CCF atlas helpers', () => {
  it('fetches CCFv3 structures using the pinned atlas ID and signal', async () => {
    const signal = new AbortController().signal;
    const structures = [{ structureId: 997, defaultColor: 'FFFFFF' }];
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { atlasStructures: structures } }),
    }));

    await expect(fetchCcfStructures({ fetchImpl, signal })).resolves.toEqual(structures);
    expect(fetchImpl).toHaveBeenCalledWith(CCF_GRAPHQL_URL, expect.objectContaining({
      method: 'POST',
      signal,
      body: expect.stringContaining(CCF_ATLAS_ID),
    }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).variables).toEqual({ atlasId: CCF_ATLAS_ID });
  });

  it('surfaces HTTP, GraphQL, and malformed response errors', async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 });
    await expect(fetchCcfStructures({ fetchImpl })).rejects.toThrow('HTTP 503');
    await expect(fetchCcfStructures({
      fetchImpl: async () => ({ ok: true, json: async () => ({ errors: [{ message: 'bad query' }] }) }),
    })).rejects.toThrow('bad query');
    await expect(fetchCcfStructures({
      fetchImpl: async () => ({ ok: true, json: async () => ({ data: {} }) }),
    })).rejects.toThrow('no atlasStructures array');
  });

  it('normalizes colors and builds filtered or full-color Atlas layers', () => {
    const colors = ccfColorMap([
      { structureId: 997, defaultColor: 'FFFFFF' },
      { structureId: '8', defaultColor: '#bfdae3' },
    ]);
    expect(colors).toEqual(new Map([['997', '#FFFFFF'], ['8', '#bfdae3']]));
    expect(() => ccfColorMap([{ structureId: 997, defaultColor: 'white' }]))
      .toThrow('invalid ID or default color');

    const root = buildCcfLayer({
      name: 'ccf',
      segments: [CCF_ROOT_SEGMENT],
      objectAlpha: 0.18,
      meshSilhouetteRendering: 3,
      colors,
    });
    expect(root).toEqual({
      type: 'segmentation',
      source: CCF_SOURCE,
      name: 'ccf',
      objectAlpha: 0.18,
      segments: ['997'],
      meshSilhouetteRendering: 3,
      segmentColors: { '997': '#FFFFFF' },
    });

    const atlas = buildCcfLayer({
      name: 'Atlas',
      segments: [CCF_ROOT_SEGMENT],
      objectAlpha: 0.2,
      notSelectedAlpha: 0.3,
      tab: 'source',
      colors,
      allColors: true,
    });
    expect(atlas.segmentColors).toEqual({ '997': '#FFFFFF', '8': '#bfdae3' });
    expect(atlas.notSelectedAlpha).toBe(0.3);
    expect(root).not.toHaveProperty('notSelectedAlpha');
    expect(atlas.tab).toBe('source');
  });
});

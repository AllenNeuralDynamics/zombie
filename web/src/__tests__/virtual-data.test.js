import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/metadata.js', () => ({ getResolvedVersion: () => 'bdc-v0.42' }));

import { createVirtualEcephysSource } from '../ecephys/virtual-data.js';

function base64(bytes) {
  return `base64:${Buffer.from(bytes).toString('base64')}`;
}

function numericRef(values, dtype, Type) {
  const data = new Type(values);
  return {
    spec: {
      zarr_format: 2, shape: [values.length], chunks: [values.length], dtype,
      compressor: null, fill_value: 0, order: 'C', filters: null,
    },
    chunk: base64(new Uint8Array(data.buffer)),
  };
}

function stringRef(values, chars) {
  const data = new Int32Array(values.length * chars);
  values.forEach((value, i) => [...value].forEach((char, j) => { data[i * chars + j] = char.codePointAt(0); }));
  return {
    spec: {
      zarr_format: 2, shape: [values.length], chunks: [values.length], dtype: `<U${chars}`,
      compressor: null, fill_value: '', order: 'C', filters: null,
    },
    chunk: base64(new Uint8Array(data.buffer)),
  };
}

function manifest() {
  const arrays = {
    spike_times: numericRef([0.1, 0.2, 1.0, 1.2], '<f8', Float64Array),
    spike_times_index: numericRef([2n, 4n], '<i8', BigInt64Array),
    unit_name: stringRef(['u1', 'u2'], 2),
    device_name: stringRef(['Probe A', 'Probe A'], 7),
    depth: numericRef([100, 200], '<f8', Float64Array),
    num_spikes: numericRef([2n, 2n], '<i8', BigInt64Array),
    firing_rate: numericRef([1, 2], '<f8', Float64Array),
    snr: numericRef([3, 4], '<f8', Float64Array),
    default_qc: numericRef([1, 0], '|b1', Uint8Array),
    isi_violations_ratio: numericRef([0.01, 0.02], '<f8', Float64Array),
  };
  const refs = { '.zgroup': JSON.stringify({ zarr_format: 2 }) };
  const catalogArrays = {};
  for (const [name, value] of Object.entries(arrays)) {
    const path = `sessions/experiment1_recording1/units/${name}`;
    refs[`${path}/.zarray`] = JSON.stringify(value.spec);
    refs[`${path}/0`] = value.chunk;
    catalogArrays[name] = { shape: value.spec.shape, chunks: value.spec.chunks };
  }
  return {
    version: 1,
    refs,
    metadata: {
      sources: [{ group_path: 'sessions/experiment1_recording1', arrays: catalogArrays }],
    },
  };
}

describe('createVirtualEcephysSource', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(manifest()), { status: 200 })));
  });

  it('reads probes, unit metadata, and spikes from reference arrays', async () => {
    const source = await createVirtualEcephysSource('ecephys_asset');
    expect(source.kind).toBe('virtual');
    expect(await source.loadProbes()).toEqual([
      { device_name: 'Probe A', nunits: 2, nspikes: 4 },
    ]);

    const units = await source.loadUnitsMeta('Probe A');
    expect(units.map((unit) => unit.unit_name)).toEqual(['u1', 'u2']);
    expect(units[0].num_spikes).toBe(2);
    expect((await source.loadBins('Probe A')).bins.reduce((n, bin) => n + bin.n, 0)).toBe(3);
    expect((await source.loadUnitSessionPsth('Probe A', 'u1', 0.1, 1.2))
      .reduce((n, bin) => n + bin.mean * ((1.2 - 0.1) / 250), 0)).toBeCloseTo(2);
  });

  it('returns null when the published manifest is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    await expect(createVirtualEcephysSource('ecephys_asset')).resolves.toBeNull();
  });
});

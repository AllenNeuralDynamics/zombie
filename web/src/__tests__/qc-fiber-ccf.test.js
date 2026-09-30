import { describe, expect, it, vi } from 'vitest';
import {
  buildFiberCcfMetrics,
  ccfConfigUrl,
  fetchCcfNeuroglancerLink,
  fiberProbeNames,
  missingFiberCcfNames,
} from '../qc/fiber-ccf.js';
import { buildQcSubmitPayload, buildReviewRows } from '../qc/editor.js';

const STITCHED = 'SmartSPIM_820651_2026-04-08_20-37-16_stitched_2026-05-19_07-46-11';

function implant(name, deviceType = 'Fiber probe') {
  return { object_type: 'Probe implant', implanted_device: { object_type: deviceType, name } };
}

function spimRecord(overrides = {}) {
  return {
    _id: 'record-1',
    name: STITCHED,
    location: `s3://aind-open-data/${STITCHED}`,
    data_description: { modalities: [{ abbreviation: 'SPIM' }] },
    procedures: {
      subject_procedures: [
        { procedures: [implant('Fiber 0'), implant('Fiber 1'), implant('Probe A', 'Ephys probe')] },
      ],
    },
    quality_control: { metrics: [], default_grouping: ['type'] },
    ...overrides,
  };
}

describe('fiber CCF metric eligibility', () => {
  it('lists fiber probes only', () => {
    expect(fiberProbeNames(spimRecord())).toEqual(['Fiber 0', 'Fiber 1']);
  });

  it('requires a stitched SPIM asset', () => {
    expect(missingFiberCcfNames(spimRecord())).toEqual(['Fiber 0', 'Fiber 1']);
    expect(missingFiberCcfNames(spimRecord({ name: 'SmartSPIM_820651_2026-04-08_20-37-16' }))).toEqual([]);
    expect(missingFiberCcfNames(spimRecord({ data_description: { modalities: [{ abbreviation: 'FIB' }] } })))
      .toEqual([]);
  });

  it('skips fibers that already have a metric', () => {
    expect(missingFiberCcfNames(spimRecord(), new Set(['Fiber 0 CCF Location']))).toEqual(['Fiber 1']);
  });
});

describe('CCF neuroglancer link', () => {
  it('resolves the ccf_visualization config under the asset prefix', () => {
    expect(ccfConfigUrl(`s3://aind-open-data/${STITCHED}/`)).toBe(
      `https://aind-open-data.s3.amazonaws.com/${STITCHED}/image_atlas_alignment/ccf_visualization/neuroglancer_config.json`,
    );
  });

  it('returns ng_link and rejects configs without one', async () => {
    const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ng_link: 'https://ng/#!x' }) });
    await expect(fetchCcfNeuroglancerLink(`s3://aind-open-data/${STITCHED}`, { fetchImpl: ok }))
      .resolves.toBe('https://ng/#!x');
    const empty = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(fetchCcfNeuroglancerLink(`s3://aind-open-data/${STITCHED}`, { fetchImpl: empty }))
      .rejects.toThrow('ng_link');
    const missing = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchCcfNeuroglancerLink(`s3://aind-open-data/${STITCHED}`, { fetchImpl: missing }))
      .rejects.toThrow('404');
  });
});

describe('fiber CCF submission', () => {
  const metrics = buildFiberCcfMetrics(['Fiber 0'], 'https://ng/#!x');

  it('builds an unevaluated metric per fiber', () => {
    expect(metrics).toEqual([{
      name: 'Fiber 0 CCF Location',
      modality: { name: 'Selective plane illumination microscopy', abbreviation: 'SPIM' },
      stage: 'Processing',
      value: { AP: null, ML: null, DV: null },
      description: 'Location in the CCF-aligned SmartSPIM volume of the fiber probe tip in 25um index units',
      reference: 'https://ng/#!x',
      tags: { type: 'Fiber CCF Location' },
    }]);
    expect(metrics[0]).not.toHaveProperty('status_history');
  });

  it('sends added metrics as add_metrics', () => {
    const payload = buildQcSubmitPayload(spimRecord(), { expectedQcHash: 'h', addedMetrics: metrics });
    expect(payload.changes).toEqual([]);
    expect(payload.add_metrics).toEqual(metrics);
    expect(buildQcSubmitPayload(spimRecord(), { expectedQcHash: 'h' })).not.toHaveProperty('add_metrics');
  });

  it('reviews drafted status for added metrics', () => {
    const [row] = buildReviewRows(spimRecord(), spimRecord(), {
      addedMetrics: metrics, addedStatuses: { 'Fiber 0 CCF Location': 'Pass' },
    });
    expect(row.nextStatus).toBe('Pass');
  });

  it('reviews added metrics and flags ones created elsewhere', () => {
    const [row] = buildReviewRows(spimRecord(), spimRecord(), { addedMetrics: metrics });
    expect(row).toMatchObject({ name: 'Fiber 0 CCF Location', added: true, missing: false, nextStatus: 'Pending' });

    const fresh = spimRecord({
      quality_control: {
        default_grouping: ['type'],
        metrics: [{ ...metrics[0], status_history: [{ status: 'Pending', evaluator: 'x', timestamp: 't' }] }],
      },
    });
    const [conflict] = buildReviewRows(fresh, spimRecord(), { addedMetrics: metrics });
    expect(conflict).toMatchObject({ added: true, missing: true, drifted: true });
  });
});

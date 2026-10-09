import { describe, expect, it, vi } from 'vitest';
import { buildSpimQcMetrics, fetchSpimNeuroglancerLink, missingSpimQcMetrics } from '../qc/spim-metrics.js';

const record = {
  location: 's3://aind-open-data/SmartSPIM_asset',
  data_description: { data_level: 'derived' },
  instrument: { instrument_id: 'SmartSPIM' },
  acquisition: { channels: ['Ex_488_Em_525'] },
};

describe('SPIM QC references', () => {
  it('loads the root S3 config and supplies its link to all new metrics without existing QC', async () => {
    const ngLink = 'https://neuroglancer.example/#!config';
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ng_link: ngLink }) });
    const reference = await fetchSpimNeuroglancerLink(`${record.location}/`, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('https://aind-open-data.s3.amazonaws.com/SmartSPIM_asset/neuroglancer_config.json');
    const metrics = missingSpimQcMetrics(record, new Set(['Image stitching']), reference);
    expect(metrics).toHaveLength(5);
    expect(metrics.every(metric => metric.reference === ngLink)).toBe(true);
    expect(metrics.some(metric => metric.tags.channel === 'Ex_488_Em_525')).toBe(true);
    expect(metrics.some(metric => metric.name === 'Image stitching')).toBe(false);
  });

  it('does not use existing metric references', () => {
    const withQc = { ...record, quality_control: { metrics: [{
      name: 'Image and tissue quality', reference: 'https://neuroglancer.example/#!old',
    }] } };
    expect(buildSpimQcMetrics(withQc).every(metric => metric.reference === null)).toBe(true);
    expect(buildSpimQcMetrics(withQc, 'https://neuroglancer.example/#!new')
      .every(metric => metric.reference === 'https://neuroglancer.example/#!new')).toBe(true);
  });

  it.each([undefined, null, 123, '', '   '])('rejects an invalid ng_link (%s)', async ngLink => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ng_link: ngLink }) });
    await expect(fetchSpimNeuroglancerLink(record.location, { fetchImpl })).rejects.toThrow('no ng_link');
  });

  it('rejects missing configs and invalid S3 locations', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    await expect(fetchSpimNeuroglancerLink(record.location, { fetchImpl })).rejects.toThrow('404');
    fetchImpl.mockClear();
    await expect(fetchSpimNeuroglancerLink(null, { fetchImpl })).rejects.toThrow('no S3 location');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

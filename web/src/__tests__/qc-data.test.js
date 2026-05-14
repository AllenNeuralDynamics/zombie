import { describe, it, expect } from 'vitest';
import { parseQCRecord, getMetricStatus, resolveReference, buildTreeNodes, aggregateStatus } from '../qc/data.js';

const makeMetric = (overrides = {}) => ({
  name: 'test metric',
  description: 'desc',
  value: 1,
  reference: 'figures/foo.png',
  tags: { probe: 'probeA', type: 'drift' },
  stage: 'Raw data',
  modality: { abbreviation: 'ecephys', name: 'Extracellular electrophysiology' },
  status_history: [{ status: 'Pass', timestamp: '2024-01-01', user: 'user1' }],
  ...overrides,
});

describe('parseQCRecord', () => {
  it('extracts name, s3Bucket, s3Prefix', () => {
    const record = {
      name: 'my-asset',
      location: 's3://aind-open-data/my-asset',
      quality_control: { default_grouping: ['probe'], metrics: [] },
    };
    const parsed = parseQCRecord(record);
    expect(parsed.name).toBe('my-asset');
    expect(parsed.s3Bucket).toBe('aind-open-data');
    expect(parsed.s3Prefix).toBe('my-asset');
  });

  it('extracts projectName from data_description', () => {
    const record = {
      name: 'x',
      location: 's3://bucket/prefix',
      data_description: { project_name: 'MyProject' },
      quality_control: { metrics: [] },
    };
    expect(parseQCRecord(record).projectName).toBe('MyProject');
  });

  it('extracts codeOceanId from other_identifiers', () => {
    const record = {
      name: 'x',
      location: 's3://bucket/prefix',
      other_identifiers: { 'Code Ocean': ['co-123'] },
      quality_control: { metrics: [] },
    };
    expect(parseQCRecord(record).codeOceanId).toBe('co-123');
  });

  it('decodes json: prefixed tags', () => {
    const record = {
      name: 'x',
      location: 's3://bucket/prefix',
      quality_control: {
        metrics: [{ ...makeMetric(), tags: 'json:{"probe":"probeB"}' }],
      },
    };
    const parsed = parseQCRecord(record);
    expect(parsed.metrics[0].tags.probe).toBe('probeB');
  });

  it('decodes json: prefixed value', () => {
    const record = {
      name: 'x',
      location: 's3://bucket/prefix',
      quality_control: {
        metrics: [{ ...makeMetric(), value: 'json:[1,2,3]' }],
      },
    };
    const parsed = parseQCRecord(record);
    expect(parsed.metrics[0].value).toEqual([1, 2, 3]);
  });

  it('collects unique modalities and stages', () => {
    const record = {
      name: 'x',
      location: 's3://bucket/prefix',
      quality_control: {
        metrics: [
          makeMetric({ modality: { abbreviation: 'ecephys' }, stage: 'Raw data' }),
          makeMetric({ modality: { abbreviation: 'fib' }, stage: 'Processed' }),
        ],
      },
    };
    const parsed = parseQCRecord(record);
    expect(parsed.modalities).toContain('ecephys');
    expect(parsed.modalities).toContain('fib');
    expect(parsed.stages).toContain('Raw data');
    expect(parsed.stages).toContain('Processed');
  });
});

describe('getMetricStatus', () => {
  it('returns last status from history', () => {
    const m = makeMetric({ status_history: [{ status: 'Pass' }, { status: 'Fail' }] });
    expect(getMetricStatus(m)).toBe('Fail');
  });

  it('returns Pending when history is empty', () => {
    const m = makeMetric({ status_history: [] });
    expect(getMetricStatus(m)).toBe('Pending');
  });

  it('returns Pending when status_history is missing', () => {
    const m = { name: 'x' };
    expect(getMetricStatus(m)).toBe('Pending');
  });
});

describe('aggregateStatus', () => {
  it('returns Fail if any metric is Fail', () => {
    const metrics = [
      makeMetric({ status_history: [{ status: 'Pass' }] }),
      makeMetric({ status_history: [{ status: 'Fail' }] }),
    ];
    expect(aggregateStatus(metrics)).toBe('Fail');
  });

  it('returns Pending if any metric is Pending and none Fail', () => {
    const metrics = [
      makeMetric({ status_history: [{ status: 'Pass' }] }),
      makeMetric({ status_history: [] }),
    ];
    expect(aggregateStatus(metrics)).toBe('Pending');
  });

  it('returns Pass if all Pass', () => {
    const metrics = [
      makeMetric({ status_history: [{ status: 'Pass' }] }),
      makeMetric({ status_history: [{ status: 'Pass' }] }),
    ];
    expect(aggregateStatus(metrics)).toBe('Pass');
  });
});

describe('resolveReference', () => {
  const bucket = 'aind-open-data';
  const prefix = 'my-asset';

  it('resolves relative path to S3 HTTPS URL', () => {
    const { url, type } = resolveReference('figures/drift.png', bucket, prefix);
    expect(url).toBe('https://aind-open-data.s3.us-west-2.amazonaws.com/my-asset/figures/drift.png');
    expect(type).toBe('image');
  });

  it('strips leading slash from relative reference', () => {
    const { url } = resolveReference('/figures/img.jpg', bucket, prefix);
    expect(url).toContain('my-asset/figures/img.jpg');
  });

  it('strips results/ prefix from relative reference', () => {
    const { url } = resolveReference('results/figures/img.png', bucket, prefix);
    expect(url).toContain('my-asset/figures/img.png');
  });

  it('classifies video extensions', () => {
    expect(resolveReference('vid.mp4', bucket, prefix).type).toBe('video');
    expect(resolveReference('vid.webm', bucket, prefix).type).toBe('video');
  });

  it('classifies pdf', () => {
    expect(resolveReference('doc.pdf', bucket, prefix).type).toBe('pdf');
  });

  it('classifies neuroglancer URL as iframe', () => {
    const ref = 'https://neuroglancer-demo.appspot.com/#!{}';
    expect(resolveReference(ref, bucket, prefix).type).toBe('iframe');
  });

  it('classifies sortingview URL as iframe', () => {
    const ref = 'https://sortingview.vercel.app/figurl?v=1';
    expect(resolveReference(ref, bucket, prefix).type).toBe('iframe');
  });

  it('wraps .rrd as rerun iframe URL', () => {
    const ref = 'figures/output_v0.19.1.rrd';
    const { url, type } = resolveReference(ref, bucket, prefix);
    expect(type).toBe('iframe');
    expect(url).toContain('app.rerun.io/version/0.19.1');
    expect(url).toContain(encodeURIComponent('https://aind-open-data.s3.us-west-2.amazonaws.com/my-asset/figures/output_v0.19.1.rrd'));
  });

  it('classifies http links without known extension as link', () => {
    const ref = 'https://example.com/dashboard';
    expect(resolveReference(ref, bucket, prefix).type).toBe('link');
  });

  it('returns multi type for semicolon references', () => {
    expect(resolveReference('a.png;b.png', bucket, prefix).type).toBe('multi');
  });

  it('resolves s3:// reference to HTTPS', () => {
    const ref = 's3://other-bucket/path/img.png';
    const { url, type } = resolveReference(ref, bucket, prefix);
    expect(url).toBe('https://other-bucket.s3.us-west-2.amazonaws.com/path/img.png');
    expect(type).toBe('image');
  });
});

describe('buildTreeNodes', () => {
  it('builds two-level hierarchy from probe/type grouping', () => {
    const metrics = [
      makeMetric({ tags: { probe: 'probeA', type: 'drift' } }),
      makeMetric({ tags: { probe: 'probeA', type: 'noise' } }),
      makeMetric({ tags: { probe: 'probeB', type: 'drift' } }),
    ];
    const nodes = buildTreeNodes(metrics, ['probe', 'type']);
    expect(nodes.length).toBe(2);
    const probeA = nodes.find(n => n.value === 'probeA');
    expect(probeA).toBeDefined();
    expect(probeA.children.length).toBe(2);
  });

  it('prepends modality level when multiple modalities exist', () => {
    const metrics = [
      makeMetric({ modality: { abbreviation: 'ecephys' }, tags: { probe: 'probeA' } }),
      makeMetric({ modality: { abbreviation: 'fib' }, tags: { probe: 'probeA' } }),
    ];
    const nodes = buildTreeNodes(metrics, ['probe']);
    expect(nodes[0].key).toBe('modality');
  });

  it('does not prepend modality when single modality', () => {
    const metrics = [
      makeMetric({ modality: { abbreviation: 'ecephys' }, tags: { probe: 'probeA' } }),
      makeMetric({ modality: { abbreviation: 'ecephys' }, tags: { probe: 'probeB' } }),
    ];
    const nodes = buildTreeNodes(metrics, ['probe']);
    expect(nodes[0].key).toBe('probe');
  });

  it('groups metrics with missing tag value under unknown', () => {
    const metrics = [
      makeMetric({ tags: {} }),
    ];
    const nodes = buildTreeNodes(metrics, ['probe']);
    expect(nodes[0].value).toBe('unknown');
  });
});

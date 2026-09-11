import { describe, it, expect } from 'vitest';
import {
  parseQCRecord,
  buildCachedLineageRecords,
  getMetricStatus,
  resolveReference,
  buildTreeNodes,
  aggregateStatus,
  filterMetricsByStage,
  parseCachedMetricRow,
  metricStageBucket,
} from '../qc/data.js';

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

  it('extracts rawAssetName from data_description.source_data', () => {
    const record = {
      name: 'derived-asset',
      location: 's3://bucket/prefix',
      data_description: { source_data: ['raw-asset-name'] },
      quality_control: { metrics: [] },
    };
    expect(parseQCRecord(record).rawAssetName).toBe('raw-asset-name');
  });

  it('returns empty rawAssetName when source_data is absent', () => {
    const record = { name: 'x', location: 's3://bucket/prefix', quality_control: { metrics: [] } };
    expect(parseQCRecord(record).rawAssetName).toBe('');
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

  it('keeps s3 sources in a Neuroglancer URL fragment inside the iframe URL', () => {
    const ref = 'https://neuroglancer-demo.appspot.com/#!{"layers":[{"source":"precomputed://s3://bucket/path"}]}';
    expect(resolveReference(ref, 'private-bucket', prefix)).toEqual({ url: ref, type: 'iframe' });
  });

  it('classifies sortingview URL as iframe', () => {
    const ref = 'https://sortingview.vercel.app/figurl?v=1';
    expect(resolveReference(ref, bucket, prefix).type).toBe('iframe');
  });

  it('classifies ephys.allenneuraldynamics.org URL as iframe', () => {
    const ref = 'https://ephys.allenneuraldynamics.org/app?a=1';
    expect(resolveReference(ref, bucket, prefix).type).toBe('iframe');
  });

  it('decodes QC Portal percent-encoded HTTP references before classifying them', () => {
    const ref = 'https%3A//ephys.allenneuraldynamics.org/app%3Fraw%3D%7Braw_asset_location%7D';
    const { url, type } = resolveReference(ref, bucket, prefix, 's3://raw-bucket/raw-prefix');
    expect(url).toBe('https://ephys.allenneuraldynamics.org/app?raw=s3://raw-bucket/raw-prefix');
    expect(type).toBe('iframe');
  });

  it('substitutes {derived_asset_location} placeholder in ephys URLs', () => {
    const ref = 'https://ephys.allenneuraldynamics.org/app?loc=%7Bderived_asset_location%7D';
    const { url } = resolveReference(ref, 'my-bucket', 'my-prefix');
    expect(url).toContain('s3://my-bucket/my-prefix');
    expect(url).not.toContain('{derived_asset_location}');
  });

  it('substitutes {raw_asset_location} placeholder when rawS3Loc is provided', () => {
    const ref = 'https://ephys.allenneuraldynamics.org/app?raw=%7Braw_asset_location%7D';
    const { url } = resolveReference(ref, 'my-bucket', 'my-prefix', 's3://raw-bucket/raw-prefix');
    expect(url).toContain('s3://raw-bucket/raw-prefix');
    expect(url).not.toContain('{raw_asset_location}');
  });

  it('removes {raw_asset_location} placeholder when rawS3Loc is absent', () => {
    const ref = 'https://ephys.allenneuraldynamics.org/app?raw=%7Braw_asset_location%7D';
    const { url } = resolveReference(ref, 'my-bucket', 'my-prefix');
    expect(url).not.toContain('{raw_asset_location}');
    expect(url).not.toContain('%7B');
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

  it('groups by stage using the first-class stage field, not tags', () => {
    const metrics = [
      makeMetric({ stage: 'Raw data', tags: {} }),
      makeMetric({ stage: 'Raw data', tags: {} }),
      makeMetric({ stage: 'Processed', tags: {} }),
    ];
    const nodes = buildTreeNodes(metrics, ['stage']);
    expect(nodes.length).toBe(2);
    const vals = nodes.map(n => n.value).sort();
    expect(vals).toEqual(['Processed', 'Raw data']);
  });

  it('falls back to tags.stage when stage field is absent', () => {
    const metrics = [
      { ...makeMetric({ stage: undefined }), tags: { stage: 'Curated' } },
    ];
    const nodes = buildTreeNodes(metrics, ['stage']);
    expect(nodes[0].value).toBe('Curated');
  });

  it('automatically creates ordered top-level stage sections for mixed stages', () => {
    const metrics = [
      makeMetric({ name: 'analysis', stage: 'Analysis', tags: {} }),
      makeMetric({ name: 'processing', stage: 'Processing', tags: {} }),
      makeMetric({ name: 'raw', stage: 'Raw data', tags: {} }),
    ];
    const nodes = buildTreeNodes(metrics, []);

    expect(nodes.map(node => [node.key, node.value, node.label])).toEqual([
      ['stage', 'raw', 'Raw'],
      ['stage', 'processing', 'Processed'],
      ['stage', 'analysis', 'Analysis'],
    ]);
    expect(nodes.map(node => node.kind)).toEqual(['stage', 'stage', 'stage']);
  });

  it('does not add a redundant stage section after a stage filter', () => {
    const metrics = [
      makeMetric({ name: 'raw', stage: 'Raw data', tags: { type: 'raw' } }),
      makeMetric({ name: 'processing', stage: 'Processing', tags: { type: 'processing' } }),
    ];
    const nodes = buildTreeNodes(filterMetricsByStage(metrics, 'processing'), ['type']);

    expect(nodes).toHaveLength(1);
    expect(nodes[0].key).toBe('type');
    expect(metricStageBucket(metrics[1])).toBe('processing');
  });
});

describe('cached QC metrics', () => {
  it('reconstructs the full metric and its hidden lineage metadata from a cache row', () => {
    const metric = parseCachedMetricRow({
      metric_json: JSON.stringify({
        object_type: 'QC metric',
        name: 'metric',
        value: { type: 'dropdown', value: 'good', options: ['good'], status: ['Pass'] },
        status_history: [{ status: 'Pass' }],
      }),
      asset_name: 'derived',
      asset_location: 's3://bucket/derived',
      downstream_asset_names: '["latest"]',
    });
    expect(metric.name).toBe('metric');
    expect(metric.value.type).toBe('dropdown');
    expect(metric.assetName).toBe('derived');
    expect(metric.assetLocation).toBe('s3://bucket/derived');
    expect(metric.downstreamAssetNames).toEqual(['latest']);
  });

  it('filters raw, processing, and analysis metrics while retaining all by default', () => {
    const metrics = [
      makeMetric({ name: 'raw', stage: 'Raw data' }),
      makeMetric({ name: 'processing', stage: 'Processing' }),
      makeMetric({ name: 'analysis', stage: 'Analysis' }),
    ];
    expect(filterMetricsByStage(metrics, 'raw').map(metric => metric.name)).toEqual(['raw']);
    expect(filterMetricsByStage(metrics, 'processing').map(metric => metric.name)).toEqual(['processing']);
    expect(filterMetricsByStage(metrics, 'analysis').map(metric => metric.name)).toEqual(['analysis']);
    expect(filterMetricsByStage(metrics, 'all')).toEqual(metrics);
  });

  it('builds a lightweight review baseline for each metric origin and downstream asset', () => {
    const records = buildCachedLineageRecords([
      {
        name: 'drift',
        asset_name: 'raw',
        downstream_asset_names: ['processed'],
        metric_key: 'drift-key',
        metric_json: JSON.stringify({ name: 'drift', value: 0.5, status_history: [{ status: 'Pass' }] }),
      },
    ], { name: 'raw', _id: 'raw-id', quality_control: { metrics: [], notes: 'notes' } });
    expect(records.map(record => record.name)).toEqual(['raw', 'processed']);
    expect(records.find(record => record.name === 'processed').quality_control.metrics[0].value).toBe(0.5);
    expect(records.find(record => record.name === 'processed')._cachedSnapshot).toBe(true);
  });
});

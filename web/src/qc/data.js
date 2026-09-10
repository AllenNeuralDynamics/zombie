export function parseQCRecord(record) {
  const qc = record.quality_control ?? {};
  const metrics = (qc.metrics ?? []).map(normalizeMetric);
  const defaultGrouping = qc.default_grouping ?? [];

  const location = record.location ?? '';
  let s3Bucket = '';
  let s3Prefix = '';
  const s3Match = location.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (s3Match) {
    s3Bucket = s3Match[1];
    s3Prefix = s3Match[2].replace(/\/+$/, '');
  }

  const modalities = [...new Set(metrics.map(m => m.modality?.abbreviation).filter(Boolean))];
  const stages = [...new Set(metrics.map(m => m.stage).filter(Boolean))];

  const dd = record.data_description ?? {};
  const projectName = dd.project_name ?? '';

  const coIds = record.other_identifiers?.['Code Ocean'] ?? [];
  const codeOceanId = coIds[0] ?? '';

  const sourceData = record.data_description?.source_data ?? [];
  const rawAssetName = (Array.isArray(sourceData) ? sourceData[0] : sourceData) ?? '';

  const notes = qc.notes ?? '';

  return { name: record.name ?? '', s3Bucket, s3Prefix, projectName, codeOceanId, rawAssetName, modalities, stages, metrics, defaultGrouping, notes };
}

/**
 * Detect the custom metric value shapes from aind-qcportal-schema (DropdownMetric,
 * CheckboxMetric). Mirrors CustomMetricValue.is_custom_metric in the Panel app.
 */
export function isCustomMetric(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val) &&
    ('type' in val || 'rule' in val);
}

function decodeJsonField(val) {
  if (typeof val === 'string' && val.startsWith('json:')) {
    try { return JSON.parse(val.slice(5)); } catch { return val; }
  }
  return val;
}

function decodeCachedJsonField(val) {
  if (typeof val !== 'string') return val;
  const decoded = decodeJsonField(val);
  if (decoded !== val) return decoded;
  try { return JSON.parse(val); } catch { return val; }
}

function normalizeMetric(metric) {
  const tags = decodeJsonField(metric.tags ?? {});
  const value = decodeJsonField(metric.value);
  return { ...metric, tags: tags ?? {}, value };
}

/**
 * Rehydrate one row from the lineage-aware cache into the metric shape used by
 * the existing renderer.  Rendering metadata is kept as non-schema properties
 * so the visible metric and editor contracts remain unchanged.
 */
export function parseCachedMetricRow(row) {
  let metric = decodeCachedJsonField(row.metric_json);
  if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
    metric = {
      name: row.name,
      stage: row.stage,
      modality: row.modality ? { abbreviation: row.modality, name: row.modality } : null,
      value: decodeCachedJsonField(row.value),
      status_history: row.status ? [{ status: row.status }] : [],
      description: row.description,
      reference: row.reference,
      tags: decodeCachedJsonField(row.tags),
      object_type: row.object_type,
      type: row.type,
      evaluated_assets: decodeCachedJsonField(row.evaluated_assets),
    };
  }
  metric = normalizeMetric(metric);
  if (!metric.status_history?.length && row.status) {
    metric.status_history = [{ status: row.status }];
  }
  metric.assetName = row.asset_name ?? '';
  metric.rawAssetName = row.raw_asset_name ?? '';
  metric.assetLocation = row.asset_location ?? '';
  metric.assetDataLevel = row.asset_data_level ?? '';
  metric.downstreamAssetNames = Array.isArray(row.downstream_asset_names)
    ? row.downstream_asset_names
    : decodeCachedJsonField(row.downstream_asset_names) ?? [];
  metric.metricKey = row.metric_key ?? '';
  return metric;
}

/** Build a lightweight review baseline for lineage assets from cached rows. */
export function buildCachedLineageRecords(rows, rawRecord) {
  const records = new Map();
  if (rawRecord?.name) records.set(rawRecord.name, rawRecord);
  for (const row of rows) {
    const metric = parseCachedMetricRow(row);
    const { assetName, rawAssetName, assetLocation, assetDataLevel, downstreamAssetNames, metricKey, ...sourceMetric } = metric;
    const names = [assetName, ...(downstreamAssetNames ?? [])].filter(Boolean);
    for (const name of names) {
      if (name === rawRecord?.name) continue;
      if (!records.has(name)) {
        records.set(name, {
          _id: `cached-${name}`,
          name,
          _cachedSnapshot: true,
          quality_control: { metrics: [], notes: '' },
        });
      }
      const target = records.get(name);
      const key = metricKey || `${sourceMetric.name}|${sourceMetric.stage}|${sourceMetric.modality?.abbreviation ?? ''}`;
      if (!target.quality_control.metrics.some(candidate => candidate._qcCacheMetricKey === key)) {
        sourceMetric._qcCacheMetricKey = key;
        target.quality_control.metrics.push(sourceMetric);
      }
    }
  }
  return [...records.values()];
}

function stageBucket(stage) {
  const value = String(stage ?? '').toLowerCase();
  if (value.includes('raw') || value.includes('acquisition')) return 'raw';
  if (value.includes('process')) return 'processing';
  if (value.includes('analys')) return 'analysis';
  return 'other';
}

/** Filter cached or DocDB metrics by the user-facing stage categories. */
export function filterMetricsByStage(metrics, filter = 'all') {
  if (!filter || filter === 'all') return metrics;
  const normalizedFilter = filter === 'processed' ? 'processing' : filter;
  return metrics.filter(metric => stageBucket(metric.stage) === normalizedFilter);
}

export function getMetricStatus(metric) {
  const history = metric.status_history ?? [];
  if (!history.length) return 'Pending';
  return history[history.length - 1].status ?? 'Pending';
}

export function aggregateStatus(metrics) {
  const statuses = metrics.map(getMetricStatus);
  if (statuses.includes('Fail')) return 'Fail';
  if (statuses.includes('Pending')) return 'Pending';
  return 'Pass';
}

function cleanRef(ref) {
  return ref.replace(/^\//, '').replace(/^results\//, '');
}

function encodeS3Key(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function resolveReference(reference, s3Bucket, s3Prefix, rawS3Loc = '') {
  if (!reference) return { url: '', type: 'text' };

  if (reference.includes(';')) {
    return { url: reference, type: 'multi' };
  }

  let url = reference;

  if (reference.includes('s3://')) {
    const match = reference.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (match) {
      url = `https://${match[1]}.s3.us-west-2.amazonaws.com/${encodeS3Key(match[2])}`;
    }
  } else if (!reference.startsWith('http')) {
    const cleaned = cleanRef(reference);
    url = `https://${s3Bucket}.s3.us-west-2.amazonaws.com/${encodeS3Key(s3Prefix)}/${encodeS3Key(cleaned)}`;
  }

  const lower = url.toLowerCase();

  if (lower.includes('ephys.allenneuraldynamics.org')) {
    // Decode URL-encoded placeholders, then substitute asset locations.
    let processed = decodeURIComponent(url);
    processed = processed.replace(/\{derived_asset_location\}/g, `s3://${s3Bucket}/${s3Prefix}`);
    if (rawS3Loc) {
      processed = processed.replace(/\{raw_asset_location\}/g, rawS3Loc);
    } else {
      processed = processed.replace(/\{raw_asset_location\}/g, '');
    }
    return { url: processed, type: 'iframe' };
  }

  if (lower.includes('neuroglancer') || lower.includes('sortingview') || lower.includes('figurl')) {
    return { url, type: 'iframe' };
  }

  if (lower.includes('.rrd')) {
    const verMatch = reference.match(/_v(\d+\.\d+\.\d+)\.rrd/);
    const version = verMatch ? verMatch[1] : '0.19.1';
    const iframeUrl = `https://app.rerun.io/version/${version}/index.html?url=${encodeURIComponent(url)}`;
    return { url: iframeUrl, type: 'iframe' };
  }

  const ext = lower.split('?')[0].split('#')[0].split('.').pop();

  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'tiff'].includes(ext)) {
    return { url, type: 'image' };
  }
  if (['mp4', 'avi', 'webm'].includes(ext)) {
    return { url, type: 'video' };
  }
  if (ext === 'pdf') {
    return { url, type: 'pdf' };
  }
  if (['h5', 'hdf5'].includes(ext)) {
    return { url, type: 'h5' };
  }

  if (reference.startsWith('http')) {
    return { url, type: 'link' };
  }

  return { url, type: 'text' };
}

export function buildTreeNodes(metrics, defaultGrouping) {
  const modalities = [...new Set(metrics.map(m => m.modality?.abbreviation).filter(Boolean))];
  const grouping = modalities.length > 1 ? ['modality', ...defaultGrouping] : defaultGrouping;

  function buildLevel(metricSubset, levels) {
    if (!levels.length) {
      return { metrics: metricSubset, children: [] };
    }
    const [level, ...rest] = levels;
    const groups = new Map();
    for (const m of metricSubset) {
      let val;
      if (level === 'modality') {
        val = m.modality?.abbreviation ?? 'unknown';
      } else if (level === 'stage') {
        val = m.stage ?? (m.tags ?? {})['stage'] ?? 'unknown';
      } else {
        val = (m.tags ?? {})[level] ?? 'unknown';
      }
      if (!groups.has(val)) groups.set(val, []);
      groups.get(val).push(m);
    }
    const children = [];
    for (const [val, subset] of groups) {
      const node = buildLevel(subset, rest);
      children.push({ label: `${level}: ${val}`, key: level, value: val, metrics: subset, ...node });
    }
    return { metrics: metricSubset, children };
  }

  const root = buildLevel(metrics, grouping);
  return root.children;
}

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
    s3Prefix = s3Match[2];
  }

  const modalities = [...new Set(metrics.map(m => m.modality?.abbreviation).filter(Boolean))];
  const stages = [...new Set(metrics.map(m => m.stage).filter(Boolean))];

  const dd = record.data_description ?? {};
  const projectName = dd.project_name ?? '';

  const coIds = record.other_identifiers?.['Code Ocean'] ?? [];
  const codeOceanId = coIds[0] ?? '';

  const rawAssetName = record.data_description?.source_data?.[0] ?? '';

  return { name: record.name ?? '', s3Bucket, s3Prefix, projectName, codeOceanId, rawAssetName, modalities, stages, metrics, defaultGrouping };
}

function decodeJsonField(val) {
  if (typeof val === 'string' && val.startsWith('json:')) {
    try { return JSON.parse(val.slice(5)); } catch { return val; }
  }
  return val;
}

function normalizeMetric(metric) {
  const tags = decodeJsonField(metric.tags ?? {});
  const value = decodeJsonField(metric.value);
  return { ...metric, tags: tags ?? {}, value };
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

export function resolveReference(reference, s3Bucket, s3Prefix, rawS3Loc = '') {
  if (!reference) return { url: '', type: 'text' };

  if (reference.includes(';')) {
    return { url: reference, type: 'multi' };
  }

  let url = reference;

  if (reference.includes('s3://')) {
    const match = reference.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (match) {
      url = `https://${match[1]}.s3.us-west-2.amazonaws.com/${match[2]}`;
    }
  } else if (!reference.startsWith('http')) {
    const cleaned = cleanRef(reference);
    url = `https://${s3Bucket}.s3.us-west-2.amazonaws.com/${s3Prefix}/${cleaned}`;
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

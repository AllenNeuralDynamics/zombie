export function parseQCRecord(record) {
  const qc = record.quality_control ?? {};
  const metrics = [];
  const metricErrors = [];
  const rawMetrics = qc.metrics ?? [];
  if (!Array.isArray(rawMetrics)) {
    metricErrors.push('QC metrics could not be processed: expected an array.');
  } else {
    const normalized = [];
    rawMetrics.forEach((metric, index) => {
      try {
        if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
          throw new Error('Metric entry is not an object.');
        }
        const parsedMetric = normalizeMetric(metric);
        normalized.push(parsedMetric);
        if (typeof parsedMetric.reference === 'string' && parsedMetric.reference) {
          const parts = parsedMetric.reference.split(';').map(part => part.trim()).filter(Boolean);
          if (parts.some(part => normalizeReference(part) !== part)) {
            metricErrors.push(`Metric "${parsedMetric.name ?? index + 1}": the media path had to be normalized for display. Please report this to the owner of the processing pipeline so they can fix the QCMetric.reference.`);
          }
        }
      } catch (error) {
        let label = '';
        try {
          if (typeof metric?.name === 'string' && metric.name) label = ` "${metric.name}"`;
        } catch {
          // A malformed name accessor must not defeat per-metric error handling.
        }
        metricErrors.push(`Metric${label} at position ${index + 1} could not be processed: ${error?.message ?? error}`);
      }
    });

    const counts = new Map();
    for (const metric of normalized) {
      if (typeof metric.name === 'string' && metric.name) {
        counts.set(metric.name, (counts.get(metric.name) ?? 0) + 1);
      }
    }
    const duplicateNames = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
    for (const name of duplicateNames) {
      metricErrors.push(`Duplicate QC metric name "${name}"; all metrics with this name were omitted.`);
    }
    metrics.push(...normalized.filter(metric => !duplicateNames.has(metric.name)));
  }
  const defaultGrouping = qc.default_grouping ?? [];
  const allowTagFailures = Array.isArray(qc.allow_tag_failures)
    ? qc.allow_tag_failures.filter(value => typeof value === 'string')
    : [];

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

  const notes = qc.notes ?? '';

  return {
    name: record.name ?? '',
    s3Bucket,
    s3Prefix,
    projectName,
    codeOceanId,
    rawAssetName,
    modalities,
    stages,
    metrics,
    metricErrors,
    defaultGrouping,
    allowTagFailures,
    notes,
  };
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

/**
 * Decode references that were URL-encoded before being stored in DocDB.
 *
 * Ephys curation references are commonly encoded as one complete URL
 * (`https%3A//...%3Fanalyzer_path%3D...`).  Decode at most twice so an
 * already-normal URL is unchanged while nested encoding remains usable.
 */
export function decodeReferenceUrl(reference) {
  let decoded = String(reference ?? '');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

/** Decode CurationMetric values and retain their original list indexes. */
export function parseCurationEntries(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source.startsWith('json:') ? source.slice(5) : source); } catch { return []; }
  }
  if (!Array.isArray(source)) source = source && typeof source === 'object' ? [source] : [];
  return source.flatMap((entry, index) => {
    let parsed = entry;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed.startsWith('json:') ? parsed.slice(5) : parsed); } catch { return []; }
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? [{ value: parsed, index }]
      : [];
  });
}

/** Decode the list-of-JSON-dictionaries used by CurationMetric values. */
export function parseCurationValues(value) {
  return parseCurationEntries(value).map(entry => entry.value);
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

export function aggregateStatus(metrics, allowTagFailures = [], statusOverrides = {}) {
  const allowedValues = new Set(allowTagFailures);
  const statuses = metrics
    .filter(metric => !Object.values(metric.tags ?? {}).some(value => allowedValues.has(value)))
    .map(metric => statusOverrides[metric.name] ?? getMetricStatus(metric));
  if (statuses.includes('Fail')) return 'Fail';
  if (statuses.includes('Pending')) return 'Pending';
  return 'Pass';
}

/** Apply the QC Portal's media-path repairs without changing stored references. */
export function normalizeReference(reference) {
  let normalized = decodeReferenceUrl(reference).replace(/^\/+/, '');
  if (/^(https?:|s3:\/\/)/i.test(normalized)) return normalized;
  const resultsIndex = normalized.indexOf('results/');
  if (resultsIndex !== -1) normalized = normalized.slice(resultsIndex + 'results/'.length);
  return normalized.split('/').filter(part => part && part !== '.').join('/');
}

function encodeS3Key(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

export function resolveReference(reference, s3Bucket, s3Prefix, rawS3Loc = '') {
  if (!reference) return { url: '', type: 'text' };

  if (reference.includes(';')) {
    return { url: reference, type: 'multi' };
  }

  const decodedReference = normalizeReference(reference);
  let url = decodedReference;

  if (decodedReference.includes('s3://')) {
    const match = decodedReference.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (match) {
      url = `https://${match[1]}.s3.us-west-2.amazonaws.com/${encodeS3Key(match[2])}`;
    }
  } else if (!/^https?:/i.test(decodedReference)) {
    url = `https://${s3Bucket}.s3.us-west-2.amazonaws.com/${encodeS3Key(s3Prefix)}/${encodeS3Key(decodedReference)}`;
  }

  const lower = url.toLowerCase();

  if (lower.includes('ephys.allenneuraldynamics.org')) {
    // Decode URL-encoded placeholders, then substitute asset locations.
    let processed = decodeReferenceUrl(url);
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
    const verMatch = decodedReference.match(/_v(\d+\.\d+\.\d+)\.rrd/);
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

  if (/^https?:/i.test(decodedReference)) {
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

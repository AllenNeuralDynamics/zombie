import { getMetricStatus } from './data.js';
import { renderMedia } from './media.js';

function parseMarkdownLinks(text) {
  if (!text) return '';
  return String(text).replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function statusDotClass(status) {
  if (status === 'Pass') return 'pass';
  if (status === 'Fail') return 'fail';
  return 'pending';
}

function renderValue(val) {
  if (val === null || val === undefined) return document.createTextNode('—');

  if (typeof val === 'boolean' || typeof val === 'number') {
    return document.createTextNode(String(val));
  }

  if (typeof val === 'string') {
    return document.createTextNode(val);
  }

  if (Array.isArray(val)) {
    // Arrays of objects (e.g., curation history): show the last (most recent) entry as JSON.
    if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
      const latest = val[val.length - 1];
      const pre = document.createElement('pre');
      pre.className = 'qc-value-json';
      pre.textContent = JSON.stringify(latest, null, 2);
      if (val.length > 1) {
        const note = document.createElement('p');
        note.className = 'metric-tags';
        note.textContent = `Showing latest of ${val.length} curation entries.`;
        const wrap = document.createElement('div');
        wrap.appendChild(note);
        wrap.appendChild(pre);
        return wrap;
      }
      return pre;
    }
    const table = document.createElement('table');
    table.className = 'qc-value-table';
    const thead = table.createTHead();
    const hrow = thead.insertRow();
    const th = document.createElement('th');
    th.textContent = 'values';
    hrow.appendChild(th);
    const tbody = table.createTBody();
    for (const item of val) {
      const row = tbody.insertRow();
      row.insertCell().textContent = String(item);
    }
    return table;
  }

  if (typeof val === 'object') {
    const entries = Object.entries(val);
    const listsOnly = entries.every(([, v]) => Array.isArray(v));
    if (listsOnly && entries.length) {
      const lengths = entries.map(([, v]) => v.length);
      const allSame = lengths.every(l => l === lengths[0]);
      if (allSame) {
        const indexKey = entries.find(([k]) => k.toLowerCase() === 'index')?.[0];
        const cols = entries.filter(([k]) => k !== indexKey);
        const table = document.createElement('table');
        table.className = 'qc-value-table';
        const thead = table.createTHead();
        const hrow = thead.insertRow();
        if (indexKey) {
          const th = document.createElement('th');
          th.textContent = indexKey;
          hrow.appendChild(th);
        }
        for (const [k] of cols) {
          const th = document.createElement('th');
          th.textContent = k;
          hrow.appendChild(th);
        }
        const tbody = table.createTBody();
        const rowCount = cols[0][1].length;
        for (let i = 0; i < rowCount; i++) {
          const row = tbody.insertRow();
          if (indexKey) row.insertCell().textContent = String(val[indexKey][i]);
          for (const [, v] of cols) row.insertCell().textContent = String(v[i]);
        }
        return table;
      }
    }
    const pre = document.createElement('pre');
    pre.className = 'qc-value-json';
    pre.textContent = JSON.stringify(val, null, 2);
    return pre;
  }

  return document.createTextNode(String(val));
}

function buildMetricCard(metric) {
  const card = document.createElement('div');
  const isCuration = metric.object_type === 'Curation metric';
  card.className = isCuration ? 'qc-metric-card qc-metric-curation' : 'qc-metric-card';

  const name = document.createElement('div');
  name.className = 'metric-name';
  name.textContent = metric.name ?? '';
  card.appendChild(name);

  // Show curation type badge (e.g., "Spike sorting curation")
  if (isCuration && metric.type) {
    const badge = document.createElement('div');
    badge.className = 'metric-curation-type';
    badge.textContent = metric.type;
    card.appendChild(badge);
  }

  if (metric.description) {
    const desc = document.createElement('div');
    desc.className = 'metric-desc';
    desc.innerHTML = parseMarkdownLinks(metric.description);
    card.appendChild(desc);
  }

  const tags = metric.tags ?? {};
  const tagKeys = Object.keys(tags);
  if (tagKeys.length) {
    const tagsEl = document.createElement('div');
    tagsEl.className = 'metric-tags';
    tagsEl.textContent = tagKeys.map(k => `${k}: ${tags[k]}`).join(' · ');
    card.appendChild(tagsEl);
  }

  if (metric.modality || metric.stage) {
    const meta = document.createElement('div');
    meta.className = 'metric-tags';
    const parts = [];
    if (metric.modality?.name) parts.push(`modality: ${metric.modality.name}`);
    if (metric.stage) parts.push(`stage: ${metric.stage}`);
    meta.textContent = parts.join(' · ');
    card.appendChild(meta);
  }

  const valEl = document.createElement('div');
  valEl.className = 'metric-value';
  valEl.appendChild(renderValue(metric.value));
  card.appendChild(valEl);

  const status = getMetricStatus(metric);
  const statusEl = document.createElement('div');
  statusEl.className = 'metric-status';
  const dot = document.createElement('span');
  dot.className = `status-dot ${statusDotClass(status)}`;
  statusEl.appendChild(dot);
  statusEl.appendChild(document.createTextNode(status));
  card.appendChild(statusEl);

  return card;
}

export function renderMetrics(metrics, s3Bucket, s3Prefix, assetName, rawS3Loc = '') {
  const container = document.createElement('div');
  container.className = 'qc-accordion';

  const groups = new Map();
  for (const m of metrics) {
    const ref = m.reference ?? '';
    if (!groups.has(ref)) groups.set(ref, []);
    groups.get(ref).push(m);
  }

  let first = true;
  for (const [ref, groupMetrics] of groups) {
    const details = document.createElement('details');
    if (first) { details.open = true; first = false; }

    const summary = document.createElement('summary');
    const refLabel = ref ? ref.split('/').pop() || ref : 'No reference';
    summary.textContent = `${refLabel} (${groupMetrics.length} metric${groupMetrics.length !== 1 ? 's' : ''})`;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'accordion-body';

    const leftCol = document.createElement('div');
    leftCol.className = 'accordion-metrics';
    for (const m of groupMetrics) {
      leftCol.appendChild(buildMetricCard(m));
    }

    body.appendChild(leftCol);

    if (ref) {
      const media = renderMedia(ref, s3Bucket, s3Prefix, assetName, rawS3Loc);
      body.appendChild(media);
    }

    details.appendChild(body);
    container.appendChild(details);
  }

  return container;
}

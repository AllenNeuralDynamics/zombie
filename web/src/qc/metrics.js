import { getMetricStatus, isCustomMetric, resolveReference } from './data.js';
import { isEditableMetric, valueText } from './edit-model.js';
import { renderMedia } from './media.js';

const EDIT_TOOLTIP = 'Use edit mode to make changes';

/**
 * Read-only rendering of the custom metric value widgets (DropdownMetric / CheckboxMetric)
 * that the Panel app shows as interactive Select / MultiChoice controls.
 */
function renderCustomMetric(val) {
  const wrap = document.createElement('div');
  wrap.className = 'qc-custom-metric';
  wrap.title = EDIT_TOOLTIP;

  if (val.type === 'dropdown') {
    const sel = document.createElement('div');
    sel.className = 'qc-readonly-select';
    const v = val.value;
    sel.textContent = (v === '' || v === null || v === undefined) ? '—' : String(v);
    wrap.appendChild(sel);
  } else if (val.type === 'checkbox') {
    const selected = Array.isArray(val.value) ? val.value : (val.value != null ? [val.value] : []);
    const list = document.createElement('div');
    list.className = 'qc-readonly-checklist';
    for (const opt of (val.options ?? [])) {
      const item = document.createElement('div');
      item.className = 'qc-readonly-check';
      const checked = selected.includes(opt);
      const box = document.createElement('span');
      box.className = 'qc-checkbox' + (checked ? ' checked' : '');
      box.textContent = checked ? '☑' : '☐';
      item.appendChild(box);
      item.appendChild(document.createTextNode(` ${opt}`));
      list.appendChild(item);
    }
    wrap.appendChild(list);
  } else {
    // Unknown custom shape (e.g. rule-based): fall back to JSON.
    const pre = document.createElement('pre');
    pre.className = 'qc-value-json';
    pre.textContent = JSON.stringify(val, null, 2);
    wrap.appendChild(pre);
  }
  return wrap;
}

function renderMarkdownLinks(text) {
  const fragment = document.createDocumentFragment();
  const value = String(text ?? '');
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let offset = 0;
  for (const match of value.matchAll(pattern)) {
    fragment.appendChild(document.createTextNode(value.slice(offset, match.index)));
    let url = null;
    try {
      const parsed = new URL(match[2]);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') url = parsed.href;
    } catch {
      // Invalid and relative URLs remain visible as plain text.
    }
    if (url) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = match[1];
      fragment.appendChild(anchor);
    } else {
      fragment.appendChild(document.createTextNode(match[0]));
    }
    offset = match.index + match[0].length;
  }
  fragment.appendChild(document.createTextNode(value.slice(offset)));
  return fragment;
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
    // Custom metric widgets (dropdown / checkbox) render as read-only controls.
    if (isCustomMetric(val)) {
      return renderCustomMetric(val);
    }

    let entries = Object.entries(val);

    // Curation dicts carry a "reference" key (rendered as media alongside). Show the
    // remaining key/value pairs as a small read-only table, matching GenericCuration.
    if ('reference' in val) {
      const rest = entries.filter(([k]) => k !== 'reference');
      if (!rest.length) return document.createTextNode('—');
      const table = document.createElement('table');
      table.className = 'qc-value-table';
      const tbody = table.createTBody();
      for (const [k, v] of rest) {
        const row = tbody.insertRow();
        const keyCell = row.insertCell();
        keyCell.textContent = k;
        keyCell.style.fontWeight = '600';
        row.insertCell().textContent = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      }
      return table;
    }

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

function renderMetricValue(metric, edit) {
  const editable = Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) && edit.onValue && isEditableMetric(metric));
  if (!editable) {
    const value = document.createElement('div');
    value.appendChild(renderValue(metric.value));
    return value;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'qc-inline-value-editor';
  wrapper.dataset.qcMetric = metric.name;
  const input = document.createElement('textarea');
  input.className = 'qc-inline-editor-value';
  input.value = edit.valueDrafts?.[metric.name] ?? valueText(metric.value);
  input.rows = typeof metric.value === 'object' ? 4 : 1;
  input.setAttribute('aria-label', `${metric.name} value`);
  input.addEventListener('input', () => edit.onValue(metric.name, input.value));
  wrapper.appendChild(input);

  const error = edit.fieldErrors?.[metric.name];
  if (error) {
    const errorEl = document.createElement('div');
    errorEl.className = 'qc-inline-field-error';
    errorEl.textContent = error;
    wrapper.appendChild(errorEl);
  }
  return wrapper;
}

function renderMetricStatus(metric, edit) {
  const editable = Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) && edit.onStatus && isEditableMetric(metric));
  const status = edit?.statusDrafts?.[metric.name] ?? getMetricStatus(metric);
  if (editable) {
    const label = document.createElement('label');
    label.className = 'metric-status metric-status-editor';
    label.textContent = 'Status';
    const select = document.createElement('select');
    select.className = 'qc-inline-status';
    select.setAttribute('aria-label', `${metric.name} status`);
    for (const option of ['Pending', 'Pass', 'Fail']) {
      const optionEl = document.createElement('option');
      optionEl.value = option;
      optionEl.textContent = option;
      optionEl.selected = status === option;
      select.appendChild(optionEl);
    }
    select.addEventListener('change', () => edit.onStatus(metric.name, select.value));
    label.appendChild(select);
    return label;
  }

  const statusEl = document.createElement('div');
  statusEl.className = 'metric-status';
  statusEl.title = EDIT_TOOLTIP;
  const dot = document.createElement('span');
  dot.className = `status-dot ${statusDotClass(status)}`;
  statusEl.appendChild(dot);
  statusEl.appendChild(document.createTextNode(status));
  return statusEl;
}

function buildMetricCard(metric, edit = {}) {
  const card = document.createElement('div');
  const isCuration = metric.object_type === 'Curation metric';
  const editable = edit.enabled && edit.editableMetricNames?.has(metric.name) && isEditableMetric(metric);
  card.className = `${isCuration ? 'qc-metric-card qc-metric-curation' : 'qc-metric-card'}${editable ? ' qc-metric-editable' : ''}`;

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
    desc.appendChild(renderMarkdownLinks(metric.description));
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
  valEl.appendChild(renderMetricValue(metric, edit));
  card.appendChild(valEl);

  card.appendChild(renderMetricStatus(metric, edit));

  return card;
}

function renderReferenceLink(reference, s3Bucket, s3Prefix, assetName, rawS3Loc) {
  const cell = document.createElement('td');
  cell.className = 'qc-reference-cell';
  if (!reference) {
    cell.textContent = '—';
    return cell;
  }
  const link = document.createElement('a');
  link.className = 'qc-reference-link';
  link.href = resolveReferenceUrl(reference, s3Bucket, s3Prefix, rawS3Loc);
  link.textContent = reference.split('/').pop() || reference;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openReferenceDialog(reference, s3Bucket, s3Prefix, assetName, rawS3Loc);
  });
  cell.appendChild(link);

  const preview = document.createElement('div');
  preview.className = 'qc-reference-preview';
  preview.hidden = true;
  cell.appendChild(preview);
  cell.addEventListener('mouseenter', () => {
    if (preview.childElementCount) {
      preview.hidden = false;
      return;
    }
    preview.appendChild(renderMedia(reference, s3Bucket, s3Prefix, assetName, rawS3Loc));
    preview.hidden = false;
  });
  cell.addEventListener('mouseleave', () => { preview.hidden = true; });
  return cell;
}

function resolveReferenceUrl(reference, s3Bucket, s3Prefix, rawS3Loc) {
  const parts = reference.split(';').map(part => part.trim()).filter(Boolean);
  return resolveReference(parts[0] || reference, s3Bucket, s3Prefix, rawS3Loc).url || '#';
}

function openReferenceDialog(reference, s3Bucket, s3Prefix, assetName, rawS3Loc) {
  const overlay = document.createElement('div');
  overlay.className = 'qc-reference-dialog';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Reference media');

  const dialog = document.createElement('div');
  dialog.className = 'qc-reference-dialog-content';
  const close = document.createElement('button');
  close.className = 'qc-reference-dialog-close';
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => overlay.remove());
  dialog.appendChild(close);
  dialog.appendChild(renderMedia(reference, s3Bucket, s3Prefix, assetName, rawS3Loc));
  overlay.appendChild(dialog);
  overlay.addEventListener('click', event => {
    if (event.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

function renderTableMetricValue(metric, edit) {
  const editable = Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) && edit.onValue && isEditableMetric(metric));
  if (!editable) return renderValue(metric.value);

  const wrapper = document.createElement('div');
  wrapper.className = 'qc-table-value-editor';
  wrapper.dataset.qcMetric = metric.name;
  const input = document.createElement('textarea');
  input.className = 'qc-inline-editor-value';
  input.value = edit.valueDrafts?.[metric.name] ?? valueText(metric.value);
  input.rows = typeof metric.value === 'object' ? 3 : 1;
  input.setAttribute('aria-label', `${metric.name} value`);
  input.addEventListener('input', () => edit.onValue(metric.name, input.value));
  wrapper.appendChild(input);
  const error = edit.fieldErrors?.[metric.name];
  if (error) {
    const errorEl = document.createElement('div');
    errorEl.className = 'qc-inline-field-error';
    errorEl.textContent = error;
    wrapper.appendChild(errorEl);
  }
  return wrapper;
}

function renderTableMetricStatus(metric, edit) {
  const editable = Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) && edit.onStatus && isEditableMetric(metric));
  const status = edit?.statusDrafts?.[metric.name] ?? getMetricStatus(metric);
  if (!editable) {
    const statusEl = document.createElement('span');
    statusEl.className = `qc-table-status ${statusDotClass(status)}`;
    statusEl.textContent = status;
    return statusEl;
  }

  const select = document.createElement('select');
  select.className = 'qc-inline-status';
  select.setAttribute('aria-label', `${metric.name} status`);
  for (const option of ['Pending', 'Pass', 'Fail']) {
    const optionEl = document.createElement('option');
    optionEl.value = option;
    optionEl.textContent = option;
    optionEl.selected = status === option;
    select.appendChild(optionEl);
  }
  select.addEventListener('change', () => edit.onStatus(metric.name, select.value));
  return select;
}

function leafMetricGroups(nodes, path = []) {
  const groups = [];
  for (const node of nodes) {
    const nextPath = [...path, `${node.label} (${node.metrics.length})`];
    if (node.children?.length) groups.push(...leafMetricGroups(node.children, nextPath));
    else groups.push({ label: nextPath.join(' / '), metrics: node.metrics });
  }
  return groups;
}

export function renderMetricsTable(metrics, s3Bucket, s3Prefix, assetName, rawS3Loc = '', edit = {}, treeNodes = []) {
  const table = document.createElement('table');
  table.className = 'qc-metrics-table';
  const thead = table.createTHead();
  const headerRow = thead.insertRow();
  for (const label of ['Reference', 'Metric', 'Value', 'Status']) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }

  const tbody = table.createTBody();
  const groups = treeNodes.length ? leafMetricGroups(treeNodes) : [{ label: 'Metrics', metrics }];
  for (const group of groups) {
    const groupRow = tbody.insertRow();
    groupRow.className = 'qc-metrics-table-group';
    const groupCell = groupRow.insertCell();
    groupCell.colSpan = 4;
    groupCell.textContent = group.label;
    for (const metric of group.metrics) {
      const row = tbody.insertRow();
      row.className = 'qc-metrics-table-row';
      row.appendChild(renderReferenceLink(metric.reference ?? '', s3Bucket, s3Prefix, assetName, rawS3Loc));
      row.insertCell().textContent = metric.name ?? '';
      const valueCell = row.insertCell();
      valueCell.appendChild(renderTableMetricValue(metric, edit));
      const statusCell = row.insertCell();
      statusCell.appendChild(renderTableMetricStatus(metric, edit));
    }
  }
  return table;
}

export function renderMetrics(metrics, s3Bucket, s3Prefix, assetName, rawS3Loc = '', edit = {}) {
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
    // With a media reference the cards sit in a fixed-width column beside the media;
    // without one they fill the width as a responsive grid instead of a single stack.
    leftCol.className = ref ? 'accordion-metrics' : 'accordion-metrics accordion-metrics-grid';
    for (const m of groupMetrics) {
      leftCol.appendChild(buildMetricCard(m, edit));
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

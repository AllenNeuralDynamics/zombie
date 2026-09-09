import { getMetricStatus, isCustomMetric, resolveReference } from './data.js';
import {
  canEditMetricStatus,
  canEditMetricValue,
  isAutoStatusMetric,
  parseDraft,
  valueText,
} from './edit-model.js';
import { renderMedia } from './media.js';

const EDIT_TOOLTIP = 'Use edit mode to make changes';

/**
 * Read-only rendering of the custom metric value widgets (DropdownMetric / CheckboxMetric)
 * that the Panel app shows as interactive Select / MultiChoice controls.
 */
function renderCustomMetric(val, { editable = false, onChange = null } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'qc-custom-metric';
  if (!editable) wrap.title = EDIT_TOOLTIP;

  if (val.type === 'dropdown') {
    const sel = document.createElement(editable ? 'select' : 'div');
    sel.className = editable ? 'qc-inline-custom-select' : 'qc-readonly-select';
    if (editable) {
      for (const option of [''].concat(val.options ?? [])) {
        const optionEl = document.createElement('option');
        optionEl.value = option;
        optionEl.textContent = option || '—';
        optionEl.selected = option === (val.value ?? '');
        sel.appendChild(optionEl);
      }
      sel.addEventListener('change', () => onChange?.({ ...val, value: sel.value }));
    } else {
      const v = val.value;
      sel.textContent = (v === '' || v === null || v === undefined) ? '—' : String(v);
    }
    wrap.appendChild(sel);
  } else if (val.type === 'checkbox') {
    const selected = Array.isArray(val.value) ? val.value : (val.value != null ? [val.value] : []);
    const list = document.createElement('div');
    list.className = editable ? 'qc-inline-checkbox-list' : 'qc-readonly-checklist';
    for (const opt of (val.options ?? [])) {
      const checked = selected.includes(opt);
      const item = document.createElement(editable ? 'label' : 'div');
      item.className = editable ? 'qc-inline-checkbox' : 'qc-readonly-check';
      if (editable) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked;
        input.value = opt;
        input.addEventListener('change', () => {
          const next = [...list.querySelectorAll('input:checked')].map(inputEl => inputEl.value);
          onChange?.({ ...val, value: next });
        });
        item.appendChild(input);
        item.appendChild(document.createTextNode(opt));
      } else {
        const box = document.createElement('span');
        box.className = 'qc-checkbox' + (checked ? ' checked' : '');
        box.textContent = checked ? '☑' : '☐';
        item.appendChild(box);
        item.appendChild(document.createTextNode(` ${opt}`));
      }
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

export function statusShadeClass(status) {
  const normalized = statusDotClass(status);
  return normalized === 'pass' ? '' : `qc-metric-status-${normalized}`;
}

function renderObjectTable(val, { excludeReference = false } = {}) {
  const entries = Object.entries(val).filter(([key]) => !excludeReference || key !== 'reference');
  if (!entries.length) return document.createTextNode('—');

  const listsOnly = entries.every(([, value]) => Array.isArray(value));
  const lengths = entries.map(([, value]) => value.length);
  if (listsOnly && lengths.every(length => length === lengths[0])) {
    const indexKey = entries.find(([key]) => key.toLowerCase() === 'index')?.[0];
    const columns = entries.filter(([key]) => key !== indexKey);
    const table = document.createElement('table');
    table.className = 'qc-value-table';
    const thead = table.createTHead();
    const header = thead.insertRow();
    if (indexKey) appendHeaderCell(header, indexKey);
    for (const [key] of columns) appendHeaderCell(header, key);
    const body = table.createTBody();
    const rowCount = columns.length ? columns[0][1].length : val[indexKey].length;
    for (let index = 0; index < rowCount; index++) {
      const row = body.insertRow();
      if (indexKey) row.insertCell().textContent = String(val[indexKey][index]);
      for (const [, values] of columns) row.insertCell().textContent = formatCellValue(values[index]);
    }
    return table;
  }

  const table = document.createElement('table');
  table.className = 'qc-value-table qc-value-key-table';
  const thead = table.createTHead();
  const header = thead.insertRow();
  appendHeaderCell(header, 'Field');
  appendHeaderCell(header, 'Value');
  const body = table.createTBody();
  for (const [key, value] of entries) {
    const row = body.insertRow();
    const keyCell = row.insertCell();
    keyCell.textContent = key;
    keyCell.className = 'qc-value-key';
    row.insertCell().textContent = formatCellValue(value);
  }
  return table;
}

function formatCellValue(value) {
  if (value === null || value === undefined) return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function appendHeaderCell(row, text) {
  const cell = document.createElement('th');
  cell.textContent = text;
  row.appendChild(cell);
}

/** Decode the list-of-JSON-dictionaries used by CurationMetric values. */
export function parseCurationValues(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source.startsWith('json:') ? source.slice(5) : source); } catch { return []; }
  }
  if (!Array.isArray(source)) source = source && typeof source === 'object' ? [source] : [];
  return source.map(entry => {
    if (typeof entry !== 'string') return entry;
    try { return JSON.parse(entry.startsWith('json:') ? entry.slice(5) : entry); } catch { return null; }
  }).filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function isCurationCollection(metric) {
  if (metric.object_type === 'Curation metric') return true;
  return parseCurationValues(metric.value).some(entry =>
    Object.values(entry).some(item => item && typeof item === 'object' && !Array.isArray(item) && 'reference' in item),
  );
}

function renderCurationValue(metric, { s3Bucket, s3Prefix, assetName, rawS3Loc } = {}) {
  const values = parseCurationValues(metric.value);
  const current = values[values.length - 1] ?? {};
  const items = Object.entries(current).filter(([, item]) => item && typeof item === 'object' && !Array.isArray(item));
  if (!items.length) return renderObjectTable(current);

  const wrap = document.createElement('div');
  wrap.className = 'qc-curation';
  const pickerLabel = document.createElement('label');
  pickerLabel.className = 'qc-curation-picker';
  pickerLabel.appendChild(document.createTextNode('Curation item'));
  const picker = document.createElement('select');
  picker.className = 'qc-curation-select';
  picker.setAttribute('aria-label', `${metric.name} curation item`);
  for (const [key] of items) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = key;
    picker.appendChild(option);
  }
  pickerLabel.appendChild(picker);
  wrap.appendChild(pickerLabel);

  const detail = document.createElement('div');
  detail.className = 'qc-curation-detail';
  wrap.appendChild(detail);

  const renderSelected = () => {
    detail.replaceChildren();
    const selected = items.find(([key]) => key === picker.value)?.[1] ?? {};
    detail.appendChild(renderObjectTable(selected, { excludeReference: true }));
    if (selected.reference) {
      const reference = document.createElement('div');
      reference.className = 'qc-curation-reference';
      reference.appendChild(renderMedia(selected.reference, s3Bucket, s3Prefix, assetName, rawS3Loc));
      detail.appendChild(reference);
    }
  };
  picker.addEventListener('change', renderSelected);
  picker.value = items[0][0];
  renderSelected();
  return wrap;
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
    const table = document.createElement('table');
    table.className = 'qc-value-table';
    const thead = table.createTHead();
    const hrow = thead.insertRow();
    appendHeaderCell(hrow, 'index');
    appendHeaderCell(hrow, 'values');
    const tbody = table.createTBody();
    for (const [index, item] of val.entries()) {
      const row = tbody.insertRow();
      row.insertCell().textContent = String(index);
      row.insertCell().textContent = formatCellValue(item);
    }
    return table;
  }

  if (typeof val === 'object') {
    // Custom metric widgets (dropdown / checkbox) render as read-only controls.
    if (isCustomMetric(val)) {
      return renderCustomMetric(val);
    }

    return renderObjectTable(val, { excludeReference: 'reference' in val });
  }

  return document.createTextNode(String(val));
}

function draftValue(metric, edit) {
  if (!edit?.enabled) return metric.value;
  const draft = edit?.valueDrafts?.[metric.name];
  if (draft === undefined) return metric.value;
  try { return parseDraft(draft, metric.value); } catch { return metric.value; }
}

function draftStatus(metric, edit) {
  if (!edit?.enabled) return getMetricStatus(metric);
  return edit?.statusDrafts?.[metric.name] ?? getMetricStatus(metric);
}

function valueEditEnabled(metric, edit) {
  return Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) && edit.onValue &&
    canEditMetricValue(metric, { allowEditingValues: edit.allowEditingValues }));
}

function statusEditEnabled(metric, edit) {
  return Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) && edit.onStatus &&
    canEditMetricStatus(metric, {
      allowEditingValues: edit.allowEditingValues,
      draftValue: draftValue(metric, edit),
    }));
}

function enableStatusForDraft(wrapper, metric, edit, nextValue) {
  const status = wrapper.closest('.qc-metric-card, .qc-metrics-table-row')?.querySelector('.qc-inline-status');
  if (!status) return;
  status.disabled = !canEditMetricStatus(metric, {
    allowEditingValues: edit.allowEditingValues,
    draftValue: nextValue,
  });
}

function appendFieldError(wrapper, metric, edit) {
  const error = edit.fieldErrors?.[metric.name];
  if (!error) return;
  const errorEl = document.createElement('div');
  errorEl.className = 'qc-inline-field-error';
  errorEl.textContent = error;
  wrapper.appendChild(errorEl);
}

function renderEditableDictionary(metric, edit) {
  const value = draftValue(metric, edit);
  if (!value || typeof value !== 'object' || Array.isArray(value) || isCustomMetric(value)) return null;
  const entries = Object.entries(value);
  const wrapper = document.createElement('div');
  wrapper.className = 'qc-inline-dictionary-editor';
  wrapper.dataset.qcMetric = metric.name;
  const table = document.createElement('table');
  table.className = 'qc-value-table qc-value-key-table';
  const thead = table.createTHead();
  const header = thead.insertRow();
  appendHeaderCell(header, 'Field');
  appendHeaderCell(header, 'Value');
  const body = table.createTBody();
  for (const [key, original] of entries) {
    const row = body.insertRow();
    row.insertCell().textContent = key;
    const valueCell = row.insertCell();
    if (Array.isArray(original) || (original && typeof original === 'object')) {
      valueCell.textContent = formatCellValue(original);
      continue;
    }
    const input = document.createElement('input');
    input.className = 'qc-inline-dictionary-input';
    input.value = valueText(original);
    input.setAttribute('aria-label', `${metric.name} ${key}`);
    input.addEventListener('input', () => {
      let nextValue = input.value;
      try { nextValue = parseDraft(input.value, original); } catch { /* keep the in-progress text */ }
      const next = { ...value, [key]: nextValue };
      edit.onValue(metric.name, JSON.stringify(next));
      enableStatusForDraft(wrapper, metric, edit, next);
    });
    valueCell.appendChild(input);
  }
  wrapper.appendChild(table);
  appendFieldError(wrapper, metric, edit);
  return wrapper;
}

function renderMetricValue(metric, edit, media = {}) {
  const editable = valueEditEnabled(metric, edit);
  const currentValue = draftValue(metric, edit);
  if (isCurationCollection(metric)) {
    return renderCurationValue(metric, media);
  }
  if (isCustomMetric(currentValue)) {
    const custom = renderCustomMetric(currentValue, {
      editable,
      onChange: next => {
        edit.onValue(metric.name, JSON.stringify(next));
        enableStatusForDraft(custom, metric, edit, next);
      },
    });
    if (editable) {
      custom.dataset.qcMetric = metric.name;
      appendFieldError(custom, metric, edit);
    }
    return custom;
  }
  if (!editable) {
    const value = document.createElement('div');
    value.appendChild(renderValue(metric.value));
    return value;
  }

  const dictionary = renderEditableDictionary(metric, edit);
  if (dictionary) return dictionary;

  const wrapper = document.createElement('div');
  wrapper.className = 'qc-inline-value-editor';
  wrapper.dataset.qcMetric = metric.name;
  const input = document.createElement('textarea');
  input.className = 'qc-inline-editor-value';
  input.value = edit.valueDrafts?.[metric.name] ?? valueText(metric.value);
  input.rows = 1;
  input.setAttribute('aria-label', `${metric.name} value`);
  input.addEventListener('input', () => {
    edit.onValue(metric.name, input.value);
    try { enableStatusForDraft(wrapper, metric, edit, parseDraft(input.value, metric.value)); } catch { /* invalid draft */ }
  });
  wrapper.appendChild(input);
  appendFieldError(wrapper, metric, edit);
  return wrapper;
}

function renderMetricStatus(metric, edit) {
  const editable = statusEditEnabled(metric, edit);
  const status = draftStatus(metric, edit);
  const showStatusEditor = Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) &&
    !isAutoStatusMetric(metric) && edit.onStatus);
  if (showStatusEditor) {
    const label = document.createElement('label');
    label.className = 'metric-status metric-status-editor';
    label.textContent = 'Status';
    const select = document.createElement('select');
    select.className = 'qc-inline-status';
    select.disabled = !editable;
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

function buildMetricCard(metric, edit = {}, media = {}) {
  const card = document.createElement('div');
  const isCuration = metric.object_type === 'Curation metric';
  const status = draftStatus(metric, edit);
  const statusShade = statusShadeClass(status);
  const editable = valueEditEnabled(metric, edit) || statusEditEnabled(metric, edit);
  card.className = `${isCuration ? 'qc-metric-card qc-metric-curation' : 'qc-metric-card'}${statusShade ? ` ${statusShade}` : ''}${editable ? ' qc-metric-editable' : ''}`;
  card.dataset.qcStatusMetric = metric.name ?? '';

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
  valEl.appendChild(renderMetricValue(metric, edit, media));
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
  const anchor = document.createElement('span');
  anchor.className = 'qc-reference-anchor';
  anchor.appendChild(link);
  cell.appendChild(anchor);

  const preview = document.createElement('div');
  preview.className = 'qc-reference-preview';
  preview.hidden = true;
  anchor.appendChild(preview);
  anchor.addEventListener('mouseenter', () => {
    if (preview.childElementCount) {
      preview.hidden = false;
      return;
    }
    preview.appendChild(renderMedia(reference, s3Bucket, s3Prefix, assetName, rawS3Loc));
    preview.hidden = false;
  });
  anchor.addEventListener('mouseleave', () => { preview.hidden = true; });
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

function renderTableMetricValue(metric, edit, media = {}) {
  return renderMetricValue(metric, edit, media);
}

function renderTableMetricStatus(metric, edit) {
  const editable = statusEditEnabled(metric, edit);
  const status = draftStatus(metric, edit);
  const showStatusEditor = Boolean(edit?.enabled && edit.editableMetricNames?.has(metric.name) &&
    !isAutoStatusMetric(metric) && edit.onStatus);
  if (!showStatusEditor) {
    const statusEl = document.createElement('span');
    statusEl.className = `qc-table-status ${statusDotClass(status)}`;
    statusEl.textContent = status;
    return statusEl;
  }

  const select = document.createElement('select');
  select.className = 'qc-inline-status';
  select.disabled = !editable;
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
      const status = draftStatus(metric, edit);
      const statusShade = statusShadeClass(status);
      row.className = `qc-metrics-table-row${statusShade ? ` ${statusShade}` : ''}`;
      row.dataset.qcStatusMetric = metric.name ?? '';
      row.appendChild(renderReferenceLink(metric.reference ?? '', s3Bucket, s3Prefix, assetName, rawS3Loc));
      row.insertCell().textContent = metric.name ?? '';
      const valueCell = row.insertCell();
      valueCell.appendChild(renderTableMetricValue(metric, edit, { s3Bucket, s3Prefix, assetName, rawS3Loc }));
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
      leftCol.appendChild(buildMetricCard(m, edit, { s3Bucket, s3Prefix, assetName, rawS3Loc }));
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

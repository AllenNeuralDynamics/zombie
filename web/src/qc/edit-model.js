import { canonicalQcJson } from './canonical.js';
import { isCustomMetric } from './data.js';

/** Return the actual value represented by a regular or custom metric value. */
export function metricValue(value) {
  return isCustomMetric(value) ? value.value : value;
}

/** A value is present when it is meaningful, while preserving 0 and false. */
export function hasMetricValue(value) {
  const actual = metricValue(value);
  if (actual === null || actual === undefined) return false;
  if (typeof actual === 'string') return actual.trim() !== '';
  if (Array.isArray(actual)) return actual.length > 0;
  if (typeof actual === 'object') return Object.keys(actual).length > 0;
  return true;
}

/** Dropdowns and checkboxes with status mappings compute their own status. */
export function isAutoStatusMetric(metric) {
  const value = metric?.value;
  return isCustomMetric(value) &&
    (value.type === 'dropdown' || value.type === 'checkbox') &&
    value.status != null;
}

export function hasMetricStatus(metric) {
  const history = metric?.status_history;
  const latest = Array.isArray(history) && history.length ? history[history.length - 1] : null;
  return latest?.status != null && latest.status !== '';
}

/** The value field is open for empty metrics, or after the setting is enabled. */
export function canEditMetricValue(metric, { allowEditingValues = false } = {}) {
  return isEditableMetric(metric) && (!hasMetricValue(metric?.value) || allowEditingValues);
}

/** Empty metrics may set status; populated existing statuses require opt-in. */
export function canEditMetricStatus(
  metric,
  { allowEditingValues = false, draftValue = metric?.value } = {},
) {
  if (!isEditableMetric(metric) || isAutoStatusMetric(metric)) return false;
  if (!hasMetricValue(draftValue)) return true;
  return !hasMetricStatus(metric) || allowEditingValues;
}

/** Known custom value widgets are editable; unknown rule objects remain read-only. */
export function isEditableMetric(metric) {
  if (!metric?.name) return false;
  // Curations have their own viewer/editor contract; the generic QC submit API
  // must not replace a curation history entry with a plain value.
  if (metric.object_type === 'Curation metric') return false;
  if (!isCustomMetric(metric.value)) return true;
  return metric.value.type === 'dropdown' || metric.value.type === 'checkbox';
}

/** Reproduce the legacy dropdown/checkbox status reduction in the browser. */
export function autoStatusForValue(value) {
  if (!isCustomMetric(value) || (value.type !== 'dropdown' && value.type !== 'checkbox')) return null;
  if (value.status == null) return null;

  if (value.type === 'dropdown') {
    const index = (value.options ?? []).indexOf(value.value);
    return index < 0 || !hasMetricValue(value.value) ? 'Pending' : (value.status[index] ?? 'Pending');
  }

  const selected = Array.isArray(value.value) ? value.value : [];
  if (!selected.length) return 'Pending';
  const statuses = selected.map(item => {
    const index = (value.options ?? []).indexOf(item);
    return index < 0 ? 'Pending' : (value.status[index] ?? 'Pending');
  });
  if (statuses.includes('Fail')) return 'Fail';
  if (statuses.includes('Pending')) return 'Pending';
  return 'Pass';
}

export function valueText(value) {
  if (value !== null && typeof value === 'object') return JSON.stringify(value, null, 2);
  return value === null || value === undefined ? '' : String(value);
}

export function parseDraft(text, original) {
  if (typeof original === 'number') {
    const value = Number(text);
    if (text.trim() === '' || !Number.isFinite(value)) throw new Error('Enter a finite number.');
    return value;
  }
  if (typeof original === 'boolean') {
    if (text !== 'true' && text !== 'false') throw new Error('Enter true or false.');
    return text === 'true';
  }
  if (original !== null && typeof original === 'object') {
    try { return JSON.parse(text); } catch { throw new Error('Enter valid JSON.'); }
  }
  return text;
}

export function sameValue(left, right) {
  try { return canonicalQcJson(left) === canonicalQcJson(right); } catch { return left === right; }
}

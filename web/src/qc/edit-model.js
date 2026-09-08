import { canonicalQcJson } from './canonical.js';
import { isCustomMetric } from './data.js';

const UNSUPPORTED_CURATION_TYPES = /spike\s*sorting|ephys/i;

export function isEditableMetric(metric) {
  if (isCustomMetric(metric.value)) return false;
  if (metric.object_type === 'Curation metric' && UNSUPPORTED_CURATION_TYPES.test(metric.type ?? '')) return false;
  return true;
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

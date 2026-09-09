import { describe, expect, it } from 'vitest';
import {
  autoStatusForValue,
  canEditMetricStatus,
  canEditMetricValue,
  hasMetricStatus,
  hasMetricValue,
  isAutoStatusMetric,
} from '../qc/edit-model.js';

const metric = (value, status_history = []) => ({ name: 'metric', value, status_history });

describe('QC edit policy', () => {
  it('recognizes empty values without treating false or zero as empty', () => {
    expect(hasMetricValue(null)).toBe(false);
    expect(hasMetricValue('')).toBe(false);
    expect(hasMetricValue([])).toBe(false);
    expect(hasMetricValue({})).toBe(false);
    expect(hasMetricValue(0)).toBe(true);
    expect(hasMetricValue(false)).toBe(true);
  });

  it('opens empty value fields immediately and gates populated values behind settings', () => {
    expect(canEditMetricValue(metric(null))).toBe(true);
    expect(canEditMetricValue(metric('value'))).toBe(false);
    expect(canEditMetricValue(metric('value'), { allowEditingValues: true })).toBe(true);
  });

  it('allows status only after a value exists, with auto-status as the exception', () => {
    expect(hasMetricStatus(metric('value'))).toBe(false);
    expect(canEditMetricStatus(metric(null))).toBe(false);
    expect(canEditMetricStatus(metric('value'))).toBe(true);
    expect(canEditMetricStatus(metric('value', [{ status: 'Pass' }]))).toBe(false);
    expect(canEditMetricStatus(metric('value', [{ status: 'Pass' }]), { allowEditingValues: true })).toBe(true);

    const dropdown = metric({ type: 'dropdown', options: ['good', 'bad'], value: 'good', status: ['Pass', 'Fail'] });
    expect(isAutoStatusMetric(dropdown)).toBe(true);
    expect(canEditMetricStatus(dropdown, { allowEditingValues: true })).toBe(false);
  });

  it('computes dropdown and checkbox status using the legacy reduction order', () => {
    expect(autoStatusForValue({ type: 'dropdown', options: ['good', 'bad'], value: 'bad', status: ['Pass', 'Fail'] })).toBe('Fail');
    expect(autoStatusForValue({ type: 'checkbox', options: ['good', 'pending', 'bad'], value: ['good', 'pending'], status: ['Pass', 'Pending', 'Fail'] })).toBe('Pending');
    expect(autoStatusForValue({ type: 'checkbox', options: ['good', 'bad'], value: ['good', 'bad'], status: ['Pass', 'Fail'] })).toBe('Fail');
  });
});

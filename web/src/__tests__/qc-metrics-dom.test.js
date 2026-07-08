/**
 * qc-metrics-dom.test.js — DOM tests for read-only QC rendering parity with the Panel app:
 * custom metric widgets (dropdown/checkbox), curation dict tables, and media (h5, swipe).
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { renderMetrics } from '../qc/metrics.js';
import { renderMedia } from '../qc/media.js';
import { isCustomMetric } from '../qc/data.js';

const baseMetric = (overrides = {}) => ({
  name: 'm',
  reference: '',
  tags: {},
  status_history: [{ status: 'Pass' }],
  ...overrides,
});

function cardFor(metric) {
  const el = renderMetrics([metric], 'aind-open-data', 'prefix', 'asset');
  return el.querySelector('.qc-metric-card');
}

describe('isCustomMetric', () => {
  it('detects dropdown/checkbox/rule dicts', () => {
    expect(isCustomMetric({ type: 'dropdown', options: [], value: '' })).toBe(true);
    expect(isCustomMetric({ rule: 'x' })).toBe(true);
    expect(isCustomMetric({ foo: 1 })).toBe(false);
    expect(isCustomMetric([1, 2])).toBe(false);
    expect(isCustomMetric('str')).toBe(false);
  });
});

describe('custom metric rendering', () => {
  it('renders a dropdown value read-only with edit tooltip', () => {
    const card = cardFor(baseMetric({ value: { type: 'dropdown', options: ['a', 'b'], value: 'b' } }));
    const custom = card.querySelector('.qc-custom-metric');
    expect(custom).toBeTruthy();
    expect(custom.title).toMatch(/edit mode/i);
    expect(card.querySelector('.qc-readonly-select').textContent).toBe('b');
  });

  it('renders empty dropdown as em-dash', () => {
    const card = cardFor(baseMetric({ value: { type: 'dropdown', options: ['a'], value: '' } }));
    expect(card.querySelector('.qc-readonly-select').textContent).toBe('—');
  });

  it('renders checkbox options with selected ones checked', () => {
    const card = cardFor(baseMetric({ value: { type: 'checkbox', options: ['a', 'b', 'c'], value: ['a', 'c'] } }));
    const checks = card.querySelectorAll('.qc-readonly-check');
    expect(checks.length).toBe(3);
    const checked = card.querySelectorAll('.qc-checkbox.checked');
    expect(checked.length).toBe(2);
  });
});

describe('curation dict rendering', () => {
  it('renders non-reference keys as a table, excluding reference', () => {
    const card = cardFor(baseMetric({ value: { reference: 'figures/x.png', quality: 'good', count: 5 } }));
    const table = card.querySelector('.qc-value-table');
    expect(table).toBeTruthy();
    const text = table.textContent;
    expect(text).toContain('quality');
    expect(text).toContain('good');
    expect(text).not.toContain('figures/x.png');
  });
});

describe('status tooltip', () => {
  it('adds the edit-mode tooltip to the status indicator', () => {
    const card = cardFor(baseMetric({ value: 1 }));
    expect(card.querySelector('.metric-status').title).toMatch(/edit mode/i);
  });
});

describe('media rendering', () => {
  it('renders an h5 reference as a message with a download link', () => {
    const el = renderMedia('data/volume.h5', 'aind-open-data', 'prefix', 'asset');
    const msg = el.querySelector('.qc-media-h5');
    expect(msg).toBeTruthy();
    expect(msg.querySelector('a')).toBeTruthy();
  });

  it('renders a two-image semicolon reference as a swipe overlay', () => {
    const el = renderMedia('figures/a.png;figures/b.png', 'aind-open-data', 'prefix', 'asset');
    expect(el.classList.contains('qc-swipe')).toBe(true);
    expect(el.querySelector('.qc-swipe-slider')).toBeTruthy();
    expect(el.querySelectorAll('img').length).toBe(2);
  });

  it('falls back to side-by-side for non-image comparisons', () => {
    const el = renderMedia('a.pdf;b.pdf', 'aind-open-data', 'prefix', 'asset');
    expect(el.classList.contains('qc-media-multi')).toBe(true);
  });
});

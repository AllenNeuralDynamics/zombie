/**
 * qc-metrics-dom.test.js — DOM tests for read-only QC rendering parity with the Panel app:
 * custom metric widgets (dropdown/checkbox), curation dict tables, and media (h5, swipe).
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderMetrics, renderMetricsTable } from '../qc/metrics.js';
import { renderMedia } from '../qc/media.js';
import { buildTreeNodes, isCustomMetric } from '../qc/data.js';

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

describe('inline editing', () => {
  it('renders value and status controls in the metric card', () => {
    const onValue = vi.fn();
    const onStatus = vi.fn();
    const metric = baseMetric({ name: 'drift', value: 0.5 });
    const card = renderMetrics([metric], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: true,
      editableMetricNames: new Set(['drift']),
      valueDrafts: { drift: '0.5' },
      statusDrafts: { drift: 'Pass' },
      onValue,
      onStatus,
    }).querySelector('.qc-metric-card');

    const value = card.querySelector('.qc-inline-editor-value');
    value.value = '0.75';
    value.dispatchEvent(new Event('input', { bubbles: true }));
    card.querySelector('.qc-inline-status').value = 'Fail';
    card.querySelector('.qc-inline-status').dispatchEvent(new Event('change', { bubbles: true }));
    expect(onValue).toHaveBeenCalledWith('drift', '0.75');
    expect(onStatus).toHaveBeenCalledWith('drift', 'Fail');
  });
});

describe('table view', () => {
  it('renders one metric row per metric and keeps leaf tree groups', () => {
    const metrics = [
      baseMetric({ name: 'drift', value: 0.5, tags: { probe: 'A', type: 'drift' }, reference: 'figures/drift.png' }),
      baseMetric({ name: 'noise', value: 0.2, tags: { probe: 'A', type: 'noise' }, reference: '' }),
      baseMetric({ name: 'other', value: 1, tags: { probe: 'B', type: 'drift' }, reference: '' }),
    ];
    const treeNodes = buildTreeNodes(metrics, ['probe', 'type']);
    const table = renderMetricsTable(metrics, 'aind-open-data', 'prefix', 'asset', '', {
      enabled: true,
      editableMetricNames: new Set(metrics.map(metric => metric.name)),
      valueDrafts: { drift: '0.5', noise: '0.2', other: '1' },
      statusDrafts: { drift: 'Pass', noise: 'Pass', other: 'Pass' },
      onValue: () => {},
      onStatus: () => {},
    }, treeNodes);

    expect(table.querySelectorAll('.qc-metrics-table-row')).toHaveLength(3);
    expect(table.querySelectorAll('.qc-metrics-table-group')).toHaveLength(3);
    expect(table.textContent).toContain('probe: A (2) / type: drift (1)');
    expect(table.querySelectorAll('.qc-inline-editor-value')).toHaveLength(3);
    expect(table.querySelectorAll('.qc-inline-status')).toHaveLength(3);
    expect(table.querySelector('.qc-reference-link').textContent).toBe('drift.png');
  });

  it('opens reference media in a dialog and creates a hover preview', () => {
    const table = renderMetricsTable([
      baseMetric({ name: 'drift', reference: 'figures/drift.png', value: 1 }),
    ], 'aind-open-data', 'prefix', 'asset');
    const cell = table.querySelector('.qc-reference-cell');
    cell.dispatchEvent(new Event('mouseenter', { bubbles: true }));
    expect(cell.querySelector('.qc-reference-preview .qc-media')).toBeTruthy();
    cell.querySelector('.qc-reference-link').click();
    expect(document.body.querySelector('.qc-reference-dialog')).toBeTruthy();
    document.body.querySelector('.qc-reference-dialog-close').click();
    expect(document.body.querySelector('.qc-reference-dialog')).toBeNull();
  });
});

describe('metric descriptions', () => {
  it('renders safe Markdown links and rejects unsafe protocols', () => {
    const card = cardFor(baseMetric({
      description: '[docs](https://example.org/help) [bad](javascript:alert(1)) <img src=x>',
    }));
    const links = card.querySelectorAll('.metric-desc a');
    expect(links.length).toBe(1);
    expect(links[0].href).toBe('https://example.org/help');
    expect(card.querySelector('.metric-desc img')).toBeNull();
    expect(card.querySelector('.metric-desc').textContent).toContain('<img src=x>');
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

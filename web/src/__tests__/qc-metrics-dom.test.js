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

  it('renders list-of-dictionary curations with an item picker and its reference panel', () => {
    const value = ['{"0":{"reference":"figures/0.png","label":"good"},"1":{"reference":"figures/1.png","label":"bad"}}'];
    const card = cardFor(baseMetric({ object_type: 'Curation metric', value }));
    const picker = card.querySelector('.qc-curation-select');
    expect(picker).toBeTruthy();
    expect(picker.options).toHaveLength(2);
    expect(card.querySelector('.qc-curation-detail').textContent).toContain('good');
    expect(card.querySelector('.qc-curation-reference img').alt).toBe('figures/0.png');

    picker.value = '1';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    expect(card.querySelector('.qc-curation-detail').textContent).toContain('bad');
    expect(card.querySelector('.qc-curation-reference img').alt).toBe('figures/1.png');
  });
});

describe('dictionary rendering', () => {
  it('renders scalar dictionaries as tables instead of JSON text', () => {
    const card = cardFor(baseMetric({ value: { quality: 'good', count: 5 } }));
    expect(card.querySelector('.qc-value-table')).toBeTruthy();
    expect(card.querySelector('.qc-value-json')).toBeNull();
  });
});

describe('status tooltip', () => {
  it('adds the edit-mode tooltip to the status indicator', () => {
    const card = cardFor(baseMetric({ value: 1 }));
    expect(card.querySelector('.metric-status').title).toMatch(/edit mode/i);
  });
});

describe('tree metric status shading', () => {
  it('shades failing and pending metric cards', () => {
    const failing = cardFor(baseMetric({ status_history: [{ status: 'Fail' }] }));
    const pending = cardFor(baseMetric({ status_history: [] }));

    expect(failing.classList.contains('qc-metric-status-fail')).toBe(true);
    expect(pending.classList.contains('qc-metric-status-pending')).toBe(true);
  });

  it('uses a pending draft status while editing', () => {
    const card = renderMetrics([baseMetric({ value: 1 })], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: true,
      editableMetricNames: new Set(['m']),
      valueDrafts: { m: '1' },
      statusDrafts: { m: 'Pending' },
      onValue: () => {},
      onStatus: () => {},
    }).querySelector('.qc-metric-card');

    expect(card.classList.contains('qc-metric-status-pending')).toBe(true);
  });

  it('uses the source value and status when the editor is signed out', () => {
    const card = renderMetrics([baseMetric({ value: 'actual', status_history: [{ status: 'Pass' }] })], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: false,
      valueDrafts: { m: 'pending draft' },
      statusDrafts: { m: 'Fail' },
    }).querySelector('.qc-metric-card');

    expect(card.querySelector('.metric-value').textContent).toBe('actual');
    expect(card.querySelector('.metric-status').textContent).toContain('Pass');
    expect(card.classList.contains('qc-metric-status-fail')).toBe(false);
  });
});

describe('inline editing', () => {
  it('renders value and status controls in the metric card', () => {
    const onValue = vi.fn();
    const onStatus = vi.fn();
    const metric = baseMetric({ name: 'drift', value: 0.5 });
    const card = renderMetrics([metric], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: true,
      allowEditingValues: true,
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

  it('shows empty values as editable with an enabled status dropdown', () => {
    const card = renderMetrics([baseMetric({ name: 'empty', value: '', status_history: [{ status: 'Pass' }] })], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: true,
      editableMetricNames: new Set(['empty']),
      valueDrafts: { empty: '' },
      statusDrafts: { empty: 'Pass' },
      onValue: () => {},
      onStatus: () => {},
    }).querySelector('.qc-metric-card');
    expect(card.querySelector('.qc-inline-editor-value')).toBeTruthy();
    expect(card.querySelector('.qc-inline-status').disabled).toBe(false);
  });

  it('lets populated values opt into value edits while keeping auto status read-only', () => {
    const onValue = vi.fn();
    const metric = baseMetric({
      name: 'quality',
      value: { type: 'dropdown', options: ['good', 'bad'], value: 'good', status: ['Pass', 'Fail'] },
    });
    const card = renderMetrics([metric], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: true,
      allowEditingValues: true,
      editableMetricNames: new Set(['quality']),
      valueDrafts: { quality: JSON.stringify(metric.value) },
      statusDrafts: { quality: 'Pass' },
      onValue,
      onStatus: () => {},
    }).querySelector('.qc-metric-card');
    expect(card.querySelector('.qc-inline-custom-select')).toBeTruthy();
    expect(card.querySelector('.qc-inline-status')).toBeNull();
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
      allowEditingValues: true,
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

  it('renders stage section rows when the hierarchy contains multiple stages', () => {
    const metrics = [
      baseMetric({ name: 'raw', stage: 'Raw data', tags: { type: 'raw' } }),
      baseMetric({ name: 'processed', stage: 'Processing', tags: { type: 'processed' } }),
    ];
    const treeNodes = buildTreeNodes(metrics, ['type']);
    const table = renderMetricsTable(metrics, 'aind-open-data', 'prefix', 'asset', '', {}, treeNodes);

    expect([...table.querySelectorAll('.qc-metrics-table-stage')].map(row => row.textContent)).toEqual([
      'Raw (1)',
      'Processed (1)',
    ]);
    expect(table.querySelectorAll('.qc-metrics-table-row')).toHaveLength(2);
  });

  it('shades failing and pending metric rows', () => {
    const table = renderMetricsTable([
      baseMetric({ name: 'fail', status_history: [{ status: 'Fail' }] }),
      baseMetric({ name: 'pending', status_history: [] }),
      baseMetric({ name: 'pass', status_history: [{ status: 'Pass' }] }),
    ], 'aind-open-data', 'prefix', 'asset');
    const rows = table.querySelectorAll('.qc-metrics-table-row');

    expect(rows[0].classList.contains('qc-metric-status-fail')).toBe(true);
    expect(rows[1].classList.contains('qc-metric-status-pending')).toBe(true);
    expect(rows[2].classList.contains('qc-metric-status-fail')).toBe(false);
    expect(rows[2].classList.contains('qc-metric-status-pending')).toBe(false);
  });

  it('uses edited draft status for row shading', () => {
    const table = renderMetricsTable([
      baseMetric({ name: 'quality', status_history: [{ status: 'Pass' }] }),
    ], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: true,
      editableMetricNames: new Set(['quality']),
      statusDrafts: { quality: 'Fail' },
      onStatus: () => {},
    });

    expect(table.querySelector('.qc-metrics-table-row').classList.contains('qc-metric-status-fail')).toBe(true);
  });

  it('uses the source status for rows when the editor is signed out', () => {
    const table = renderMetricsTable([
      baseMetric({ name: 'quality', status_history: [{ status: 'Pass' }] }),
    ], 'aind-open-data', 'prefix', 'asset', '', {
      enabled: false,
      statusDrafts: { quality: 'Fail' },
    });

    const row = table.querySelector('.qc-metrics-table-row');
    expect(row.textContent).toContain('Pass');
    expect(row.textContent).not.toContain('Fail');
    expect(row.classList.contains('qc-metric-status-fail')).toBe(false);
  });

  it('opens reference media in a dialog and creates a hover preview', () => {
    const table = renderMetricsTable([
      baseMetric({ name: 'drift', reference: 'figures/drift.png', value: 1 }),
    ], 'aind-open-data', 'prefix', 'asset');
    const cell = table.querySelector('.qc-reference-cell');
    const anchor = cell.querySelector('.qc-reference-anchor');
    anchor.dispatchEvent(new Event('mouseenter', { bubbles: true }));
    expect(anchor.querySelector('.qc-reference-preview .qc-media')).toBeTruthy();
    expect(anchor.querySelector('.qc-reference-preview')).toBeTruthy();
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
  it('shows a loading indicator until an image finishes loading', () => {
    const el = renderMedia('figures/slow.png', 'aind-open-data', 'prefix', 'asset');
    const img = el.querySelector('img');

    expect(el.querySelector('.qc-media-loading').textContent).toBe('Loading image…');
    img.dispatchEvent(new Event('load'));
    expect(el.querySelector('.qc-media-loading')).toBeNull();
    expect(el.querySelector('img')).toBe(img);
  });

  it('replaces a failed image with a visible error', () => {
    const el = renderMedia('figures/missing.png', 'aind-open-data', 'prefix', 'asset');
    el.querySelector('img').dispatchEvent(new Event('error'));

    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.qc-media-loading')).toBeNull();
    expect(el.querySelector('.qc-media-error').textContent).toBe('Failed to load image.');
    expect(el.querySelector('.qc-media-error').getAttribute('role')).toBe('alert');
  });

  it('shows a visible error when a private image cannot be presigned', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('denied')));
    try {
      const el = renderMedia('figures/private.png', 'private-bucket', 'prefix', 'asset');
      await Promise.resolve();
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(el.querySelector('.qc-media-loading')).toBeNull();
      expect(el.querySelector('.qc-media-error').textContent)
        .toBe('Failed to load image (access denied or not found).');
    } finally {
      consoleError.mockRestore();
      vi.unstubAllGlobals();
    }
  });

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

  it('passes Neuroglancer state URLs directly to an iframe even when they contain s3 sources', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const ref = 'https://neuroglancer-demo.appspot.com/#!{"layers":[{"source":"precomputed://s3://bucket/path"}]}';
      const el = renderMedia(ref, 'private-bucket', 'prefix', 'asset');
      const iframeUrl = new URL(el.querySelector('iframe').src);
      expect(iframeUrl.origin).toBe('https://neuroglancer-demo.appspot.com');
      expect(iframeUrl.hash).toContain('s3://bucket/path');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    'https://sortingview.vercel.app/figurl?v=1',
    'https://figurl.org/f?v=1',
  ])('embeds %s as an iframe without presigning', (reference) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const el = renderMedia(reference, 'private-bucket', 'prefix', 'asset');
      expect(el.querySelector('iframe').src).toBe(reference);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('embeds percent-encoded Ephys GUI references directly', () => {
    const ref = 'https%3A//ephys.allenneuraldynamics.org/app%3Fraw%3D%7Braw_asset_location%7D';
    const el = renderMedia(ref, 'private-bucket', 'prefix', 'asset', 's3://raw-bucket/raw-prefix');
    expect(el.querySelector('iframe').src)
      .toBe('https://ephys.allenneuraldynamics.org/app?raw=s3://raw-bucket/raw-prefix');
  });

  it('falls back to side-by-side for non-image comparisons', () => {
    const el = renderMedia('a.pdf;b.pdf', 'aind-open-data', 'prefix', 'asset');
    expect(el.classList.contains('qc-media-multi')).toBe(true);
  });

  it('does not render media for closed accordion groups until opened', () => {
    const el = renderMetrics([
      baseMetric({ name: 'first', reference: 'figures/first.png' }),
      baseMetric({ name: 'second', reference: 'figures/second.png' }),
    ], 'aind-open-data', 'prefix', 'asset');
    const details = el.querySelectorAll('details');

    expect(details).toHaveLength(2);
    expect(details[0].open).toBe(true);
    expect(details[0].querySelector('img')).toBeTruthy();
    expect(details[1].open).toBe(false);
    expect(details[1].querySelector('img')).toBeNull();

    details[1].open = true;
    details[1].dispatchEvent(new Event('toggle'));
    expect(details[1].querySelector('img')).toBeTruthy();
  });

  it('resolves the same relative reference from each metric source asset', () => {
    const el = renderMetrics([
      baseMetric({ name: 'raw metric', reference: 'figure.png', assetName: 'raw', assetLocation: 's3://aind-open-data/raw' }),
      baseMetric({ name: 'processed metric', reference: 'figure.png', assetName: 'processed', assetLocation: 's3://aind-open-data/processed' }),
    ], 'fallback-bucket', 'fallback-prefix', 'fallback-asset');
    const details = el.querySelector('.qc-accordion details');
    expect(details.querySelectorAll('img')).toHaveLength(2);
    expect([...details.querySelectorAll('img')].map(image => image.src)).toEqual([
      'https://aind-open-data.s3.us-west-2.amazonaws.com/raw/figure.png',
      'https://aind-open-data.s3.us-west-2.amazonaws.com/processed/figure.png',
    ]);
  });
});

/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../qc/editor.js', () => ({
  mountQcEditor: vi.fn(),
  readQcViewMode: () => 'tree',
  writeQcViewMode: vi.fn(),
}));

import {
  buildHeader,
  createQCView,
  readQcNavigationState,
  syncQcStatusShading,
  writeQcNavigationState,
} from '../qc/view.js';
import { mountQcEditor } from '../qc/editor.js';

describe('QC header actions', () => {
  it('keeps the view toggle beside the legacy and Login actions', () => {
    let selectedMode = null;
    const header = buildHeader('asset-1', 'legacy-project', '', [], [], {
      viewMode: 'table',
      onViewModeChange: mode => { selectedMode = mode; },
    });
    const buttons = [...header.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Tree view', 'Table view', 'Open Legacy QC Portal', 'Login']);
    expect(buttons[1].classList.contains('active')).toBe(true);
    expect(buttons[2].classList.contains('qc-edit-btn')).toBe(true);
    expect(buttons[3].classList.contains('qc-login-btn')).toBe(true);

    const assetLink = header.querySelector('h2 a');
    expect(assetLink.textContent).toBe('asset-1');
    expect(assetLink.getAttribute('href')).toBe('/view?asset=asset-1');
    expect(header.textContent).not.toContain('Project page');

    buttons[0].click();
    expect(selectedMode).toBe('tree');
    expect(buttons[0].classList.contains('active')).toBe(true);
    expect(buttons[1].classList.contains('active')).toBe(false);
  });

  it('renders metadata and Code Ocean links as action links', () => {
    const header = buildHeader('asset-1', 'legacy-project', 'co-123', [], [], {});
    const links = [...header.querySelectorAll('.qc-header-links a')];

    expect(links.map(link => link.textContent)).toEqual(['Metadata', 'Code Ocean']);
    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '/record?name=asset-1',
      'https://codeocean.allenneuraldynamics.org/data_assets/co-123',
    ]);
  });

  it('filters the chain by raw, processed, and analysis stages', () => {
    const view = createQCView({
      name: 'asset-1',
      quality_control: {
        metrics: [
          { name: 'raw metric', stage: 'Raw data', status_history: [{ status: 'Pass' }] },
          { name: 'processed metric', stage: 'Processing', status_history: [{ status: 'Pass' }] },
          { name: 'analysis metric', stage: 'Analysis', status_history: [{ status: 'Pass' }] },
        ],
      },
    });
    const filter = view.querySelector('.qc-stage-filter');
    filter.value = 'processed';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    expect([...view.querySelectorAll('.qc-content .metric-name')].map(node => node.textContent)).toEqual(['processed metric']);
    filter.value = 'raw';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    expect([...view.querySelectorAll('.qc-content .metric-name')].map(node => node.textContent)).toEqual(['raw metric']);
  });

  it('renders lineage metrics from the cache while keeping the raw record for editing', () => {
    const view = createQCView({
      _id: 'raw-id',
      name: 'raw',
      quality_control: { metrics: [{ name: 'raw-only', status_history: [{ status: 'Pass' }] }] },
    }, '', {
      cachedRows: [{
        name: 'processed-only',
        stage: 'Processing',
        modality: 'behavior',
        value: 'new',
        status: 'Pass',
        asset_name: 'processed',
        raw_asset_name: 'raw',
        downstream_asset_names: [],
        metric_json: JSON.stringify({ name: 'processed-only', stage: 'Processing', value: 'new', status_history: [{ status: 'Pass' }] }),
        default_grouping: JSON.stringify([]),
      }],
    });
    expect([...view.querySelectorAll('.qc-content .metric-name')].map(node => node.textContent)).toEqual(['processed-only']);
    expect(mountQcEditor.mock.calls.at(-1)[2].displayMetrics[0].name).toBe('processed-only');
  });
});

describe('QC status updates', () => {
  it('updates shading in place without replacing open accordion content', () => {
    const content = document.createElement('div');
    const accordion = document.createElement('details');
    accordion.open = true;
    const card = document.createElement('div');
    card.className = 'qc-metric-card qc-metric-status-pending';
    card.dataset.qcStatusMetric = 'drift';
    accordion.appendChild(card);
    content.appendChild(accordion);

    syncQcStatusShading(content, { drift: 'Fail' });

    expect(accordion.open).toBe(true);
    expect(content.querySelector('details')).toBe(accordion);
    expect(card.classList.contains('qc-metric-status-fail')).toBe(true);
    expect(card.classList.contains('qc-metric-status-pending')).toBe(false);
  });

  it('updates a linked status when an editable dropdown changes', () => {
    mountQcEditor.mockClear();
    window.history.replaceState({}, '', '/quality_control?name=asset-1');
    const view = createQCView({
      name: 'asset-1',
      quality_control: {
        default_grouping: ['probe'],
        metrics: [{
          name: 'quality',
          tags: { probe: 'A' },
          value: { type: 'dropdown', options: ['good', 'bad'], value: 'good', status: ['Pass', 'Fail'] },
          status_history: [{ status: 'Pass' }],
        }],
      },
    });
    const editorOptions = mountQcEditor.mock.calls.at(-1)[2];
    const state = {
      enabled: true,
      editableMetricNames: new Set(['quality']),
      valueDrafts: { quality: JSON.stringify({ type: 'dropdown', options: ['good', 'bad'], value: 'good', status: ['Pass', 'Fail'] }) },
      statusDrafts: { quality: 'Pass' },
      fieldErrors: {},
      allowEditingValues: true,
      draftRevision: 0,
    };
    state.onValue = (name, value) => {
      state.valueDrafts[name] = value;
      state.statusDrafts[name] = 'Fail';
      editorOptions.onEditStateChange(state);
    };
    state.onStatus = () => {};
    editorOptions.onEditStateChange(state);

    const card = view.querySelector('.qc-metric-card');
    const dropdown = card.querySelector('.qc-inline-custom-select');
    dropdown.value = 'bad';
    dropdown.dispatchEvent(new Event('change', { bubbles: true }));

    expect(card.classList.contains('qc-metric-status-fail')).toBe(true);
    expect(card.querySelector('.metric-status').textContent).toContain('Fail');
    expect(card.querySelector('.status-dot').classList.contains('fail')).toBe(true);
    expect(view.querySelector('.qc-tree .tree-icon').classList.contains('fail')).toBe(true);
  });
});

describe('QC navigation state', () => {
  it('round-trips the selected tree node and open accordion references', () => {
    const child = { key: 'type', value: 'drift', label: 'type: drift', metrics: [], children: [] };
    const parent = { key: 'probe', value: 'A', label: 'probe: A', metrics: [], children: [child] };
    window.history.replaceState({}, '', '/quality_control?name=asset-1');

    writeQcNavigationState(child, [parent], new Set(['figures/a.png', '']));
    const written = new URL(window.location.href);
    expect(written.searchParams.get('tree')).toBe('probe=A/type=drift');
    expect(JSON.parse(written.searchParams.get('open'))).toEqual(['figures/a.png', '']);

    const restored = readQcNavigationState([parent]);
    expect(restored.activeNode).toBe(child);
    expect(restored.openReferences).toEqual(new Set(['figures/a.png', '']));
  });

  it('loads only the first tree node and its first accordion initially', () => {
    window.history.replaceState({}, '', '/quality_control?name=asset-1');
    const view = createQCView({
      name: 'asset-1',
      location: 's3://aind-open-data/prefix',
      quality_control: {
        default_grouping: ['probe'],
        metrics: [
          { name: 'first', reference: 'figures/first.png', tags: { probe: 'A' }, status_history: [{ status: 'Pass' }] },
          { name: 'second', reference: 'figures/second.png', tags: { probe: 'B' }, status_history: [{ status: 'Pass' }] },
        ],
      },
    });
    const details = view.querySelectorAll('.qc-content details');

    expect(view.querySelectorAll('.qc-content .qc-metric-card')).toHaveLength(1);
    expect(details).toHaveLength(1);
    expect(details[0].open).toBe(true);
    expect(details[0].querySelector('img')).toBeTruthy();

    view.querySelectorAll('.qc-tree .tree-node')[1].click();
    const selectedUrl = new URL(window.location.href);
    expect(selectedUrl.searchParams.get('tree')).toBe('probe=B');
    expect(JSON.parse(selectedUrl.searchParams.get('open'))).toEqual(['figures/second.png']);
    expect(view.querySelector('.qc-content .metric-name').textContent).toBe('second');
  });
});

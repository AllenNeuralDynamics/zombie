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
import { buildSpimQcMetrics } from '../qc/spim-metrics.js';

describe('QC hierarchy for new assets', () => {
  it.each([undefined, { default_grouping: [], metrics: [] }])(
    'builds a hierarchy as SPIM metrics are queued without configured grouping (%s)', qualityControl => {
      mountQcEditor.mockClear();
      window.history.replaceState({}, '', '/quality_control?name=spim-new');
      const record = {
        name: 'spim-new',
        data_description: { data_level: 'derived' },
        instrument: { instrument_id: 'SmartSPIM' },
        acquisition: { channels: ['Ex_488_Em_525'] },
        quality_control: qualityControl,
      };
      const view = createQCView(record);
      expect(view.querySelectorAll('.tree-node')).toHaveLength(0);
      const addedMetrics = buildSpimQcMetrics(record, 'https://neuroglancer.example/#!config');
      const { onEditStateChange } = mountQcEditor.mock.calls.at(-1)[2];
      onEditStateChange({ enabled: true, draftRevision: 0, addedMetrics });
      expect([...view.querySelectorAll('.tree-node')].map(node => node.textContent.trim())).toEqual([
        'type: image quality (2)',
        'type: channel brightness (1)',
        'type: processing (3)',
      ]);
      expect(view.querySelector('.qc-content').textContent).toContain('Tissue perfusion');
      const processing = [...view.querySelectorAll('.tree-node')]
        .find(node => node.textContent.includes('type: processing'));
      processing.click();
      expect(view.querySelector('.qc-content').textContent).toContain('Image stitching');
      expect(view.querySelector('.qc-content').textContent).not.toContain('Tissue perfusion');
      onEditStateChange({ enabled: true, draftRevision: 1, addedMetrics: [] });
      expect(view.querySelectorAll('.tree-node')).toHaveLength(0);
      expect(view.querySelector('.qc-content').textContent).toContain('No QC data');
    },
  );
});

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
  it('shows path repairs in the error header and displays the repaired image', () => {
    window.history.replaceState({}, '', '/quality_control?name=asset-1');
    const reference = '/code/results/figures/image.png';
    const view = createQCView({
      name: 'asset-1',
      location: 's3://aind-open-data/asset-1',
      quality_control: { metrics: [{ name: 'image metric', reference, value: true }] },
    });
    const alert = view.querySelector('.qc-metric-alert');
    expect(view.firstElementChild).toBe(alert);
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('Metric "image metric": the media path had to be normalized');
    expect(alert.textContent).toContain('report this to the owner of the processing pipeline');
    expect(view.querySelector('img').src).toBe('https://aind-open-data.s3.us-west-2.amazonaws.com/asset-1/figures/image.png');
    expect(mountQcEditor.mock.calls.at(-1)[1].quality_control.metrics[0].reference).toBe(reference);

    view.querySelectorAll('.qc-view-toggle button')[1].click();
    expect(alert.hidden).toBe(false);
    expect(view.querySelector('.qc-reference-link').href).toContain('/asset-1/figures/image.png');
  });

  it('omits duplicate names and shows a top-of-page alert', () => {
    window.history.replaceState({}, '', '/quality_control?name=asset-1');
    const view = createQCView({
      name: 'asset-1',
      quality_control: {
        metrics: [
          { name: 'duplicate', value: true, status_history: [{ status: 'Pass' }] },
          { name: 'keep', value: 'visible', status_history: [{ status: 'Pass' }] },
          { name: 'duplicate', value: null, status_history: [{ status: 'Fail' }] },
        ],
      },
    });

    const alert = view.querySelector('[role="alert"]');
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toContain('Duplicate QC metric name "duplicate"');
    expect(view.firstElementChild).toBe(alert);
    expect([...view.querySelectorAll('.qc-metric-card .metric-name')].map(el => el.textContent)).toEqual(['keep']);

    view.querySelectorAll('.qc-view-toggle button')[1].click();
    expect([...view.querySelectorAll('.qc-metrics-table-row td:nth-child(2)')].map(el => el.textContent)).toEqual(['keep']);
  });

  it('reports an individual metric render failure without hiding valid metrics', () => {
    window.history.replaceState({}, '', '/quality_control?name=asset-1');
    const invalidValue = {};
    Object.defineProperty(invalidValue, 'type', {
      get() { throw new Error('synthetic render failure'); },
    });
    const view = createQCView({
      name: 'asset-1',
      quality_control: {
        metrics: [
          { name: 'broken', value: invalidValue, status_history: [{ status: 'Pass' }] },
          { name: 'valid', value: 'still visible', status_history: [{ status: 'Pass' }] },
        ],
      },
    });

    expect(view.querySelector('[role="alert"]').textContent).toContain('Metric "broken" failed to render: synthetic render failure');
    expect([...view.querySelectorAll('.qc-metric-card .metric-name')].map(el => el.textContent)).toEqual(['valid']);
  });

  it('renders distinct metrics and their statuses in both view modes', () => {
    window.history.replaceState({}, '', '/quality_control?name=asset-1');
    const view = createQCView({
      name: 'asset-1',
      quality_control: {
        default_grouping: ['probe'],
        metrics: [
          { name: 'first', value: true, tags: { probe: 'A' }, status_history: [{ status: 'Pass' }] },
          { name: 'second', value: null, tags: { probe: 'A' }, status_history: [{ status: 'Pending' }] },
        ],
      },
    });

    expect(view.querySelector('[role="alert"]').hidden).toBe(true);
    expect([...view.querySelectorAll('.qc-metric-card .metric-name')].map(el => el.textContent)).toEqual(['first', 'second']);
    expect([...view.querySelectorAll('.qc-metric-card .metric-value')].map(el => el.textContent)).toEqual(['true', '—']);

    view.querySelectorAll('.qc-view-toggle button')[1].click();
    expect([...view.querySelectorAll('.qc-metrics-table-row td:nth-child(2)')].map(el => el.textContent)).toEqual(['first', 'second']);
    expect([...view.querySelectorAll('.qc-metrics-table-row td:nth-child(3)')].map(el => el.textContent)).toEqual(['true', '—']);
  });

  it('renders null fields in scalar object metrics in table view', () => {
    window.history.replaceState({}, '', '/quality_control?name=asset-1');
    const view = createQCView({
      name: 'asset-1',
      quality_control: {
        default_grouping: ['type'],
        metrics: [
          { name: 'safe', value: 1, tags: { type: 'safe' }, status_history: [{ status: 'Pass' }] },
          {
            name: 'photon statistics',
            value: { 'Mean ROI Intensity': null, 'Photon Gain': 1.5 },
            tags: { type: 'statistics' },
            status_history: [{ status: 'Pass' }],
          },
        ],
      },
    });

    expect(() => view.querySelectorAll('.qc-view-toggle button')[1].click()).not.toThrow();
    expect(view.querySelector('.qc-metrics-table')).toBeTruthy();
    expect(view.querySelector('.qc-value-key-table').textContent).toContain('—');
  });

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

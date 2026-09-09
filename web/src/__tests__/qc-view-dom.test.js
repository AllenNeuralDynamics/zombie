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

describe('QC header actions', () => {
  it('keeps the view toggle beside the legacy and Login actions', () => {
    let selectedMode = null;
    const header = buildHeader('asset-1', '', '', [], [], {
      viewMode: 'table',
      onViewModeChange: mode => { selectedMode = mode; },
    });
    const buttons = [...header.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Tree view', 'Table view', 'Open Legacy QC Portal', 'Login']);
    expect(buttons[1].classList.contains('active')).toBe(true);
    expect(buttons[2].classList.contains('qc-edit-btn')).toBe(true);
    expect(buttons[3].classList.contains('qc-login-btn')).toBe(true);

    buttons[0].click();
    expect(selectedMode).toBe('tree');
    expect(buttons[0].classList.contains('active')).toBe(true);
    expect(buttons[1].classList.contains('active')).toBe(false);
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

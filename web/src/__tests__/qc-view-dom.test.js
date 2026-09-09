/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { buildHeader, syncQcStatusShading } from '../qc/view.js';

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

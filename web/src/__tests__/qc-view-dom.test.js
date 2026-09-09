/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { buildHeader, syncQcStatusShading } from '../qc/view.js';

describe('QC header actions', () => {
  it('uses the legacy label and puts a green Login button beside it', () => {
    const header = buildHeader('asset-1', '', '', [], []);
    const buttons = [...header.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Open Legacy QC Portal', 'Login']);
    expect(buttons[1].classList.contains('qc-login-btn')).toBe(true);
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

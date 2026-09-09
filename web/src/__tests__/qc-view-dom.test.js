/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { buildHeader } from '../qc/view.js';

describe('QC header actions', () => {
  it('uses the legacy label and puts a green Login button beside it', () => {
    const header = buildHeader('asset-1', '', '', [], []);
    const buttons = [...header.querySelectorAll('button')];
    expect(buttons.map(button => button.textContent)).toEqual(['Open Legacy QC Portal', 'Login']);
    expect(buttons[1].classList.contains('qc-login-btn')).toBe(true);
  });
});

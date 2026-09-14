/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../qc/editor.js', () => ({
  mountQcEditor: vi.fn(),
  readQcViewMode: () => 'tree',
  writeQcViewMode: vi.fn(),
}));

import { createQCView } from '../qc/view.js';
import { mountQcEditor } from '../qc/editor.js';

function metric(name, { reference = '', value = '' } = {}) {
  return {
    name,
    reference,
    value,
    status_history: [{ status: 'Pass' }],
  };
}

function createView(metrics) {
  window.history.replaceState({}, '', '/quality_control?name=asset-1');
  const view = createQCView({
    name: 'asset-1',
    quality_control: { default_grouping: [], metrics },
  });
  document.body.appendChild(view);
  return view;
}

function enableEditing(metrics) {
  const options = mountQcEditor.mock.calls.at(-1)[2];
  options.onEditStateChange({
    enabled: true,
    allowEditingValues: true,
    editableMetricNames: new Set(metrics.map(item => item.name)),
    valueDrafts: Object.fromEntries(metrics.map(item => [
      item.name,
      item.value && typeof item.value === 'object' ? JSON.stringify(item.value) : '',
    ])),
    statusDrafts: Object.fromEntries(metrics.map(item => [item.name, 'Pass'])),
    fieldErrors: {},
    onValue: vi.fn(),
    onStatus: vi.fn(),
    draftRevision: 0,
  });
}

function press(target, key, options = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe('QC keyboard control', () => {
  it('activates on a key and moves the metric outline with W/S', () => {
    mountQcEditor.mockClear();
    const view = createView([metric('first'), metric('second'), metric('third')]);
    const cards = [...view.querySelectorAll('.qc-metric-card')];

    press(view, 's');
    expect(view.classList.contains('qc-keyboard-control')).toBe(true);
    expect(cards[1].classList.contains('qc-metric-keyboard-active')).toBe(true);
    expect(cards[0].classList.contains('qc-metric-keyboard-active')).toBe(false);
    expect(document.activeElement).toBe(cards[1].querySelector('.metric-value'));

    press(cards[1], 'w');
    expect(cards[0].classList.contains('qc-metric-keyboard-active')).toBe(true);
    expect(cards[2].classList.contains('qc-metric-keyboard-active')).toBe(false);

    view.remove();
  });

  it('focuses the editable value widget when W/S selects a metric', () => {
    mountQcEditor.mockClear();
    const metrics = [
      metric('first', { value: { type: 'dropdown', options: ['good', 'bad'], value: 'good' } }),
      metric('second', { value: { type: 'dropdown', options: ['good', 'bad'], value: 'bad' } }),
    ];
    const view = createView(metrics);
    enableEditing(metrics);
    const cards = [...view.querySelectorAll('.qc-metric-card')];

    press(view, 's');
    expect(document.activeElement).toBe(cards[1].querySelector('.qc-inline-custom-select'));
    view.remove();
  });

  it('cycles enabled value and status controls with Tab in both directions', () => {
    mountQcEditor.mockClear();
    const metrics = [metric('first')];
    const view = createView(metrics);
    enableEditing(metrics);

    const card = view.querySelector('.qc-metric-card');
    const value = card.querySelector('.qc-inline-editor-value');
    const status = card.querySelector('.qc-inline-status');

    press(card, 'Tab');
    expect(document.activeElement).toBe(value);
    press(value, 'Tab');
    expect(document.activeElement).toBe(status);
    press(status, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(value);

    expect(press(status, 'ArrowDown').defaultPrevented).toBe(false);
    expect(press(status, 'Enter').defaultPrevented).toBe(false);
    view.remove();
  });

  it('keeps normal Tab behavior when a metric has no enabled controls', () => {
    mountQcEditor.mockClear();
    const view = createView([metric('populated', { value: 'already set' })]);
    const card = view.querySelector('.qc-metric-card');

    const event = press(card, 'Tab');
    expect(event.defaultPrevented).toBe(false);
    view.remove();
  });

  it('opens the next lazy reference group while moving forward', () => {
    mountQcEditor.mockClear();
    const view = createView([
      metric('first', { reference: 'figures/first.png' }),
      metric('second', { reference: 'figures/second.png' }),
    ]);
    const first = view.querySelector('.qc-metric-card');

    expect(view.querySelectorAll('.qc-metric-card')).toHaveLength(1);
    press(first, 's');

    expect(view.querySelectorAll('.qc-metric-card')).toHaveLength(2);
    expect(view.querySelectorAll('.qc-metric-card')[1].classList.contains('qc-metric-keyboard-active')).toBe(true);
    view.remove();
  });

  it('moves through metric rows in table view', () => {
    mountQcEditor.mockClear();
    const view = createView([metric('first'), metric('second')]);
    view.querySelectorAll('.qc-view-toggle button')[1].click();
    const rows = [...view.querySelectorAll('.qc-metrics-table-row')];

    press(view, 's');
    expect(rows[1].classList.contains('qc-metric-keyboard-active')).toBe(true);
    expect(document.activeElement).toBe(rows[1]);
    view.remove();
  });
});

/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest';
import { buildCheckboxGroup } from '../lib/checkbox-filter.js';

describe('buildCheckboxGroup', () => {
  it('renders options with a shared checkbox/text structure', () => {
    const selected = new Set(['Rig A']);
    const group = buildCheckboxGroup('Instrument ID', ['Rig A', 'Rig B'], selected);

    expect(group.wrapper.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(group.wrapper.querySelectorAll('label > span')).toHaveLength(2);
    expect(group.wrapper.querySelector('input').checked).toBe(true);
  });

  it('updates selections and clears them through the shared callbacks', () => {
    const selected = new Set();
    const onChange = vi.fn();
    const group = buildCheckboxGroup('Instrument ID', ['Rig A'], selected, onChange);
    const checkbox = group.wrapper.querySelector('input');

    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(selected).toEqual(new Set(['Rig A']));
    expect(onChange).toHaveBeenCalledTimes(1);

    group.wrapper.querySelector('button').click();
    expect(selected).toEqual(new Set());
    expect(checkbox.checked).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

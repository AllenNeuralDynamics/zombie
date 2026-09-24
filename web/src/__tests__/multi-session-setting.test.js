/**
 * multi-session-setting.test.js — the "open a multi-session view by default"
 * preference: storage round-trip, clamping, and the control's apply behavior.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMultiSessionSetting,
  readMultiSessionSetting,
  writeMultiSessionSetting,
} from '../subject/multi-session-setting.js';

beforeEach(() => {
  window.localStorage.clear();
});

describe('readMultiSessionSetting', () => {
  it('defaults to off with five sessions', () => {
    expect(readMultiSessionSetting()).toEqual({ enabled: false, count: 5 });
  });

  it('round-trips a stored preference', () => {
    writeMultiSessionSetting({ enabled: true, count: 8 });
    expect(readMultiSessionSetting()).toEqual({ enabled: true, count: 8 });
  });

  it('clamps a nonsense count into range', () => {
    writeMultiSessionSetting({ enabled: true, count: 1 });
    expect(readMultiSessionSetting().count).toBe(2);
    writeMultiSessionSetting({ enabled: true, count: 999 });
    expect(readMultiSessionSetting().count).toBe(20);
    writeMultiSessionSetting({ enabled: true, count: 'abc' });
    expect(readMultiSessionSetting().count).toBe(5);
  });

  it('survives unreadable storage', () => {
    window.localStorage.setItem('zombie.multiSessionDefault', 'not json');
    expect(readMultiSessionSetting()).toEqual({ enabled: false, count: 5 });
  });
});

describe('createMultiSessionSetting', () => {
  const parts = (el) => ({
    checkbox: el.querySelector('input[type=checkbox]'),
    count: el.querySelector('input[type=number]'),
  });

  it('applies and persists when switched on', () => {
    const onApply = vi.fn();
    const el = createMultiSessionSetting({ onApply });
    const { checkbox } = parts(el);
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));
    expect(onApply).toHaveBeenCalledWith(5);
    expect(readMultiSessionSetting()).toEqual({ enabled: true, count: 5 });
  });

  it('re-applies when the count changes while on', () => {
    writeMultiSessionSetting({ enabled: true, count: 5 });
    const onApply = vi.fn();
    const el = createMultiSessionSetting({ onApply });
    const { count } = parts(el);
    count.value = '3';
    count.dispatchEvent(new Event('change'));
    expect(onApply).toHaveBeenCalledWith(3);
    expect(readMultiSessionSetting().count).toBe(3);
  });

  it('clears the current selection when switched off', () => {
    writeMultiSessionSetting({ enabled: true, count: 4 });
    const onApply = vi.fn();
    const onClear = vi.fn();
    const el = createMultiSessionSetting({ onApply, onClear });
    const { checkbox } = parts(el);
    expect(checkbox.checked).toBe(true);
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClear).toHaveBeenCalled();
    expect(readMultiSessionSetting().enabled).toBe(false);
  });

  it('edits the count without touching the view while off', () => {
    const onApply = vi.fn();
    const onClear = vi.fn();
    const el = createMultiSessionSetting({ onApply, onClear });
    const { count } = parts(el);
    count.value = '7';
    count.dispatchEvent(new Event('change'));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClear).not.toHaveBeenCalled();
    expect(readMultiSessionSetting().count).toBe(7);
  });
});

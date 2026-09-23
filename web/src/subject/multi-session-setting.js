/**
 * subject/multi-session-setting.js — the "open a multi-session view by
 * default" preference and its control.
 *
 * People who work session-over-session want the comparison up on arrival, not
 * after a shift+click; people who arrive from a deep link want the session
 * they asked for. So this is off by default, stored per browser, and never
 * applied when the URL already names an acquisition.
 */

const STORAGE_KEY = 'zombie.multiSessionDefault';
const DEFAULT_COUNT = 5;
const MIN_COUNT = 2;
const MAX_COUNT = 20;

/**
 * Read the stored preference.
 *
 * @returns {{enabled: boolean, count: number}}
 */
export function readMultiSessionSetting() {
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false, count: DEFAULT_COUNT };
    const parsed = JSON.parse(raw);
    return {
      enabled: !!parsed?.enabled,
      count: clampCount(parsed?.count),
    };
  } catch {
    // Private mode / blocked storage — the feature is a convenience, not state.
    return { enabled: false, count: DEFAULT_COUNT };
  }
}

/**
 * Persist the preference.
 *
 * @param {{enabled: boolean, count: number}} setting
 */
export function writeMultiSessionSetting(setting) {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify({
      enabled: !!setting.enabled,
      count: clampCount(setting.count),
    }));
  } catch { /* storage unavailable */ }
}

function clampCount(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, n));
}

/**
 * Build the control. Toggling it on (or changing the count while on) applies
 * the selection immediately, so the checkbox is also the "select the last N
 * sessions" button.
 *
 * @param {object} [opts]
 * @param {(count: number) => void} [opts.onApply] - Apply the selection now.
 * @param {() => void} [opts.onClear] - Collapse the current multi-selection;
 *   switching the setting off is also how people leave the multi-session view.
 * @returns {HTMLElement}
 */
export function createMultiSessionSetting({ onApply, onClear } = {}) {
  const setting = readMultiSessionSetting();

  const wrap = document.createElement('label');
  wrap.className = 'multi-session-setting';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = setting.enabled;

  const count = document.createElement('input');
  count.type = 'number';
  count.className = 'multi-session-setting-count';
  count.min = String(MIN_COUNT);
  count.max = String(MAX_COUNT);
  count.value = String(setting.count);

  const text = document.createElement('span');
  text.textContent = ' most recent sessions by default';

  const persist = ({ apply }) => {
    const next = { enabled: checkbox.checked, count: clampCount(count.value) };
    count.value = String(next.count);
    writeMultiSessionSetting(next);
    if (!apply) return;
    if (next.enabled) onApply?.(next.count);
    else onClear?.();
  };

  checkbox.addEventListener('change', () => persist({ apply: true }));
  // Changing the count while the setting is off is a preference edit only.
  count.addEventListener('change', () => persist({ apply: checkbox.checked }));

  wrap.append(checkbox, count, text);
  return wrap;
}

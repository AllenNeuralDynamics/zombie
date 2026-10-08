// Persisted timeline selection defaults, edited from the settings dialog.
const STORAGE_KEY = 'zombie.multiSessionDefault';
const DEFAULT_COUNT = 5;
const MIN_COUNT = 2;
const MAX_COUNT = 20;

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

export function createMultiSessionSetting({ onApply, onClear } = {}) {
  const wrap = document.createElement('div');
  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'icon-btn';
  gear.setAttribute('aria-label', 'Timeline settings');
  gear.innerHTML = '<img src="/icons/gear.svg" alt="" />';
  wrap.append(gear);

  gear.addEventListener('click', () => {
    if (wrap.querySelector('dialog')) return;
    const setting = readMultiSessionSetting();
    const dialog = document.createElement('dialog');
    dialog.className = 'subject-settings-dialog';
    dialog.setAttribute('aria-label', 'Timeline settings');
    dialog.innerHTML = `
      <div class="settings-modal-content">
        <div class="settings-modal-header">
          <h3>Timeline settings</h3>
          <button type="button" class="settings-modal-close-btn" aria-label="Close settings">×</button>
        </div>
        <label class="settings-checkbox-label">
          <input type="checkbox" /> Select recent sessions by default
        </label>
        <label class="multi-session-setting">Session count
          <input type="number" class="multi-session-setting-count" min="${MIN_COUNT}" max="${MAX_COUNT}" />
        </label>
      </div>`;
    const checkbox = dialog.querySelector('input[type=checkbox]');
    const count = dialog.querySelector('input[type=number]');
    checkbox.checked = setting.enabled;
    count.value = String(setting.count);
    const persist = (apply) => {
      const next = { enabled: checkbox.checked, count: clampCount(count.value) };
      count.value = String(next.count);
      writeMultiSessionSetting(next);
      if (apply) {
        if (next.enabled) onApply?.(next.count);
        else onClear?.();
      }
    };
    checkbox.addEventListener('change', () => persist(true));
    count.addEventListener('change', () => persist(checkbox.checked));
    dialog.querySelector('button').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); gear.focus(); });
    wrap.append(dialog);
    dialog.showModal();
  });
  return wrap;
}

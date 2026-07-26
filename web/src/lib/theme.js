/**
 * theme.js — Shared dark/light toggle-button behavior.
 *
 * Pairs with the `<!--THEME_INIT-->` head snippet (rendered by
 * `web/build/header-template.js:renderThemeInit`), which applies a saved
 * theme before first paint to avoid a flash of the wrong theme. This module
 * wires up the `#theme-toggle` button: label, click-to-persist, and
 * following the OS theme when the user hasn't chosen one explicitly.
 *
 * Loaded once per page via `<script type="module" src="/src/lib/theme.js">`.
 * No-ops gracefully on pages without a `#theme-toggle` button.
 *
 * @module
 */

function isDark() {
  const t = document.documentElement.getAttribute('data-theme');
  return t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme:dark)').matches);
}

export function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function update() {
    btn.textContent = isDark() ? '\u2600' : '\u263E';
  }

  btn.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    update();
  });

  update();
  window.matchMedia('(prefers-color-scheme:dark)').addEventListener('change', update);
}

initThemeToggle();

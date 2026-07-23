/**
 * subject/viz-theme.js — dark-mode helpers shared by the three.js 3D brain
 * viewers (brain / imaging / ephys). The scene background and WebGL clear
 * colour are baked into GL state, so they must be read from the themed CSS
 * variables and refreshed when the theme changes; container / overlay text
 * colours flip on their own via CSS variables in the inline styles.
 */

/** Current scene background colour (near-black in dark mode). */
export function vizSceneBg() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--surface-bg').trim();
  return raw || '#ffffff';
}

/**
 * Invoke `cb` whenever the resolved theme changes (explicit data-theme toggle
 * or OS preference). Returns a disconnect function.
 */
export function onVizThemeChange(cb) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  if (mq && mq.addEventListener) mq.addEventListener('change', cb);
  return () => {
    mo.disconnect();
    if (mq && mq.removeEventListener) mq.removeEventListener('change', cb);
  };
}

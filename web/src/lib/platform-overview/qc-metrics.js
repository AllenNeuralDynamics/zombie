/**
 * lib/platform-overview/qc-metrics.js — "QC metrics by rig/experimenter"
 * collapsible dropdown for the platform overview.
 *
 * @module
 */

import { createPlatformQcTable } from '../platform-qc-table.js';

/**
 * @param {object} ctx  Shared overview context ({ coord, platformKey, settings, persist }).
 * @param {object} [opts]
 * @param {string|null} [opts.pendingMetricsRaw]  Comma-separated visible-metric
 *   names restored from URL/cookie, applied once metrics are discovered.
 */
export function createQcMetricsDropdown(ctx, { pendingMetricsRaw = null } = {}) {
  const { coord, platformKey, settings, persist } = ctx;

  const col = document.createElement('div');
  col.className = 'platform-dropdown-col';

  const toggle = document.createElement('button');
  toggle.className = 'platform-qc-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const arrow = document.createElement('span');
  arrow.className = 'platform-qc-toggle-arrow';
  arrow.textContent = '▶';
  toggle.appendChild(arrow);
  const labelText = document.createTextNode('');
  toggle.appendChild(labelText);
  col.appendChild(toggle);

  let allMetrics = [];
  let pending = pendingMetricsRaw;
  let rebuildMetricCheckboxes = null;

  const tableApi = createPlatformQcTable(coord, {
    platformKey,
    groupBy: settings.groupBy,
    visibleMetrics: settings.visibleMetrics,
    since: settings.since,
  });

  tableApi.onMetricsDiscovered((metrics) => {
    allMetrics = metrics;
    if (pending !== null) {
      const saved = new Set(pending.split(',').filter(Boolean));
      if (saved.size > 0) {
        const restored = new Set(metrics.filter((m) => saved.has(m)));
        settings.visibleMetrics = restored.size === metrics.length ? null : restored;
        tableApi.setVisibleMetrics(settings.visibleMetrics);
      }
      pending = null;
      persist(); // push restored metrics to URL
    }
    if (rebuildMetricCheckboxes) rebuildMetricCheckboxes();
  });

  // Collapsed by default
  tableApi.el.hidden = true;
  col.appendChild(tableApi.el);

  function updateLabel() {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    arrow.textContent = expanded ? '▼' : '▶';
    labelText.textContent = ` QC metrics by ${settings.groupBy === 'experimenter' ? 'experimenter' : 'rig'}`;
  }
  updateLabel();

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    tableApi.el.hidden = !expanded;
    updateLabel();
  });

  return {
    col,
    tableApi,
    updateLabel,
    getMetrics: () => allMetrics,
    setRebuildMetrics: (fn) => { rebuildMetricCheckboxes = fn; },
  };
}

/**
 * lib/platform-overview/time-to-qc.js — "Time to QC" collapsible dropdown
 * (histogram of days-to-QC + pending count) for the platform overview.
 *
 * @module
 */

import * as Plot from '@observablehq/plot';
import { queryRows } from '../arrow.js';
import { ensureTable } from '../registry.js';
import { buildFilterCondition } from './helpers.js';

/**
 * @param {object} ctx  Shared overview context
 *   ({ coord, assetFilter, platformTableName, assetNameCol }).
 */
export function createTimeToQcDropdown(ctx) {
  const { coord, assetFilter, platformTableName, assetNameCol } = ctx;

  const col = document.createElement('div');
  col.className = 'platform-dropdown-col';

  const toggle = document.createElement('button');
  toggle.className = 'platform-qc-toggle';
  toggle.setAttribute('aria-expanded', 'false');

  const arrow = document.createElement('span');
  arrow.className = 'platform-qc-toggle-arrow';
  arrow.textContent = '▶';
  toggle.appendChild(arrow);
  toggle.appendChild(document.createTextNode(' Time to QC'));

  const content = document.createElement('div');
  content.className = 'platform-ttq-section';
  content.hidden = true;

  col.appendChild(toggle);
  col.appendChild(content);

  let built = false;

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    arrow.textContent = expanded ? '▼' : '▶';
    content.hidden = !expanded;
    if (expanded && !built) {
      built = true;
      loadTimeToQcHistogram(coord, { assetFilter, platformTableName, assetNameCol }, content);
    }
  });

  return { col };
}

/**
 * Fetch time-to-QC data for this platform's assets and render a histogram.
 *
 * Joins time_to_qc with asset_basics so the filter (e.g. modality) scopes
 * the histogram to just this platform's derived assets.
 * Rows with days_to_qc >= 300 are treated as pending (qc_time set to "now").
 */
async function loadTimeToQcHistogram(coord, { assetFilter, platformTableName, assetNameCol }, containerEl) {
  const loadingEl = document.createElement('p');
  loadingEl.className = 'settings-loading-note';
  loadingEl.textContent = 'Loading…';
  containerEl.appendChild(loadingEl);

  try {
    await ensureTable(coord, 'time_to_qc');

    let sql;
    if (platformTableName && assetNameCol) {
      await ensureTable(coord, platformTableName);
      sql = `
        WITH ttq AS (
          SELECT name,
            MAX(qc_time) AS qc_time,
            MAX(process_end_time) AS process_end_time
          FROM time_to_qc
          GROUP BY name
        ),
        platform_names AS (
          SELECT DISTINCT ${assetNameCol} AS n FROM ${platformTableName}
        )
        SELECT
          CASE WHEN t.name IS NULL THEN NULL
               ELSE epoch(CAST(t.qc_time AS TIMESTAMP) - CAST(t.process_end_time AS TIMESTAMP)) / 86400.0
          END AS days_to_qc,
          CASE WHEN t.name IS NULL THEN true
               WHEN epoch(CAST((SELECT MAX(qc_time) FROM time_to_qc) AS TIMESTAMP) - CAST(t.qc_time AS TIMESTAMP)) < 900 THEN true
               ELSE false
          END AS is_pending
        FROM platform_names p
        LEFT JOIN ttq t ON t.name = p.n
      `;
    } else {
      const filterCond = buildFilterCondition(assetFilter);
      sql = `
        WITH ttq AS (
          SELECT name,
            MAX(qc_time) AS qc_time,
            MAX(process_end_time) AS process_end_time
          FROM time_to_qc
          GROUP BY name
        )
        SELECT
          epoch(CAST(t.qc_time AS TIMESTAMP) - CAST(t.process_end_time AS TIMESTAMP)) / 86400.0 AS days_to_qc,
          CASE WHEN epoch(CAST((SELECT MAX(qc_time) FROM time_to_qc) AS TIMESTAMP) - CAST(t.qc_time AS TIMESTAMP)) < 900 THEN true
               ELSE false
          END AS is_pending
        FROM ttq t
        INNER JOIN asset_basics a ON t.name = a.name
        WHERE ${filterCond}
          AND a.data_level = 'derived'
      `;
    }

    const rows = await queryRows(coord, sql);
    const completed = rows.filter((r) => !r.is_pending && r.days_to_qc !== null);
    const pendingCount = rows.filter((r) => r.is_pending).length;

    loadingEl.remove();

    if (!completed.length && !pendingCount) {
      const empty = document.createElement('p');
      empty.className = 'settings-loading-note';
      empty.textContent = 'No time-to-QC data.';
      containerEl.appendChild(empty);
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'platform-ttq-charts';
    containerEl.appendChild(wrapper);

    // Compute max bin count so both charts share the same y domain
    const BIN_COUNT = 20;
    let maxBinCount = 1;
    if (completed.length > 1) {
      const minD = Math.min(...completed.map((r) => r.days_to_qc));
      const maxD = Math.max(...completed.map((r) => r.days_to_qc));
      const binW = (maxD - minD) / BIN_COUNT;
      const counts = new Array(BIN_COUNT).fill(0);
      for (const r of completed) {
        const i = Math.min(Math.floor((r.days_to_qc - minD) / binW), BIN_COUNT - 1);
        counts[i]++;
      }
      maxBinCount = Math.max(...counts);
    }
    const yMax = Math.max(maxBinCount, pendingCount) * 1.15;

    const CHART_HEIGHT = 220;
    const MARGIN_TOP = 20;
    const MARGIN_BOTTOM = 52;

    // ── Left: histogram of completed assets ──────────────────────────────
    const histPlot = Plot.plot({
      width: 340,
      height: CHART_HEIGHT,
      marginLeft: 55,
      marginRight: 8,
      marginTop: MARGIN_TOP,
      marginBottom: MARGIN_BOTTOM,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      x: { label: 'Days to QC (completed) →' },
      y: { label: '↑ Assets', grid: true, domain: [0, yMax] },
      marks: [
        Plot.rectY(completed, Plot.binX({ y: 'count' }, { x: 'days_to_qc', thresholds: BIN_COUNT })),
        Plot.ruleY([0]),
      ],
    });
    wrapper.appendChild(histPlot);

    // ── Right: single bar for pending ─────────────────────────────────────
    // Width tuned so the band bar width ≈ one histogram bin width.
    // Histogram inner width: 340-55-8=277px / 20 bins ≈ 13.85px/bin.
    // Band scale (one item): bar = inner * 0.45; with insets 10+10: bar ≈ 13px.
    const pendingData = [{ label: 'Pending', count: pendingCount }];
    const pendingPlot = Plot.plot({
      width: 90,
      height: CHART_HEIGHT,
      marginLeft: 8,
      marginRight: 8,
      marginTop: MARGIN_TOP,
      marginBottom: MARGIN_BOTTOM,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      x: { label: null, domain: ['Pending'] },
      y: { axis: null, domain: [0, yMax] },
      marks: [
        Plot.barY(pendingData, { x: 'label', y: 'count', fill: 'steelblue', insetLeft: 10, insetRight: 10 }),
        Plot.text(pendingData, { x: 'label', y: 'count', text: (d) => d.count.toLocaleString(), dy: -6, fontSize: 10 }),
        Plot.ruleY([0]),
      ],
    });
    wrapper.appendChild(pendingPlot);

  } catch (err) {
    loadingEl.textContent = `Failed to load: ${err.message}`;
    console.error('[PlatformOverview] time-to-QC histogram failed:', err);
  }
}

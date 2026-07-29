/**
 * lib/platform-overview.js — Platform overview section: standard header (summary
 * stats + modality histogram) plus four collapsible dropdowns and a settings
 * gear.
 *
 * This module only aggregates: it builds the shell (heading, gear, stats line,
 * histogram, dropdowns row), owns the shared settings state + persistence, and
 * mounts the four dropdown widgets and the settings modal. Each dropdown lives
 * in its own module under `platform-overview/`.
 *
 * Call createPlatformOverview() on platform pages that need the full overview.
 *
 * @module
 */

import { arrowTableToRows } from './arrow.js';
import { buildModalityHistogram } from './charts.js';
import { readCookie, writeCookie, buildFilterCondition } from './platform-overview/helpers.js';
import { createQcMetricsDropdown } from './platform-overview/qc-metrics.js';
import { createSessionSummaryDropdown } from './platform-overview/session-summary.js';
import { createTimeToQcDropdown } from './platform-overview/time-to-qc.js';
import { createProcessingStatusDropdown } from './platform-overview/processing-status.js';
import { createSettingsModal } from './platform-overview/settings-modal.js';

/**
 * Create the full platform overview section.
 *
 * @param {object} coord
 * @param {object} opts
 * @param {string|null}  [opts.platformTableName]  Already-registered DuckDB table name.
 *   When provided, the summary-count query counts assets from this table.
 *   When null, counts come from asset_basics filtered by assetFilter.
 * @param {string|null}  [opts.assetNameCol]  Column holding asset names in platformTableName.
 * @param {object}       [opts.assetFilter]   Filter spec: { type, value } passed to QC table.
 * @param {string|null}  [opts.platformKey]   Cookie/URL namespace for persisted settings.
 * @param {string|null}  [opts.operationsTableName]  Partitioned operations table for the
 *   "Processing status" dropdown (fib only). Null → that dropdown is empty.
 * @returns {HTMLElement}
 */
export function createPlatformOverview(coord, {
  platformTableName = null,
  assetNameCol = null,
  assetFilter = null,
  platformKey = null,
  operationsTableName = null,
} = {}) {
  const section = document.createElement('div');
  section.className = 'platform-overview';

  // ─── Heading row with gear ─────────────────────────────────────────────────
  const headingRow = document.createElement('div');
  headingRow.className = 'platform-overview-heading-row';

  const heading = document.createElement('h3');
  heading.className = 'platform-summary-heading';
  heading.textContent = 'Platform overview';
  headingRow.appendChild(heading);

  const gearBtn = document.createElement('button');
  gearBtn.className = 'platform-overview-gear icon-btn';
  gearBtn.setAttribute('aria-label', 'Overview settings');
  gearBtn.title = 'Overview settings';
  gearBtn.innerHTML = '<img src="/icons/gear.svg" alt="Settings" />';
  headingRow.appendChild(gearBtn);

  section.appendChild(headingRow);

  // ─── Body row: left column (stats) + right column (histogram) ──────────────
  const bodyRow = document.createElement('div');
  bodyRow.className = 'platform-overview-body';
  section.appendChild(bodyRow);

  const leftCol = document.createElement('div');
  leftCol.className = 'platform-overview-left';
  bodyRow.appendChild(leftCol);

  const histogramCol = document.createElement('div');
  histogramCol.className = 'platform-overview-histogram';
  bodyRow.appendChild(histogramCol);

  const histogramPlot = document.createElement('div');
  histogramPlot.className = 'platform-overview-histogram-plot';
  histogramCol.appendChild(histogramPlot);

  // ─── Summary stats line ────────────────────────────────────────────────────
  const statsEl = document.createElement('div');
  statsEl.className = 'platform-summary-stats';
  statsEl.textContent = 'Loading summary…';
  leftCol.appendChild(statsEl);

  // ─── Collapsible dropdowns row ─────────────────────────────────────────────
  const dropdownsRow = document.createElement('div');
  dropdownsRow.className = 'platform-dropdowns-row';
  section.appendChild(dropdownsRow);

  // ─── Settings state (initialised from URL param + cookies) ────────────────
  const _cookiePrefix = platformKey ? `ov_${platformKey}` : null;
  const _urlParams = new URLSearchParams(window.location.search);
  const _urlGroup = _urlParams.get('ov_group');
  const _urlMetricsRaw = _urlParams.get('ov_metrics');
  const _urlSince = _urlParams.get('ov_since'); // null=absent, ''=all-time, 'YYYY-MM-DD'=filter
  const _urlSumBy = _urlParams.get('ov_sum_by');
  const _urlSumInstrumentsRaw = _urlParams.get('ov_sum_instruments');
  const _urlSumExperimentersRaw = _urlParams.get('ov_sum_experimenters');
  const _cookieGroup = _cookiePrefix ? readCookie(`${_cookiePrefix}_group`) : null;
  const _cookieMetricsRaw = _cookiePrefix ? readCookie(`${_cookiePrefix}_metrics`) : null;
  const _cookieSince = _cookiePrefix ? readCookie(`${_cookiePrefix}_since`) : null;
  const _cookieSumBy = _cookiePrefix ? readCookie(`${_cookiePrefix}_sum_by`) : null;
  const _cookieSumInstrumentsRaw = _cookiePrefix ? readCookie(`${_cookiePrefix}_sum_instruments`) : null;
  const _cookieSumExperimentersRaw = _cookiePrefix ? readCookie(`${_cookiePrefix}_sum_experimenters`) : null;

  function _rawToSet(raw) {
    if (raw === null || raw === undefined || raw === '*') return null; // null = all
    if (raw === '') return new Set(); // empty string = none selected
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }

  // Compute default "since" date: 6 months ago.
  function _sixMonthsAgo() {
    const d = new Date();
    d.setMonth(d.getMonth() - 6);
    return d.toISOString().slice(0, 10);
  }

  // URL takes priority over cookie; null for both means first visit → default.
  const _rawSince = _urlSince !== null ? _urlSince : _cookieSince;

  const settings = {
    groupBy:
      _urlGroup === 'rig' || _urlGroup === 'experimenter' ? _urlGroup
      : _cookieGroup === 'rig' || _cookieGroup === 'experimenter' ? _cookieGroup
      : 'rig',
    visibleMetrics: null, // null = show all; restored after metrics load
    since: _rawSince !== null ? (_rawSince || null) : _sixMonthsAgo(),
    summaryRowBy:
      _urlSumBy === 'project' || _urlSumBy === 'experimenter' ? _urlSumBy
      : _cookieSumBy === 'project' || _cookieSumBy === 'experimenter' ? _cookieSumBy
      : 'project',
    summaryInstruments: _rawToSet(_urlSumInstrumentsRaw ?? _cookieSumInstrumentsRaw),
    summaryExperimenters: _rawToSet(_urlSumExperimentersRaw ?? _cookieSumExperimentersRaw),
  };
  // URL takes priority over cookie for metric visibility.
  const _pendingMetricsRaw = _urlMetricsRaw ?? _cookieMetricsRaw; // comma-separated string or null

  /** Persist current settings to cookie and URL. */
  function _persistSettings() {
    if (!_cookiePrefix) return;
    writeCookie(`${_cookiePrefix}_group`, settings.groupBy);
    const metricsVal = settings.visibleMetrics ? [...settings.visibleMetrics].join(',') : '';
    writeCookie(`${_cookiePrefix}_metrics`, metricsVal);
    writeCookie(`${_cookiePrefix}_since`, settings.since ?? '');
    writeCookie(`${_cookiePrefix}_sum_by`, settings.summaryRowBy);
    // Use '*' as the sentinel for null (= all selected) so it round-trips
    // through cookies without collapsing to '' (= none selected).
    const instrVal = settings.summaryInstruments === null ? '*' : [...settings.summaryInstruments].join(',');
    const expVal = settings.summaryExperimenters === null ? '*' : [...settings.summaryExperimenters].join(',');
    writeCookie(`${_cookiePrefix}_sum_instruments`, instrVal);
    writeCookie(`${_cookiePrefix}_sum_experimenters`, expVal);
    const p = new URLSearchParams(window.location.search);
    p.set('ov_group', settings.groupBy);
    if (metricsVal) {
      p.set('ov_metrics', metricsVal);
    } else {
      p.delete('ov_metrics');
    }
    p.set('ov_since', settings.since ?? '');
    p.set('ov_sum_by', settings.summaryRowBy);
    // Use '*' in URL too so the round-trip is consistent.
    if (instrVal && instrVal !== '*') { p.set('ov_sum_instruments', instrVal); } else { p.delete('ov_sum_instruments'); }
    if (expVal && expVal !== '*') { p.set('ov_sum_experimenters', expVal); } else { p.delete('ov_sum_experimenters'); }
    history.replaceState({}, '', `?${p.toString()}`);
  }
  // Push whatever was resolved (from URL or cookie) into the URL immediately.
  _persistSettings();

  // ─── Shared context + dropdowns ────────────────────────────────────────────
  const ctx = {
    coord,
    assetFilter,
    platformKey,
    platformTableName,
    assetNameCol,
    operationsTableName,
    settings,
    persist: _persistSettings,
  };

  const qcApi = createQcMetricsDropdown(ctx, { pendingMetricsRaw: _pendingMetricsRaw });
  const summaryApi = createSessionSummaryDropdown(ctx);
  const ttq = createTimeToQcDropdown(ctx);
  const ops = createProcessingStatusDropdown(ctx);

  dropdownsRow.append(qcApi.col, summaryApi.col, ttq.col, ops.col);

  createSettingsModal(ctx, { gearBtn, qcApi, summaryApi });

  // ─── Load header content ───────────────────────────────────────────────────
  loadStats(coord, { platformTableName, assetNameCol, assetFilter }, statsEl);
  loadHistogram(coord, { assetFilter }, histogramPlot);

  return section;
}

/**
 * Populate the stats element with the total asset count.
 *
 * If platformTableName is provided, counts distinct assetNameCol values from
 * that table (e.g. 'platform_smartspim').  Otherwise, counts from asset_basics
 * filtered by assetFilter.
 */
function loadStats(coord, { platformTableName, assetNameCol, assetFilter }, statsEl) {
  let totalSql;
  if (platformTableName && assetNameCol) {
    totalSql = `SELECT COUNT(DISTINCT ${assetNameCol}) AS cnt FROM ${platformTableName}`;
  } else {
    const filterCond = buildFilterCondition(assetFilter);
    totalSql = `SELECT COUNT(*) AS cnt FROM asset_basics WHERE ${filterCond}`;
  }

  coord
    .query(totalSql)
    .then((result) => {
      const rows = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : Array.from(result ?? []);
      const row = rows[0] ?? {};
      const total = Number(row.cnt ?? 0);

      statsEl.textContent = '';

      const countSpan = document.createElement('span');
      countSpan.className = 'platform-summary-count';
      countSpan.textContent = `${total.toLocaleString()} Assets`;
      statsEl.appendChild(countSpan);
    })
    .catch((err) => {
      console.error('[PlatformOverview] stats query failed:', err?.message ?? err, err);
      statsEl.textContent = `Summary unavailable: ${err?.message ?? err}`;
    });
}

/**
 * Fetch filtered assets from asset_basics and render a modality histogram
 * into the given container element.
 */
function loadHistogram(coord, { assetFilter }, containerEl) {
  const filterCond = buildFilterCondition(assetFilter);
  coord
    .query(
      `SELECT acquisition_start_time, modalities
       FROM asset_basics
       WHERE ${filterCond}
         AND (data_level IS NULL OR data_level != 'derived')
         AND acquisition_start_time IS NOT NULL
         AND modalities IS NOT NULL`,
    )
    .then((result) => {
      const rows = arrowTableToRows(result);

      function render() {
        const width = containerEl.getBoundingClientRect().width || 500;
        const plot = buildModalityHistogram(rows, width);
        containerEl.innerHTML = '';
        if (plot) containerEl.appendChild(plot);
      }

      render();

      const ro = new ResizeObserver(() => render());
      ro.observe(containerEl);
    })
    .catch((err) => {
      console.error('[PlatformOverview] histogram query failed:', err?.message ?? err);
    });
}

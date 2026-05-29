/**
 * lib/platform-overview.js — Platform overview section with summary stats,
 * QC metrics table, and a settings gear.
 *
 * Call createPlatformOverview() instead of createPlatformSummaryBanner() on
 * platform pages that need the full overview with QC stats.
 *
 * @module
 */

import { createPlatformQcTable } from './platform-qc-table.js';
import { buildModalityHistogram } from './charts.js';
import { arrowTableToRows } from './assets-table.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a cookie value by name, or null if absent. */
function _readCookie(name) {
  const m = ('; ' + document.cookie).split(`; ${name}=`);
  if (m.length < 2) return null;
  return decodeURIComponent(m.pop().split(';')[0]);
}

/** Write a persistent cookie (1-year expiry, SameSite=Lax). */
function _writeCookie(name, value) {
  const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
}

function buildFilterCondition(assetFilter) {
  if (!assetFilter) return '1=1';
  const safeVal = String(assetFilter.value ?? '').replace(/'/g, "''");
  if (assetFilter.type === 'modality') return `modalities ILIKE '%${safeVal}%'`;
  if (assetFilter.type === 'acquisition_type') return `acquisition_type = '${safeVal}'`;
  if (assetFilter.type === 'acquisition_type_regex') return `regexp_matches(acquisition_type, '${safeVal}')`;
  return '1=1';
}

const UPGRADE_S3_PATH =
  'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/zs_metadata_upgrade.pqt';

let _upgradeReady = null;

function ensureUpgradeTable(coord) {
  if (!_upgradeReady) {
    _upgradeReady = coord
      .exec(
        `CREATE OR REPLACE TABLE zs_metadata_upgrade AS SELECT * FROM read_parquet('${UPGRADE_S3_PATH}')`,
      )
      .catch((err) => {
        _upgradeReady = null;
        throw err;
      });
  }
  return _upgradeReady;
}

/**
 * Create the full platform overview section: summary stats + QC table + gear.
 *
 * @param {object} coord
 * @param {object} opts
 * @param {string|null}  [opts.platformTableName]  Already-registered DuckDB table name.
 *   When provided, the upgrade-stats query counts assets from this table.
 *   When null, counts come from asset_basics filtered by assetFilter.
 * @param {string|null}  [opts.assetNameCol]  Column holding asset names in platformTableName.
 * @param {object}       opts.assetFilter     Filter spec: { type, value } passed to QC table.
 * @returns {HTMLElement}
 */
export function createPlatformOverview(coord, {
  platformTableName = null,
  assetNameCol = null,
  assetFilter = null,
  platformKey = null,
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

  // ─── Body row: left column (stats + QC toggle) + right column (histogram) ──
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

  // ─── QC table collapsible section ──────────────────────────────────────────
  const qcToggle = document.createElement('button');
  qcToggle.className = 'platform-qc-toggle';
  qcToggle.setAttribute('aria-expanded', 'false');

  const qcArrow = document.createElement('span');
  qcArrow.className = 'platform-qc-toggle-arrow';
  qcArrow.textContent = '▶';
  qcToggle.appendChild(qcArrow);
  const qcLabelText = document.createTextNode('');
  qcToggle.appendChild(qcLabelText);

  section.appendChild(qcToggle);

  // ─── Settings state (initialised from URL param + cookies) ────────────────
  const _cookiePrefix = platformKey ? `ov_${platformKey}` : null;
  const _urlParams = new URLSearchParams(window.location.search);
  const _urlGroup = _urlParams.get('ov_group');
  const _urlMetricsRaw = _urlParams.get('ov_metrics');
  const _cookieGroup = _cookiePrefix ? _readCookie(`${_cookiePrefix}_group`) : null;
  const _cookieMetricsRaw = _cookiePrefix ? _readCookie(`${_cookiePrefix}_metrics`) : null;

  const settings = {
    groupBy:
      _urlGroup === 'rig' || _urlGroup === 'experimenter' ? _urlGroup
      : _cookieGroup === 'rig' || _cookieGroup === 'experimenter' ? _cookieGroup
      : 'rig',
    visibleMetrics: null, // null = show all; restored after metrics load
  };
  // URL takes priority over cookie for metric visibility.
  let _pendingMetricsRaw = _urlMetricsRaw ?? _cookieMetricsRaw; // comma-separated string or null
  let allMetrics = [];
  let rebuildMetricCheckboxes = null; // set while modal is open

  /** Persist current settings to cookie and URL. */
  function _persistSettings() {
    if (!_cookiePrefix) return;
    _writeCookie(`${_cookiePrefix}_group`, settings.groupBy);
    const metricsVal = settings.visibleMetrics ? [...settings.visibleMetrics].join(',') : '';
    _writeCookie(`${_cookiePrefix}_metrics`, metricsVal);
    const p = new URLSearchParams(window.location.search);
    p.set('ov_group', settings.groupBy);
    if (metricsVal) {
      p.set('ov_metrics', metricsVal);
    } else {
      p.delete('ov_metrics');
    }
    history.replaceState({}, '', `?${p.toString()}`);
  }
  // Push whatever was resolved (from URL or cookie) into the URL immediately.
  _persistSettings();
  // ─── QC table widget ──────────────────────────────────────────────────────
  const qcTableApi = createPlatformQcTable(coord, {
    platformKey,
    groupBy: settings.groupBy,
    visibleMetrics: settings.visibleMetrics,
  });

  qcTableApi.onMetricsDiscovered((metrics) => {
    allMetrics = metrics;
    if (_pendingMetricsRaw !== null) {
      const saved = new Set(_pendingMetricsRaw.split(',').filter(Boolean));
      if (saved.size > 0) {
        const restored = new Set(metrics.filter((m) => saved.has(m)));
        settings.visibleMetrics = restored.size === metrics.length ? null : restored;
        qcTableApi.setVisibleMetrics(settings.visibleMetrics);
      }
      _pendingMetricsRaw = null;
      _persistSettings(); // push restored metrics to URL
    }
    if (rebuildMetricCheckboxes) rebuildMetricCheckboxes();
  });

  // Collapsed by default
  qcTableApi.el.hidden = true;
  section.appendChild(qcTableApi.el);

  function updateQcLabel() {
    const expanded = qcToggle.getAttribute('aria-expanded') === 'true';
    qcArrow.textContent = expanded ? '▼' : '▶';
    qcLabelText.textContent = ` QC metrics by ${settings.groupBy === 'experimenter' ? 'experimenter' : 'rig'}`;
  }
  updateQcLabel();

  qcToggle.addEventListener('click', () => {
    const expanded = qcToggle.getAttribute('aria-expanded') !== 'true';
    qcToggle.setAttribute('aria-expanded', String(expanded));
    qcTableApi.el.hidden = !expanded;
    updateQcLabel();
  });

  // ─── Settings modal ───────────────────────────────────────────────────────
  let modalOpen = false;
  let modal = null;

  function openSettingsModal() {
    if (modalOpen) {
      closeModal();
      return;
    }

    modal = document.createElement('div');
    modal.className = 'assets-settings-modal';

    const content = document.createElement('div');
    content.className = 'settings-modal-content';
    modal.appendChild(content);

    const title = document.createElement('h3');
    title.textContent = 'Overview Settings';
    content.appendChild(title);

    // ── Group-by radios ────────────────────────────────────────────────────
    const grpSection = document.createElement('div');
    grpSection.className = 'settings-section';

    const grpLabel = document.createElement('div');
    grpLabel.className = 'settings-section-label';
    grpLabel.textContent = 'Group rows by';
    grpSection.appendChild(grpLabel);

    for (const [val, text] of [['rig', 'Rig'], ['experimenter', 'Experimenter']]) {
      const lbl = document.createElement('label');
      lbl.className = 'settings-checkbox-label';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'platform-ov-groupby';
      radio.value = val;
      radio.checked = settings.groupBy === val;
      radio.addEventListener('change', () => {
        if (radio.checked && val !== settings.groupBy) {
          settings.groupBy = val;
          _persistSettings();
          updateQcLabel();
          qcTableApi.setGroupBy(val);
        }
      });      const span = document.createElement('span');
      span.textContent = text;
      lbl.appendChild(radio);
      lbl.appendChild(span);
      grpSection.appendChild(lbl);
    }
    content.appendChild(grpSection);

    // ── Metric filter ──────────────────────────────────────────────────────
    const statusSection = document.createElement('div');
    statusSection.className = 'settings-section';

    const statusLabel = document.createElement('div');
    statusLabel.className = 'settings-section-label';
    statusLabel.textContent = 'Show metric columns';
    statusSection.appendChild(statusLabel);

    function buildCheckboxes() {
      // Remove all children after the label
      while (statusSection.children.length > 1) {
        statusSection.removeChild(statusSection.lastChild);
      }

      if (!allMetrics.length) {
        const note = document.createElement('p');
        note.className = 'settings-loading-note';
        note.textContent = 'Loading metrics…';
        statusSection.appendChild(note);
        return;
      }

      // Search box
      const searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = 'Search metrics…';
      searchInput.className = 'settings-metric-search';
      statusSection.appendChild(searchInput);

      // Select / Clear buttons
      const btnRow = document.createElement('div');
      btnRow.className = 'settings-metric-btn-row';
      const selAllBtn = document.createElement('button');
      selAllBtn.type = 'button';
      selAllBtn.className = 'settings-metric-btn';
      selAllBtn.textContent = 'Select all';
      const clrAllBtn = document.createElement('button');
      clrAllBtn.type = 'button';
      clrAllBtn.className = 'settings-metric-btn';
      clrAllBtn.textContent = 'Clear all';
      btnRow.appendChild(selAllBtn);
      btnRow.appendChild(clrAllBtn);
      statusSection.appendChild(btnRow);

      const listWrap = document.createElement('div');
      listWrap.className = 'settings-metric-list';
      statusSection.appendChild(listWrap);

      function renderList(filter) {
        listWrap.innerHTML = '';
        const low = (filter ?? '').toLowerCase();
        const shown = low ? allMetrics.filter((m) => m.toLowerCase().includes(low)) : allMetrics;
        for (const m of shown) {
          const isVisible = settings.visibleMetrics === null || settings.visibleMetrics.has(m);
          const lbl = document.createElement('label');
          lbl.className = 'settings-checkbox-label';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = isVisible;
          cb.addEventListener('change', () => {
            if (settings.visibleMetrics === null) {
              settings.visibleMetrics = new Set(allMetrics);
            }
            if (cb.checked) {
              settings.visibleMetrics.add(m);
            } else {
              settings.visibleMetrics.delete(m);
            }
            _persistSettings();
            qcTableApi.setVisibleMetrics(settings.visibleMetrics);
          });
          const span = document.createElement('span');
          span.textContent = m;
          lbl.appendChild(cb);
          lbl.appendChild(span);
          listWrap.appendChild(lbl);
        }
      }

      searchInput.addEventListener('input', () => renderList(searchInput.value));
      selAllBtn.addEventListener('click', () => {
        settings.visibleMetrics = null;
        _persistSettings();
        qcTableApi.setVisibleMetrics(null);
        renderList(searchInput.value);
      });
      clrAllBtn.addEventListener('click', () => {
        settings.visibleMetrics = new Set();
        _persistSettings();
        qcTableApi.setVisibleMetrics(settings.visibleMetrics);
        renderList(searchInput.value);
      });

      renderList();
    }

    rebuildMetricCheckboxes = buildCheckboxes;
    buildCheckboxes();
    content.appendChild(statusSection);

    // ── Close button ───────────────────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'settings-modal-actions';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-close-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', closeModal);
    actions.appendChild(closeBtn);
    content.appendChild(actions);

    document.body.appendChild(modal);
    modalOpen = true;

    setTimeout(() => {
      document.addEventListener('click', outsideClickHandler, true);
    }, 0);
  }

  function closeModal() {
    if (modal) {
      modal.remove();
      modal = null;
    }
    modalOpen = false;
    rebuildMetricCheckboxes = null;
    document.removeEventListener('click', outsideClickHandler, true);
  }

  function outsideClickHandler(e) {
    if (modal && !modal.contains(e.target) && e.target !== gearBtn) {
      closeModal();
    }
  }

  gearBtn.addEventListener('click', openSettingsModal);

  // ─── Load upgrade/summary stats ───────────────────────────────────────────
  loadStats(coord, { platformTableName, assetNameCol, assetFilter }, statsEl);

  // ─── Load modality histogram ───────────────────────────────────────────────
  loadHistogram(coord, { assetFilter }, histogramPlot);

  return section;
}

/**
 * Populate the stats element with total asset count and failed-upgrade count.
 *
 * If platformTableName is provided, counts distinct assetNameCol values from
 * that table (e.g. 'assets_smartspim').  Otherwise, counts from asset_basics
 * filtered by assetFilter.
 */
function loadStats(coord, { platformTableName, assetNameCol, assetFilter }, statsEl) {
  let totalSql;
  let failedSql;

  if (platformTableName && assetNameCol) {
    totalSql = `SELECT COUNT(DISTINCT ${assetNameCol}) AS cnt FROM ${platformTableName}`;
    failedSql =
      `SELECT COUNT(*) AS cnt FROM zs_metadata_upgrade ` +
      `WHERE status = 'failed' AND name IN ` +
      `(SELECT DISTINCT ${assetNameCol} FROM ${platformTableName})`;
  } else {
    const filterCond = buildFilterCondition(assetFilter);
    totalSql = `SELECT COUNT(*) AS cnt FROM asset_basics WHERE ${filterCond}`;
    failedSql =
      `SELECT COUNT(*) AS cnt FROM zs_metadata_upgrade ` +
      `WHERE status = 'failed' AND name IN ` +
      `(SELECT name FROM asset_basics WHERE ${filterCond})`;
  }

  ensureUpgradeTable(coord)
    .then(() =>
      coord.query(
        `SELECT (${totalSql}) AS total_assets, (${failedSql}) AS failed_assets`,
        { type: 'json' },
      ),
    )
    .then((result) => {
      const rows = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : Array.from(result ?? []);
      const row = rows[0] ?? {};
      const total = Number(row.total_assets ?? 0);
      const failed = Number(row.failed_assets ?? 0);

      statsEl.textContent = '';

      const countSpan = document.createElement('span');
      countSpan.className = 'platform-summary-count';
      countSpan.textContent = `${total.toLocaleString()} Assets`;
      statsEl.appendChild(countSpan);

      if (failed > 0) {
        statsEl.appendChild(document.createTextNode(' ('));
        const link = document.createElement('a');
        link.className = 'platform-summary-failed-link';
        link.href = '#';
        link.textContent = `${failed.toLocaleString()} do not upgrade`;
        link.addEventListener('click', (e) => {
          e.preventDefault();
          downloadFailedUpgrades(coord, platformTableName, assetNameCol, assetFilter);
        });
        statsEl.appendChild(link);
        statsEl.appendChild(document.createTextNode(')'));
      }
    })
    .catch((err) => {
      console.error('[PlatformOverview] stats query failed:', err?.message ?? err, err);
      statsEl.textContent = `Summary unavailable: ${err?.message ?? err}`;
    });
}

function downloadFailedUpgrades(coord, platformTableName, assetNameCol, assetFilter) {
  let nameSql;
  if (platformTableName && assetNameCol) {
    nameSql = `SELECT DISTINCT ${assetNameCol} FROM ${platformTableName}`;
  } else {
    const filterCond = buildFilterCondition(assetFilter);
    nameSql = `SELECT name FROM asset_basics WHERE ${filterCond}`;
  }

  coord
    .query(
      `SELECT * FROM zs_metadata_upgrade WHERE status = 'failed' AND name IN (${nameSql})`,
      { type: 'json' },
    )
    .then((result) => {
      const rows = Array.isArray(result)
        ? result
        : Array.isArray(result?.data)
          ? result.data
          : Array.from(result ?? []);
      if (!rows.length) return;

      const cols = Object.keys(rows[0]);
      const csvLines = [
        cols.join(','),
        ...rows.map((r) =>
          cols
            .map((c) => {
              const v = r[c] ?? '';
              const s = String(v);
              return s.includes(',') || s.includes('"') || s.includes('\n')
                ? `"${s.replace(/"/g, '""')}"` : s;
            })
            .join(','),
        ),
      ];
      const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${platformTableName ?? 'platform'}_failed_upgrades.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    })
    .catch((err) => console.error('[PlatformOverview] download failed:', err));
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
      const width = containerEl.getBoundingClientRect().width || 500;
      const plot = buildModalityHistogram(rows, width);
      if (plot) containerEl.appendChild(plot);
    })
    .catch((err) => {
      console.error('[PlatformOverview] histogram query failed:', err?.message ?? err);
    });
}

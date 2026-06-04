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
import { escHtml, parseExperimenters, downloadCsv, aggregateByExperimenter } from './utils.js';

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

/** Validate that a value is a YYYY-MM-DD date string before interpolating into SQL. */
const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

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

  // ─── Collapsible dropdowns row (QC metrics | Session summary) ──────────────
  const dropdownsRow = document.createElement('div');
  dropdownsRow.className = 'platform-dropdowns-row';
  const qcCol = document.createElement('div');
  qcCol.className = 'platform-dropdown-col';
  dropdownsRow.appendChild(qcCol);
  const summaryCol = document.createElement('div');
  summaryCol.className = 'platform-dropdown-col';
  dropdownsRow.appendChild(summaryCol);
  section.appendChild(dropdownsRow);

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

  qcCol.appendChild(qcToggle);

  // ─── Settings state (initialised from URL param + cookies) ────────────────
  const _cookiePrefix = platformKey ? `ov_${platformKey}` : null;
  const _urlParams = new URLSearchParams(window.location.search);
  const _urlGroup = _urlParams.get('ov_group');
  const _urlMetricsRaw = _urlParams.get('ov_metrics');
  const _urlSince = _urlParams.get('ov_since'); // null=absent, ''=all-time, 'YYYY-MM-DD'=filter
  const _urlSumBy = _urlParams.get('ov_sum_by');
  const _urlSumInstrumentsRaw = _urlParams.get('ov_sum_instruments');
  const _urlSumExperimentersRaw = _urlParams.get('ov_sum_experimenters');
  const _cookieGroup = _cookiePrefix ? _readCookie(`${_cookiePrefix}_group`) : null;
  const _cookieMetricsRaw = _cookiePrefix ? _readCookie(`${_cookiePrefix}_metrics`) : null;
  const _cookieSince = _cookiePrefix ? _readCookie(`${_cookiePrefix}_since`) : null;
  const _cookieSumBy = _cookiePrefix ? _readCookie(`${_cookiePrefix}_sum_by`) : null;
  const _cookieSumInstrumentsRaw = _cookiePrefix ? _readCookie(`${_cookiePrefix}_sum_instruments`) : null;
  const _cookieSumExperimentersRaw = _cookiePrefix ? _readCookie(`${_cookiePrefix}_sum_experimenters`) : null;

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
  let _pendingMetricsRaw = _urlMetricsRaw ?? _cookieMetricsRaw; // comma-separated string or null
  let allMetrics = [];
  let allInstruments = []; // distinct instrument_id values for the platform
  let allExperimenters = []; // distinct experimenter names for the platform
  let rebuildMetricCheckboxes = null; // set while modal is open
  let rebuildInstrumentCheckboxes = null; // set while modal is open
  let rebuildExperimenterCheckboxes = null; // set while modal is open

  /** Persist current settings to cookie and URL. */
  function _persistSettings() {
    if (!_cookiePrefix) return;
    _writeCookie(`${_cookiePrefix}_group`, settings.groupBy);
    const metricsVal = settings.visibleMetrics ? [...settings.visibleMetrics].join(',') : '';
    _writeCookie(`${_cookiePrefix}_metrics`, metricsVal);
    _writeCookie(`${_cookiePrefix}_since`, settings.since ?? '');
    _writeCookie(`${_cookiePrefix}_sum_by`, settings.summaryRowBy);
    // Use '*' as the sentinel for null (= all selected) so it round-trips
    // through cookies without collapsing to '' (= none selected).
    const instrVal = settings.summaryInstruments === null ? '*' : [...settings.summaryInstruments].join(',');
    const expVal = settings.summaryExperimenters === null ? '*' : [...settings.summaryExperimenters].join(',');
    _writeCookie(`${_cookiePrefix}_sum_instruments`, instrVal);
    _writeCookie(`${_cookiePrefix}_sum_experimenters`, expVal);
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
  // ─── QC table widget ──────────────────────────────────────────────────────
  const qcTableApi = createPlatformQcTable(coord, {
    platformKey,
    groupBy: settings.groupBy,
    visibleMetrics: settings.visibleMetrics,
    since: settings.since,
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
  qcCol.appendChild(qcTableApi.el);

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

  // ─── Session summary collapsible section ──────────────────────────────────
  const summaryToggle = document.createElement('button');
  summaryToggle.className = 'platform-qc-toggle';
  summaryToggle.setAttribute('aria-expanded', 'false');

  const summaryArrow = document.createElement('span');
  summaryArrow.className = 'platform-qc-toggle-arrow';
  summaryArrow.textContent = '▶';
  summaryToggle.appendChild(summaryArrow);
  const summaryLabelText = document.createTextNode('');
  summaryToggle.appendChild(summaryLabelText);

  const summaryEl = document.createElement('div');
  summaryEl.className = 'platform-summary-section';
  summaryEl.hidden = true;
  summaryCol.appendChild(summaryToggle);
  summaryCol.appendChild(summaryEl);

  let summaryBuilt = false;
  let refreshSummaryTable = null;

  function updateSummaryLabel() {
    const expanded = summaryToggle.getAttribute('aria-expanded') === 'true';
    summaryArrow.textContent = expanded ? '▼' : '▶';
    const by = settings.summaryRowBy === 'experimenter' ? 'experimenter' : 'project';
    summaryLabelText.textContent = ` Session summary by ${by}`;
  }
  updateSummaryLabel();

  function buildSummarySection() {
    summaryEl.innerHTML = '';

    const summaryHeader = document.createElement('div');
    summaryHeader.className = 'platform-summary-header';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'sessions-export-btn';
    exportBtn.textContent = 'Export CSV';
    summaryHeader.appendChild(exportBtn);
    summaryEl.appendChild(summaryHeader);

    const summaryTable = document.createElement('table');
    summaryTable.className = 'assets-table platform-summary-table';
    const summaryThead = document.createElement('thead');
    const summaryTbody = document.createElement('tbody');
    summaryTable.appendChild(summaryThead);
    summaryTable.appendChild(summaryTbody);
    summaryEl.appendChild(summaryTable);

    const loadingNote = document.createElement('p');
    loadingNote.className = 'settings-loading-note';
    loadingNote.textContent = 'Loading…';
    summaryEl.appendChild(loadingNote);

    let currentRows = [];

    function renderHeader() {
      const groupLabel = settings.summaryRowBy === 'experimenter' ? 'Experimenter' : 'Project';
      summaryThead.innerHTML = `<tr><th>${escHtml(groupLabel)}</th><th>Sessions</th><th>Total time</th></tr>`;
    }

    function formatDuration(seconds) {
      if (!seconds || seconds <= 0) return '—';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    function renderRows(rows) {
      currentRows = rows;
      summaryTbody.innerHTML = rows.map((r) =>
        `<tr><td>${escHtml(String(r.group || '(none)'))}</td><td>${r.sessionCount}</td><td>${escHtml(formatDuration(r.totalSeconds))}</td></tr>`
      ).join('');
    }

    async function loadData() {
      loadingNote.textContent = 'Loading…';
      loadingNote.hidden = false;
      summaryTbody.innerHTML = '';
      renderHeader();
      const filterCond = buildFilterCondition(assetFilter);
      const sinceCond = (settings.since && isValidDate(settings.since))
        ? `AND acquisition_start_time >= '${settings.since}'`
        : '';
      const instrumentCond = (settings.summaryInstruments && settings.summaryInstruments.size > 0)
        ? `AND instrument_id_normalized IN (${[...settings.summaryInstruments].map((v) => `'${v.replace(/'/g, "''")}'`).join(',')})`
        : '';
      const experimenterCond = (settings.summaryExperimenters && settings.summaryExperimenters.size > 0)
        ? `AND (${[...settings.summaryExperimenters].map((v) => `experimenters_normalized LIKE '%${v.replace(/'/g, "''")}%'`).join(' OR ')})`
        : '';
      try {
        let rows;
        if (settings.summaryRowBy === 'project') {
          const result = await coord.query(
            `SELECT
               COALESCE(project_name, '(none)') AS group_key,
               COUNT(*) AS session_count,
               SUM(CASE WHEN acquisition_end_time IS NOT NULL
                   THEN datediff('second', acquisition_start_time, acquisition_end_time)
                   ELSE 0 END) AS total_seconds
             FROM asset_basics
             WHERE ${filterCond}
               AND (data_level IS NULL OR data_level != 'derived')
               ${sinceCond}
               ${instrumentCond}
               ${experimenterCond}
             GROUP BY project_name
             ORDER BY session_count DESC NULLS LAST`,
            { type: 'json' },
          );
          const raw = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Array.from(result ?? []);
          rows = raw.map((r) => ({
            group: r.group_key ?? '(none)',
            sessionCount: Number(r.session_count ?? 0),
            totalSeconds: Number(r.total_seconds ?? 0),
          }));
        } else {
          // Fetch all sessions matching the non-experimenter filters, then
          // aggregate and filter by experimenter in JS.  Using SQL LIKE with
          // normalised names (spaces) against raw column values (dots) is
          // unreliable and causes wrong rows to be excluded.
          const result = await coord.query(
            `SELECT experimenters_normalized AS experimenters,
               CASE WHEN acquisition_end_time IS NOT NULL
                    THEN datediff('second', acquisition_start_time, acquisition_end_time)
                    ELSE 0 END AS session_seconds
             FROM asset_basics
             WHERE ${filterCond}
               AND (data_level IS NULL OR data_level != 'derived')
               ${sinceCond}
               ${instrumentCond}`,
            { type: 'json' },
          );
          const raw = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Array.from(result ?? []);
          rows = aggregateByExperimenter(raw, settings.summaryExperimenters);
        }
        renderRows(rows);
        loadingNote.hidden = true;
      } catch (err) {
        loadingNote.textContent = `Failed to load summary: ${err?.message ?? err}`;
        loadingNote.hidden = false;
        console.error('[PlatformOverview] summary query failed:', err);
      }
    }

    exportBtn.addEventListener('click', () => {
      const groupLabel = settings.summaryRowBy === 'experimenter' ? 'Experimenter' : 'Project';
      downloadCsv(
        `summary_by_${settings.summaryRowBy}.csv`,
        [groupLabel, 'Sessions', 'Total time (s)'],
        currentRows.map((r) => [String(r.group), String(r.sessionCount), String(Math.round(r.totalSeconds))]),
      );
    });

    loadData();
    // Fetch distinct instruments and experimenters for modal checkboxes (if not yet loaded)
    if (!allInstruments.length) {
      const filterCond = buildFilterCondition(assetFilter);
      coord.query(
        `SELECT DISTINCT instrument_id_normalized AS norm_id FROM asset_basics WHERE ${filterCond} AND instrument_id IS NOT NULL`,
        { type: 'json' },
      ).then((result) => {
        const raw = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Array.from(result ?? []);
        const seen = new Set();
        allInstruments = raw
          .map((r) => String(r.norm_id ?? ''))
          .filter((v) => v)
          .filter((v) => { if (seen.has(v)) return false; seen.add(v); return true; })
          .sort();
        if (rebuildInstrumentCheckboxes) rebuildInstrumentCheckboxes();
      }).catch(() => {});
    }
    if (!allExperimenters.length) {
      const filterCond = buildFilterCondition(assetFilter);
      coord.query(
        `SELECT experimenters_normalized AS experimenters FROM asset_basics WHERE ${filterCond} AND (data_level IS NULL OR data_level != 'derived') AND experimenters_normalized IS NOT NULL`,
        { type: 'json' },
      ).then((result) => {
        const raw = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Array.from(result ?? []);
        const seen = new Set();
        for (const r of raw) {
          for (const name of parseExperimenters(r.experimenters)) {
            seen.add(name);
          }
        }
        allExperimenters = [...seen].sort();
        if (rebuildExperimenterCheckboxes) rebuildExperimenterCheckboxes();
      }).catch(() => {});
    }
    return loadData;
  }

  summaryToggle.addEventListener('click', () => {
    const expanded = summaryToggle.getAttribute('aria-expanded') !== 'true';
    summaryToggle.setAttribute('aria-expanded', String(expanded));
    summaryEl.hidden = !expanded;
    if (expanded && !summaryBuilt) {
      summaryBuilt = true;
      refreshSummaryTable = buildSummarySection();
    }
    updateSummaryLabel();
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

    const modalHeader = document.createElement('div');
    modalHeader.className = 'settings-modal-header';
    const title = document.createElement('h3');
    title.textContent = 'Overview Settings';
    modalHeader.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'settings-modal-close-btn';
    closeBtn.setAttribute('aria-label', 'Close settings');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', closeModal);
    modalHeader.appendChild(closeBtn);
    content.appendChild(modalHeader);

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
    // grpSection appended to qcBox below

    // ── Date range ─────────────────────────────────────────────────────────────────────
    const sinceSection = document.createElement('div');
    sinceSection.className = 'settings-section';

    const sinceLabel = document.createElement('div');
    sinceLabel.className = 'settings-section-label';
    sinceLabel.textContent = 'Show assets since';
    sinceSection.appendChild(sinceLabel);

    const PRESETS = [
      { label: '\u2014 Quick select \u2014', months: null },
      { label: 'Last month',       months: 1 },
      { label: 'Last 3 months',    months: 3 },
      { label: 'Last 6 months',    months: 6 },
      { label: 'Last year',        months: 12 },
      { label: 'All time',         months: 0 },
    ];
    function computePresetDate(months) {
      if (!months) return '';
      const d = new Date();
      d.setMonth(d.getMonth() - months);
      return d.toISOString().slice(0, 10);
    }

    const presetSelect = document.createElement('select');
    presetSelect.className = 'settings-since-select';
    for (const p of PRESETS) {
      const opt = document.createElement('option');
      opt.value = p.months === null ? '__placeholder__' : (p.months === 0 ? '' : String(p.months));
      opt.textContent = p.label;
      if (p.months === null) { opt.disabled = true; opt.hidden = true; }
      presetSelect.appendChild(opt);
    }
    presetSelect.value = '__placeholder__';

    const sinceRow = document.createElement('div');
    sinceRow.className = 'settings-since-row';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'settings-since-date';
    dateInput.value = settings.since ?? '';

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'settings-metric-btn';
    clearBtn.textContent = 'All time';

    sinceRow.appendChild(dateInput);
    sinceRow.appendChild(clearBtn);

    presetSelect.addEventListener('change', () => {
      const val = presetSelect.value;
      if (val === '__placeholder__') return;
      const months = val === '' ? 0 : Number(val);
      dateInput.value = computePresetDate(months);
      settings.since = dateInput.value || null;
      presetSelect.value = '__placeholder__';
      _persistSettings();
      qcTableApi.setSince(settings.since);
      if (refreshSummaryTable) refreshSummaryTable();
    });

    dateInput.addEventListener('change', () => {
      settings.since = dateInput.value || null;
      _persistSettings();
      qcTableApi.setSince(settings.since);
      if (refreshSummaryTable) refreshSummaryTable();
    });

    clearBtn.addEventListener('click', () => {
      dateInput.value = '';
      settings.since = null;
      _persistSettings();
      qcTableApi.setSince(null);
      if (refreshSummaryTable) refreshSummaryTable();
    });

    sinceSection.appendChild(presetSelect);
    sinceSection.appendChild(sinceRow);
    content.appendChild(sinceSection);

    // ── Tag filter ───────────────────────────────────────────────────────────────────
    // ── Tag column filter (previously 'Metric filter') ──────────────────────
    const statusSection = document.createElement('div');
    statusSection.className = 'settings-section';

    const statusLabel = document.createElement('div');
    statusLabel.className = 'settings-section-label';
    statusLabel.textContent = 'Show tag columns';
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
    // statusSection appended to qcBox below

    // ── Layout: three columns — time settings | QC settings | session summary ───────
    const modalBody = document.createElement('div');
    modalBody.className = 'settings-modal-body';

    const timeCol = document.createElement('div');
    timeCol.className = 'settings-modal-col';
    timeCol.appendChild(sinceSection);
    modalBody.appendChild(timeCol);

    const qcCol2 = document.createElement('div');
    qcCol2.className = 'settings-modal-col';
    modalBody.appendChild(qcCol2);

    const qcBox = document.createElement('div');
    qcBox.className = 'settings-section-box';
    const qcBoxLabel = document.createElement('div');
    qcBoxLabel.className = 'settings-section-box-label';
    qcBoxLabel.textContent = 'QC settings';
    qcBox.appendChild(qcBoxLabel);
    qcBox.appendChild(grpSection);
    qcBox.appendChild(statusSection);
    qcCol2.appendChild(qcBox);

    // ── Summary row-by ────────────────────────────────────────────────────
    const sumCol = document.createElement('div');
    sumCol.className = 'settings-modal-col';
    modalBody.appendChild(sumCol);

    const sumBox = document.createElement('div');
    sumBox.className = 'settings-section-box';
    const sumBoxLabel = document.createElement('div');
    sumBoxLabel.className = 'settings-section-box-label';
    sumBoxLabel.textContent = 'Session summary settings';
    sumBox.appendChild(sumBoxLabel);
    const sumSection = document.createElement('div');
    sumSection.className = 'settings-section';
    const sumLabel = document.createElement('div');
    sumLabel.className = 'settings-section-label';
    sumLabel.textContent = 'Rows grouped by';
    sumSection.appendChild(sumLabel);
    for (const [val, text] of [['project', 'Project'], ['experimenter', 'Experimenter']]) {
      const lbl = document.createElement('label');
      lbl.className = 'settings-checkbox-label';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'platform-ov-sumby';
      radio.value = val;
      radio.checked = settings.summaryRowBy === val;
      radio.addEventListener('change', () => {
        if (radio.checked && val !== settings.summaryRowBy) {
          settings.summaryRowBy = val;
          _persistSettings();
          updateSummaryLabel();
          if (refreshSummaryTable) refreshSummaryTable();
        }
      });
      const span = document.createElement('span');
      span.textContent = text;
      lbl.appendChild(radio);
      lbl.appendChild(span);
      sumSection.appendChild(lbl);
    }
    sumBox.appendChild(sumSection);

    // ── Summary checkbox filters (instrument + experimenter) ───────────────
    function buildSumCheckboxSection(labelText, allValues, settingKey, rebuildRef) {
      const section = document.createElement('div');
      section.className = 'settings-section';
      const sectionLabel = document.createElement('div');
      sectionLabel.className = 'settings-section-label';
      sectionLabel.textContent = labelText;
      section.appendChild(sectionLabel);

      function build() {
        while (section.children.length > 1) section.removeChild(section.lastChild);

        if (!allValues.length) {
          const note = document.createElement('p');
          note.className = 'settings-loading-note';
          note.textContent = 'Loading…';
          section.appendChild(note);
          return;
        }

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = `Search…`;
        searchInput.className = 'settings-metric-search';
        section.appendChild(searchInput);

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
        section.appendChild(btnRow);

        const listWrap = document.createElement('div');
        listWrap.className = 'settings-metric-list';
        section.appendChild(listWrap);

        function renderList(filter) {
          listWrap.innerHTML = '';
          const low = (filter ?? '').toLowerCase();
          const shown = low ? allValues.filter((v) => v.toLowerCase().includes(low)) : allValues;
          for (const v of shown) {
            const isChecked = settings[settingKey] === null || settings[settingKey].has(v);
            const lbl = document.createElement('label');
            lbl.className = 'settings-checkbox-label';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = isChecked;
            cb.addEventListener('change', () => {
              if (settings[settingKey] === null) {
                settings[settingKey] = new Set(allValues);
              }
              if (cb.checked) {
                settings[settingKey].add(v);
              } else {
                settings[settingKey].delete(v);
              }
              _persistSettings();
              if (refreshSummaryTable) refreshSummaryTable();
            });
            const span = document.createElement('span');
            span.textContent = v;
            lbl.appendChild(cb);
            lbl.appendChild(span);
            listWrap.appendChild(lbl);
          }
        }

        searchInput.addEventListener('input', () => renderList(searchInput.value));
        selAllBtn.addEventListener('click', () => {
          settings[settingKey] = null;
          _persistSettings();
          if (refreshSummaryTable) refreshSummaryTable();
          renderList(searchInput.value);
        });
        clrAllBtn.addEventListener('click', () => {
          settings[settingKey] = new Set();
          _persistSettings();
          if (refreshSummaryTable) refreshSummaryTable();
          renderList(searchInput.value);
        });

        renderList();
      }

      // Store rebuild reference so data-load can trigger it
      rebuildRef(build);
      build();
      return section;
    }

    rebuildInstrumentCheckboxes = null;
    rebuildExperimenterCheckboxes = null;
    sumBox.appendChild(buildSumCheckboxSection('Filter by instrument', allInstruments, 'summaryInstruments', (fn) => { rebuildInstrumentCheckboxes = fn; }));
    sumBox.appendChild(buildSumCheckboxSection('Filter by experimenter', allExperimenters, 'summaryExperimenters', (fn) => { rebuildExperimenterCheckboxes = fn; }));

    sumCol.appendChild(sumBox);
    content.appendChild(modalBody);


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
    rebuildInstrumentCheckboxes = null;
    rebuildExperimenterCheckboxes = null;
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

/**
 * lib/platform-overview/session-summary.js — "Session summary by
 * project/experimenter" collapsible dropdown for the platform overview.
 *
 * @module
 */

import { escHtml, parseExperimenters, downloadCsv, aggregateByExperimenter, aggregateByProject } from '../utils.js';
import { buildFilterCondition, isValidDate } from './helpers.js';

/**
 * @param {object} ctx  Shared overview context ({ coord, assetFilter, settings }).
 */
export function createSessionSummaryDropdown(ctx) {
  const { coord, assetFilter, settings } = ctx;

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

  const summaryEl = document.createElement('div');
  summaryEl.className = 'platform-summary-section';
  summaryEl.hidden = true;
  col.appendChild(toggle);
  col.appendChild(summaryEl);

  let summaryBuilt = false;
  let refreshSummaryTable = null;
  let allInstruments = []; // distinct instrument_id values for the platform
  let allExperimenters = []; // distinct experimenter names for the platform
  let rebuildInstrumentCheckboxes = null; // set while modal is open
  let rebuildExperimenterCheckboxes = null; // set while modal is open

  function updateLabel() {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    arrow.textContent = expanded ? '▼' : '▶';
    const by = settings.summaryRowBy === 'experimenter' ? 'experimenter' : 'project';
    labelText.textContent = ` Session summary by ${by}`;
  }
  updateLabel();

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
      try {
        let rows;
        if (settings.summaryRowBy === 'project') {
          // Fetch raw rows — experimenter filtering must happen in JS because
          // experimenters_normalized is VARCHAR[] and LIKE on arrays throws in DuckDB.
          const result = await coord.query(
            `SELECT
               COALESCE(project_name, '(none)') AS group_key,
               experimenters_normalized AS experimenters,
               CASE WHEN acquisition_end_time IS NOT NULL
                    THEN datediff('second', acquisition_start_time, acquisition_end_time)
                    ELSE 0 END AS session_seconds
             FROM asset_basics
             WHERE ${filterCond}
               AND (data_level IS NULL OR data_level != 'derived')
               ${sinceCond}
               ${instrumentCond}`,
          );
          const raw = Array.isArray(result) ? result : Array.isArray(result?.data) ? result.data : Array.from(result ?? []);
          rows = aggregateByProject(raw, settings.summaryExperimenters);
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

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(expanded));
    summaryEl.hidden = !expanded;
    if (expanded && !summaryBuilt) {
      summaryBuilt = true;
      refreshSummaryTable = buildSummarySection();
    }
    updateLabel();
  });

  return {
    col,
    refresh: () => { if (refreshSummaryTable) refreshSummaryTable(); },
    updateLabel,
    getInstruments: () => allInstruments,
    getExperimenters: () => allExperimenters,
    setRebuildInstruments: (fn) => { rebuildInstrumentCheckboxes = fn; },
    setRebuildExperimenters: (fn) => { rebuildExperimenterCheckboxes = fn; },
  };
}

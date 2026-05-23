/**
 * fiber_photometry/view.js — Fiber Photometry Platform dashboard.
 *
 * Loads `zs_platform_fib.pqt` (long-form: one row per asset+channel) from S3,
 * joins with `asset_basics`, then pivots to one row per asset.
 * Channel columns are named Fiber_N/Color (e.g. Fiber_0/Green).
 * Only channels with at least one non-"missing" intended_measurement are shown.
 */

import { buildS3ConsoleUrl, buildQcLink, buildMetadataLink, buildCoLink } from '../assets/view.js';
import { escHtml, formatDatetime, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD } from '../lib/utils.js';

const FIB_S3_PATH = `https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/zs_platform_fib.pqt`;

const ALWAYS_SHOWN_BASICS = ['subject_id', 'project_name'];
const OPTIONAL_BASICS = ['acquisition_start_time', 'data_level', 'modalities', 'genotype'];

const BASICS_LABELS = {
  subject_id: 'Subject',
  project_name: 'Project',
  acquisition_start_time: 'Acquired (UTC)',
  data_level: 'Level',
  modalities: 'Modalities',
  genotype: 'Genotype',
};

const BASICS_KEYS_FROM_JOIN = [
  'subject_id', 'project_name', 'acquisition_start_time',
  'data_level', 'modalities', 'genotype', 'location',
  'code_ocean', 'experimenters',
];

// ---------------------------------------------------------------------------
// Long-form → wide-form pivot
// ---------------------------------------------------------------------------

/**
 * Normalize a raw channel string to "Fiber_N/Color" format.
 * Returns null for unrecognised formats (e.g. "Fiber channel").
 */
function normChannel(ch) {
  const m = String(ch).match(/^Fiber[ _](\d+)[ _](\w+)$/i);
  if (!m) return null;
  const color = m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase();
  return `Fiber_${m[1]}/${color}`;
}

/** Extract fiber index from a fiber field like "Fiber_0", "Fiber 0", "Fiber_1". */
function normFiberIndex(fiberField) {
  const m = String(fiberField).match(/^Fiber[ _](\d+)$/i);
  return m ? m[1] : null;
}

/**
 * Pivot long-form rows (one per asset+channel) to wide-form (one per asset).
 * Each fiber gets:
 *   - Fiber_N/Target  — targeted_structure
 *   - Fiber_N/Channels — summary string "Green: calcium\nRed: dopamine" for display
 *   - Fiber_N/<Color>  — individual channel values (kept for filtering/alerts)
 * Asset-basics fields are copied from the first long-form row for each asset.
 */
export function pivotLongFormRows(longRows) {
  const assetMap = new Map();
  for (const row of longRows) {
    const assetName = row.asset_name;
    if (!assetMap.has(assetName)) {
      const wideRow = { asset_name: assetName };
      for (const k of BASICS_KEYS_FROM_JOIN) {
        wideRow[k] = row[k];
      }
      assetMap.set(assetName, wideRow);
    }
    const wideRow = assetMap.get(assetName);

    // targeted_structure: one value per fiber
    const fiberIdx = normFiberIndex(row.fiber);
    if (fiberIdx !== null) {
      const targetCol = `Fiber_${fiberIdx}/Target`;
      const ts = row.targeted_structure;
      if (wideRow[targetCol] === undefined || wideRow[targetCol] === '') {
        wideRow[targetCol] = (ts === 'missing' || ts == null) ? '' : ts;
      }
    }

    // intended_measurement: one value per channel
    const col = normChannel(row.channel);
    if (!col) continue;
    const val = row.intended_measurement;
    if (wideRow[col] === undefined || wideRow[col] === '') {
      wideRow[col] = (val === 'missing' || val == null) ? '' : val;
    }
  }

  // Build Fiber_N/Channels summary strings after all channels are collected
  for (const wideRow of assetMap.values()) {
    const fiberChannels = new Map(); // fiberIdx → [[color, measurement], ...]
    for (const [k, v] of Object.entries(wideRow)) {
      const m = k.match(/^Fiber_(\d+)\/([^T]\w*)$/); // color cols (not Target)
      if (!m || !v) continue;
      if (!fiberChannels.has(m[1])) fiberChannels.set(m[1], []);
      fiberChannels.get(m[1]).push([m[2], v]);
    }
    for (const [idx, pairs] of fiberChannels) {
      pairs.sort((a, b) => a[0].localeCompare(b[0]));
      wideRow[`Fiber_${idx}/Channels`] = pairs.map(([color, meas]) => `${color}: ${meas}`).join('\n');
    }
  }

  return Array.from(assetMap.values());
}

/**
 * Return display column names: Fiber_N/Target and Fiber_N/Channels only,
 * sorted by fiber index. Individual color columns are kept in the row data
 * for filtering and alerts but not returned here.
 */
export function detectChannelColumns(wideRows) {
  const fiberIndices = new Set();
  for (const row of wideRows) {
    for (const k of Object.keys(row)) {
      const m = k.match(/^Fiber_(\d+)\//);
      if (m) fiberIndices.add(parseInt(m[1], 10));
    }
  }
  // Only include fibers that have any real data
  const cols = [];
  for (const idx of [...fiberIndices].sort((a, b) => a - b)) {
    const hasData = wideRows.some((row) => {
      for (const [k, v] of Object.entries(row)) {
        if (k.startsWith(`Fiber_${idx}/`) && v != null && v !== '') return true;
      }
      return false;
    });
    if (!hasData) continue;
    cols.push(`Fiber_${idx}/Target`, `Fiber_${idx}/Channels`);
  }
  return cols;
}

// ---------------------------------------------------------------------------
// Sidebar filter helpers
// ---------------------------------------------------------------------------

/** Return {targetCols, measCols} — the Fiber_N/Target and Fiber_N/Color key names. */
function detectFiberCols(wideRows) {
  const targetColSet = new Set();
  const measColSet = new Set();
  for (const row of wideRows) {
    for (const k of Object.keys(row)) {
      if (k.match(/^Fiber_\d+\/Target$/)) targetColSet.add(k);
      else if (k.match(/^Fiber_\d+\//) && !k.endsWith('/Channels') && !k.endsWith('/Target')) measColSet.add(k);
    }
  }
  return { targetCols: [...targetColSet].sort(), measCols: [...measColSet].sort() };
}

/** Collect unique non-empty values across multiple columns. */
function uniqueFiberValues(wideRows, cols) {
  const seen = new Set();
  for (const row of wideRows) {
    for (const col of cols) {
      const v = row[col];
      if (v != null && v !== '') seen.add(String(v));
    }
  }
  return [...seen].sort();
}

/** Filter rows to those matching the sidebar selections (target AND measurement). */
function applyFiberSidebarFilters(rows, selectedTargets, selectedMeasurements, targetCols, measCols) {
  if (selectedTargets.size === 0 && selectedMeasurements.size === 0) return rows;
  return rows.filter((row) => {
    if (selectedTargets.size > 0) {
      if (!targetCols.some((col) => selectedTargets.has(String(row[col] ?? '')))) return false;
    }
    if (selectedMeasurements.size > 0) {
      if (!measCols.some((col) => selectedMeasurements.has(String(row[col] ?? '')))) return false;
    }
    return true;
  });
}

/** Build a checkbox filter group in the sidebar. */
function buildCheckboxGroup(filterPanel, label, allValues, selectedSet, onChange) {
  const group = document.createElement('div');
  group.className = 'sessions-filter-group';

  const labelEl = document.createElement('div');
  labelEl.className = 'sessions-filter-label';
  labelEl.textContent = label;
  group.appendChild(labelEl);

  const checkboxList = document.createElement('div');
  checkboxList.className = 'sessions-checkbox-list';
  group.appendChild(checkboxList);

  const clearBtn = document.createElement('button');
  clearBtn.className = 'sessions-filter-clear';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', () => {
    selectedSet.clear();
    checkboxList.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; });
    onChange();
  });
  group.appendChild(clearBtn);

  for (const val of allValues) {
    const item = document.createElement('label');
    item.className = 'sessions-checkbox-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = val;
    cb.checked = selectedSet.has(val);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedSet.add(val);
      else selectedSet.delete(val);
      onChange();
    });
    item.appendChild(cb);
    item.appendChild(document.createTextNode(' ' + val));
    checkboxList.appendChild(item);
  }

  filterPanel.appendChild(group);
}

// ---------------------------------------------------------------------------
// Link helper
// ---------------------------------------------------------------------------

function linkHtml(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

// ---------------------------------------------------------------------------
// Row renderer
// ---------------------------------------------------------------------------

export function renderFibRow(row, visibleColumns, channelCols, columnLabels) {
  const s3Href = buildS3ConsoleUrl(row.location ?? null);
  const qcHref = buildQcLink(row.asset_name ?? null);
  const metaHref = buildMetadataLink(row.asset_name ?? null);
  const coHref = buildCoLink(row.code_ocean ?? null);

  const cellValues = {
    subject_id: row.subject_id
      ? `<a href="/subject?subject_id=${encodeURIComponent(row.subject_id)}">${escHtml(String(row.subject_id))}</a>`
      : '',
    project_name: row.project_name
      ? `<a href="/project?project=${encodeURIComponent(row.project_name)}">${escHtml(String(row.project_name))}</a>`
      : '',
    acquisition_start_time: escHtml(formatDatetime(row.acquisition_start_time ?? null)),
    data_level: escHtml(String(row.data_level ?? '')),
    modalities: escHtml(String(row.modalities ?? '')),
    genotype: escHtml(String(row.genotype ?? '')),
  };

  for (const col of channelCols) {
    if (col.endsWith('/Channels')) {
      // Render newline-separated lines as stacked rows
      const lines = String(row[col] ?? '').split('\n').filter(Boolean);
      cellValues[col] = lines.map((l) => escHtml(l)).join('<br>');
    } else {
      cellValues[col] = escHtml(String(row[col] ?? ''));
    }
  }

  const cells = visibleColumns.map((col) => {
    if (col === 'links') {
      return `<td class="link-cell">` +
        `${linkHtml(s3Href, 'S3')} ` +
        `${linkHtml(coHref, 'CO')} ` +
        `${linkHtml(metaHref, 'Meta')} ` +
        `${linkHtml(qcHref, 'QC')}` +
        `</td>`;
    }
    return `<td>${cellValues[col] ?? ''}</td>`;
  });

  return `<tr>${cells.join('')}</tr>`;
}

// ---------------------------------------------------------------------------
// Missing-info alert table
// ---------------------------------------------------------------------------

/**
 * For each subject, collect unique "channel: no intended measurement" problems
 * across all their assets. Returns [{subject_id, investigators, assetCount, incompleteInfo}].
 */
export function buildMissingTable(wideRows) {
  const subjectMap = new Map();

  for (const row of wideRows) {
    const sid = row.subject_id ?? '';
    const problems = [];

    // Group Fiber_N/* keys by fiber index
    const fiberKeys = new Map();
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('Fiber_')) continue;
      if (k.endsWith('/Channels')) continue; // synthetic summary, skip
      const m = k.match(/^Fiber_(\d+)\//);
      if (!m) continue;
      if (!fiberKeys.has(m[1])) fiberKeys.set(m[1], []);
      fiberKeys.get(m[1]).push([k, v]);
    }

    for (const pairs of fiberKeys.values()) {
      // Skip fibers with no data at all — they don't exist for this asset
      if (!pairs.some(([, v]) => v != null && v !== '')) continue;
      for (const [k, v] of pairs) {
        if (v == null || v === '') {
          const suffix = k.endsWith('/Target') ? 'no targeted structure' : 'no intended measurement';
          problems.push(`${k}: ${suffix}`);
        }
      }
    }

    if (problems.length === 0) continue;

    if (!subjectMap.has(sid)) {
      subjectMap.set(sid, { subject_id: sid, investigators: new Set(), assetCount: 0, problems: new Set() });
    }
    const entry = subjectMap.get(sid);
    entry.assetCount++;
    problems.forEach((p) => entry.problems.add(p));

    const exps = row.experimenters ?? '';
    String(exps).split(',').map((e) => e.trim()).filter(Boolean).forEach((e) => entry.investigators.add(e));
  }

  return Array.from(subjectMap.values())
    .sort((a, b) => String(a.subject_id).localeCompare(String(b.subject_id)))
    .map((e) => ({
      subject_id: e.subject_id,
      investigators: Array.from(e.investigators).join(', '),
      assetCount: e.assetCount,
      incompleteInfo: Array.from(e.problems).sort().join('; '),
    }));
}

// ---------------------------------------------------------------------------
// View factory
// ---------------------------------------------------------------------------

export function createFiberPhotometryView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view fib-view';

  // Progress bar UI
  const loadingEl = document.createElement('div');
  loadingEl.className = 'fib-loading';
  const progressTrack = document.createElement('div');
  progressTrack.className = 'fib-progress-track';
  const progressFill = document.createElement('div');
  progressFill.className = 'fib-progress-fill';
  progressTrack.appendChild(progressFill);
  const progressLabel = document.createElement('div');
  progressLabel.className = 'fib-progress-label';
  progressLabel.textContent = 'Connecting…';
  loadingEl.appendChild(progressTrack);
  loadingEl.appendChild(progressLabel);
  container.appendChild(loadingEl);

  function setProgress(pct, label) {
    progressFill.style.width = `${pct}%`;
    progressLabel.textContent = label;
  }

  const t0 = performance.now();
  console.log('[FibPhot] start');

  setProgress(10, 'Downloading fiber photometry data…');
  coord.exec(`CREATE OR REPLACE TABLE platform_fib AS SELECT * FROM read_parquet('${FIB_S3_PATH}')`)
    .then(() => {
      console.log(`[FibPhot] parquet loaded & registered  +${(performance.now()-t0).toFixed(0)}ms`);
      setProgress(40, 'Running join query…');
      return coord.query(
        `SELECT f.asset_name, f.fiber, f.channel, f.targeted_structure, f.intended_measurement,
                b.subject_id, b.project_name, b.acquisition_start_time,
                b.data_level, b.modalities, b.genotype, b.location,
                b.code_ocean, b.experimenters
         FROM platform_fib f
         LEFT JOIN asset_basics b ON b.name = f.asset_name
         ORDER BY b.acquisition_start_time DESC NULLS LAST, f.asset_name`,
        { type: 'json' },
      );
    })
    .then((result) => {
      console.log(`[FibPhot] JOIN query returned           +${(performance.now()-t0).toFixed(0)}ms`);
      setProgress(70, 'Reshaping data…');
      const longRows = Array.isArray(result) ? result
        : Array.isArray(result?.data) ? result.data
        : Array.from(result ?? []);
      console.log(`[FibPhot] result → array (${longRows.length} long rows)  +${(performance.now()-t0).toFixed(0)}ms`);
      const wideRows = pivotLongFormRows(longRows);
      console.log(`[FibPhot] pivot → wide (${wideRows.length} assets)       +${(performance.now()-t0).toFixed(0)}ms`);
      setProgress(90, 'Building page…');
      loadingEl.remove();
      buildPage(wideRows);
      console.log(`[FibPhot] page built                   +${(performance.now()-t0).toFixed(0)}ms`);
    })
    .catch((err) => {
      loadingEl.className = 'loading-message error';
      progressLabel.textContent = `Failed to load Fiber Photometry data: ${err?.message ?? err}`;
    });

  function buildPage(allRows) {
    const channelCols = detectChannelColumns(allRows);
    const columnLabels = { ...BASICS_LABELS };
    const allAvailableCols = [...ALWAYS_SHOWN_BASICS, ...channelCols, ...OPTIONAL_BASICS];
    const defaultDisplayCols = [...ALWAYS_SHOWN_BASICS, ...channelCols];

    // Sidebar filter state
    const { targetCols, measCols } = detectFiberCols(allRows);
    const allTargets = uniqueFiberValues(allRows, targetCols);
    const allMeasurements = uniqueFiberValues(allRows, measCols);
    const selectedTargets = new Set();
    const selectedMeasurements = new Set();

    function getBaseRows() {
      return applyFiberSidebarFilters(allRows, selectedTargets, selectedMeasurements, targetCols, measCols);
    }

    // Layout: sidebar + main
    const layout = document.createElement('div');
    layout.className = 'sessions-layout fib-layout';

    const filterPanel = document.createElement('div');
    filterPanel.className = 'sessions-filter-panel';
    filterPanel.innerHTML = '<h3 class="sessions-panel-title">Filter</h3>';

    const mainContent = document.createElement('div');
    mainContent.className = 'fib-main';

    layout.appendChild(filterPanel);
    layout.appendChild(mainContent);
    container.appendChild(layout);

    // Top card (header + alert + table)
    const topCard = document.createElement('div');
    topCard.className = 'fib-top-card';

    const header = document.createElement('div');
    header.className = 'assets-header';
    header.innerHTML = '<h2>Fiber Photometry Platform</h2>';

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'assets-settings-btn icon-btn';
    settingsBtn.setAttribute('aria-label', 'Column settings');
    settingsBtn.innerHTML = '<img src="/icons/gear.svg" alt="Settings" />';
    header.appendChild(settingsBtn);
    topCard.appendChild(header);

    // Alert section (always from allRows — global data quality view)
    const missing = buildMissingTable(allRows);
    if (missing.length > 0) {
      const alertSection = document.createElement('div');
      alertSection.className = 'fib-alert-section';

      const alertHeader = document.createElement('h3');
      alertHeader.className = 'fib-alert-title';
      alertHeader.textContent = `Subjects with incomplete fiber info (${missing.length})`;
      alertSection.appendChild(alertHeader);

      const alertDesc = document.createElement('p');
      alertDesc.className = 'fib-alert-desc';
      alertDesc.textContent = 'These subjects have assets where at least one fiber channel is missing an intended measurement.';
      alertSection.appendChild(alertDesc);

      const alertTable = document.createElement('table');
      alertTable.className = 'assets-table fib-alert-table';
      alertTable.innerHTML = `
        <thead><tr>
          <th>Subject</th>
          <th>Investigators</th>
          <th>Affected assets</th>
          <th>Incomplete info</th>
        </tr></thead>
        <tbody></tbody>
      `;
      const alertTbody = alertTable.querySelector('tbody');

      const ALERT_PAGE_SIZE = 10;
      let alertPage = 0;

      const alertPaging = document.createElement('div');
      alertPaging.className = 'assets-paging';

      function renderAlertPage() {
        const start = alertPage * ALERT_PAGE_SIZE;
        const pageRows = missing.slice(start, start + ALERT_PAGE_SIZE);
        alertTbody.innerHTML = pageRows.map((m) => {
          const subjectLink = m.subject_id
            ? `<a href="/subject?subject_id=${encodeURIComponent(m.subject_id)}">${escHtml(String(m.subject_id))}</a>`
            : '—';
          return `<tr>
            <td>${subjectLink}</td>
            <td>${escHtml(m.investigators || '—')}</td>
            <td>${m.assetCount}</td>
            <td>${escHtml(m.incompleteInfo)}</td>
          </tr>`;
        }).join('');

        const totalPages = Math.max(1, Math.ceil(missing.length / ALERT_PAGE_SIZE));
        const displayStart = missing.length === 0 ? 0 : start + 1;
        const displayEnd = Math.min(start + ALERT_PAGE_SIZE, missing.length);
        alertPaging.innerHTML = `
          <button class="page-btn" id="alert-prev-page" ${alertPage === 0 ? 'disabled' : ''}>‹ Prev</button>
          <span class="page-info">${displayStart}–${displayEnd} of ${missing.length}</span>
          <button class="page-btn" id="alert-next-page" ${alertPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
        `;
        alertPaging.querySelector('#alert-prev-page').addEventListener('click', () => { alertPage--; renderAlertPage(); });
        alertPaging.querySelector('#alert-next-page').addEventListener('click', () => { alertPage++; renderAlertPage(); });
      }

      renderAlertPage();
      alertSection.appendChild(alertTable);
      alertSection.appendChild(alertPaging);
      topCard.appendChild(alertSection);
    }

    const { refresh: tableRefresh, invalidateSort } = buildTable(
      allRows, getBaseRows, topCard, settingsBtn,
      allAvailableCols, defaultDisplayCols, columnLabels, channelCols,
    );

    mainContent.appendChild(topCard);

    // Sidebar filter groups — rebuild sorted cache and refresh table on change
    function onSidebarChange() {
      invalidateSort();
      tableRefresh();
    }

    if (allTargets.length > 0) {
      buildCheckboxGroup(filterPanel, 'Target', allTargets, selectedTargets, onSidebarChange);
    }
    if (allMeasurements.length > 0) {
      buildCheckboxGroup(filterPanel, 'Intended Measurement', allMeasurements, selectedMeasurements, onSidebarChange);
    }
  }

  function buildTable(allRows, getBaseRows, target, settingsBtn, allAvailableCols, defaultDisplayCols, columnLabels, channelCols) {
    let sortCol = 'acquisition_start_time';
    let sortDir = 'desc';
    let visibleColumns = [...defaultDisplayCols, 'links'];
    let filters = Object.fromEntries(allAvailableCols.map((c) => [c, '']));
    let page = 0;
    let settingsModalOpen = false;

    // Sorted-base cache: avoids O(n log n) re-sort on every filter keypress.
    // Invalidated when sort params change or sidebar filters change.
    let sortedBase = null;

    function invalidateSort() {
      sortedBase = null;
    }

    function rebuildSortedBase() {
      sortedBase = sortRows([...getBaseRows()], sortCol, sortDir);
    }

    const uniques = {};
    for (const col of allAvailableCols) {
      uniques[col] = uniqueValues(allRows, col);
    }

    const useSelect = {};
    for (const col of allAvailableCols) {
      useSelect[col] = uniques[col].length > 0 && uniques[col].length <= SELECT_THRESHOLD;
    }

    const table = document.createElement('table');
    table.className = 'assets-table';
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.appendChild(thead);
    table.appendChild(tbody);

    const pagingBar = document.createElement('div');
    pagingBar.className = 'assets-paging';

    target.appendChild(table);
    target.appendChild(pagingBar);

    function renderHeader() {
      const headerRowHtml = visibleColumns.map((col) => {
        const label = columnLabels[col] ?? col;
        if (col === 'links') {
          return `<th class="col-links"><span class="col-label">Links</span></th>`;
        }
        let filterEl;
        if (useSelect[col]) {
          const options = uniques[col]
            .map((v) => `<option value="${escHtml(v)}">${escHtml(v)}</option>`)
            .join('');
          filterEl = `<select class="col-filter" data-col="${col}"><option value="">— all —</option>${options}</select>`;
        } else {
          filterEl = `<input class="col-filter" type="text" data-col="${col}" placeholder="filter…" />`;
        }
        return `<th class="sortable" data-col="${col}"><span class="col-label">${label}</span>${filterEl}</th>`;
      }).join('');

      thead.innerHTML = `<tr>${headerRowHtml}</tr>`;

      thead.addEventListener('click', (e) => {
        if (!e.target.closest('.col-label')) return;
        const th = e.target.closest('th.sortable');
        if (!th) return;
        const col = th.dataset.col;
        if (sortCol === col) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortCol = col;
          sortDir = 'asc';
        }
        page = 0;
        invalidateSort();
        refresh();
      });

      thead.addEventListener('input', (e) => {
        const el = e.target.closest('.col-filter');
        if (!el) return;
        filters[el.dataset.col] = el.value;
        page = 0;
        refresh();
      });

      thead.addEventListener('change', (e) => {
        const el = e.target.closest('.col-filter');
        if (!el) return;
        filters[el.dataset.col] = el.value;
        page = 0;
        refresh();
      });

      restoreFilterInputs();
      updateSortIndicators();
    }

    function restoreFilterInputs() {
      thead.querySelectorAll('.col-filter').forEach((el) => {
        const col = el.dataset.col;
        if (filters[col]) el.value = filters[col];
      });
    }

    function updateSortIndicators() {
      thead.querySelectorAll('th.sortable').forEach((th) => {
        const col = th.dataset.col;
        th.dataset.sortDir = col === sortCol ? sortDir : '';
        const label = columnLabels[col] ?? col;
        const arrow = col === sortCol ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        th.querySelector('.col-label').textContent = label + arrow;
      });
    }

    function visibleRows() {
      if (!sortedBase) rebuildSortedBase();
      return filterRows(sortedBase, filters);
    }

    function refresh() {
      const rows = visibleRows();
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (page >= totalPages) page = totalPages - 1;

      const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      tbody.innerHTML = pageRows.map((row) => renderFibRow(row, visibleColumns, channelCols, columnLabels)).join('');

      const start = rows.length === 0 ? 0 : page * PAGE_SIZE + 1;
      const end = Math.min((page + 1) * PAGE_SIZE, rows.length);
      pagingBar.innerHTML = `
        <button class="page-btn" id="fib-prev-page" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="page-info">${start}–${end} of ${rows.length.toLocaleString()}</span>
        <button class="page-btn" id="fib-next-page" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
      `;
      pagingBar.querySelector('#fib-prev-page').addEventListener('click', () => { page--; refresh(); });
      pagingBar.querySelector('#fib-next-page').addEventListener('click', () => { page++; refresh(); });

      updateSortIndicators();
    }

    function openSettingsModal() {
      if (settingsModalOpen) {
        const existing = document.querySelector('.assets-settings-modal');
        if (existing) existing.remove();
        settingsModalOpen = false;
        return;
      }

      const settingsModal = document.createElement('div');
      settingsModal.className = 'assets-settings-modal';

      const listHtml = allAvailableCols.map((col) => {
        const isChecked = visibleColumns.includes(col);
        const isRequired = ALWAYS_SHOWN_BASICS.includes(col);
        return `
          <label class="settings-checkbox-label">
            <input type="checkbox" class="settings-col-checkbox" data-col="${col}"
              ${isChecked ? 'checked' : ''} ${isRequired ? 'disabled' : ''} />
            <span>${columnLabels[col] ?? col}${isRequired ? ' <em>(always shown)</em>' : ''}</span>
          </label>
        `;
      }).join('');

      settingsModal.innerHTML = `
        <div class="settings-modal-content">
          <h3>Visible Columns</h3>
          <div class="settings-checkbox-list">${listHtml}</div>
          <div class="settings-modal-actions">
            <button class="settings-reset-btn">Reset to Defaults</button>
            <button class="settings-close-btn">Close</button>
          </div>
        </div>
      `;

      document.body.appendChild(settingsModal);
      settingsModalOpen = true;

      settingsModal.querySelectorAll('.settings-col-checkbox').forEach((checkbox) => {
        checkbox.addEventListener('change', () => {
          const col = checkbox.dataset.col;
          if (checkbox.checked) {
            if (!visibleColumns.includes(col) && col !== 'links') {
              visibleColumns.splice(visibleColumns.length - 1, 0, col);
            }
          } else {
            visibleColumns = visibleColumns.filter((c) => c !== col);
          }
          renderHeader();
          refresh();
        });
      });

      settingsModal.querySelector('.settings-reset-btn').addEventListener('click', () => {
        visibleColumns = [...defaultDisplayCols, 'links'];
        settingsModal.querySelectorAll('.settings-col-checkbox').forEach((cb) => {
          cb.checked = visibleColumns.includes(cb.dataset.col);
        });
        renderHeader();
        refresh();
      });

      settingsModal.querySelector('.settings-close-btn').addEventListener('click', () => {
        settingsModal.remove();
        settingsModalOpen = false;
      });

      document.addEventListener('click', function handler(e) {
        if (!settingsModal.contains(e.target) && e.target !== settingsBtn) {
          settingsModal.remove();
          settingsModalOpen = false;
          document.removeEventListener('click', handler);
        }
      }, true);
    }

    settingsBtn.addEventListener('click', openSettingsModal);

    renderHeader();
    refresh();

    return { refresh, invalidateSort };
  }

  return container;
}

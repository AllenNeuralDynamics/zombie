/**
 * fiber_photometry/view.js — Fiber Photometry Platform dashboard.
 *
 * Registers `platform_fib` from S3, joins with `asset_basics`.
 * Schema is wide: one row per asset, columns fiber_N_targeted_structure and
 * fiber_N_intended_measurement for N = 0, 1, 2, … (detected dynamically).
 *
 * Top section: alert table of subjects (with investigators) that have any
 * fiber missing targeted_structure or intended_measurement.
 *
 * Main section: sortable/filterable/paginated table with S3/CO/Meta/QC links
 * and a settings button to toggle optional asset_basics columns.
 */

import { buildS3ConsoleUrl, buildQcLink, buildMetadataLink, buildCoLink } from '../assets/view.js';
import { escHtml, formatDatetime, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD } from '../lib/utils.js';

const FIB_S3_PATH = `s3://allen-data-views/data-asset-cache/zs_platform_fib.pqt`;

// asset_basics columns always shown
const ALWAYS_SHOWN_BASICS = ['subject_id', 'project_name'];

// asset_basics columns hidden behind settings
const OPTIONAL_BASICS = ['acquisition_start_time', 'data_level', 'modalities', 'genotype'];

const BASICS_LABELS = {
  subject_id: 'Subject',
  project_name: 'Project',
  acquisition_start_time: 'Acquired (UTC)',
  data_level: 'Level',
  modalities: 'Modalities',
  genotype: 'Genotype',
};

// ---------------------------------------------------------------------------
// Dynamic fiber column detection
// ---------------------------------------------------------------------------

/** Extract sorted fiber indices from the keys of any data row. */
function detectFiberIndices(rows) {
  if (!rows.length) return [];
  const seen = new Set();
  for (const key of Object.keys(rows[0])) {
    const m = key.match(/^fiber_(\d+)_/);
    if (m) seen.add(parseInt(m[1], 10));
  }
  return [...seen].sort((a, b) => a - b);
}

function fiberColumns(indices) {
  return indices.flatMap((i) => [
    `fiber_${i}_targeted_structure`,
    `fiber_${i}_intended_measurement`,
  ]);
}

function fiberLabels(indices) {
  const out = {};
  for (const i of indices) {
    out[`fiber_${i}_targeted_structure`] = `Fiber ${i} Target`;
    out[`fiber_${i}_intended_measurement`] = `Fiber ${i} Measurement`;
  }
  return out;
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

export function renderFibRow(row, visibleColumns, fiberIdx, columnLabels) {
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

  for (const i of fiberIdx) {
    cellValues[`fiber_${i}_targeted_structure`] = escHtml(String(row[`fiber_${i}_targeted_structure`] ?? ''));
    cellValues[`fiber_${i}_intended_measurement`] = escHtml(String(row[`fiber_${i}_intended_measurement`] ?? ''));
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
 * Find subjects where any fiber has a target but no measurement, or vice versa.
 * Returns [{subject_id, investigators, count}] sorted by subject_id.
 */
export function buildMissingTable(rows, fiberIdx) {
  const subjectMap = new Map();

  for (const row of rows) {
    const sid = row.subject_id ?? '';
    let rowHasMissing = false;

    for (const i of fiberIdx) {
      const target = row[`fiber_${i}_targeted_structure`];
      const meas = row[`fiber_${i}_intended_measurement`];
      // Fiber exists (has at least one field set) but is incomplete
      if ((target || meas) && (!target || !meas)) {
        rowHasMissing = true;
        break;
      }
    }

    if (!rowHasMissing) continue;

    if (!subjectMap.has(sid)) {
      subjectMap.set(sid, { subject_id: sid, investigators: new Set(), assetCount: 0 });
    }
    const entry = subjectMap.get(sid);
    entry.assetCount++;

    const exps = row.experimenters ?? '';
    String(exps).split(',').map((e) => e.trim()).filter(Boolean).forEach((e) => entry.investigators.add(e));
  }

  return Array.from(subjectMap.values())
    .sort((a, b) => String(a.subject_id).localeCompare(String(b.subject_id)))
    .map((e) => ({
      subject_id: e.subject_id,
      investigators: Array.from(e.investigators).join(', '),
      assetCount: e.assetCount,
    }));
}

// ---------------------------------------------------------------------------
// View factory
// ---------------------------------------------------------------------------

export function createFiberPhotometryView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view fib-view';

  const loadingEl = document.createElement('p');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading Fiber Photometry data…';
  container.appendChild(loadingEl);

  coord.exec(`CREATE OR REPLACE TABLE platform_fib AS SELECT * FROM read_parquet('${FIB_S3_PATH}')`)
    .then(() =>
      coord.query(
        `SELECT f.*, b.subject_id, b.project_name, b.acquisition_start_time,
                b.data_level, b.modalities, b.genotype, b.location,
                b.code_ocean, b.experimenters
         FROM platform_fib f
         LEFT JOIN asset_basics b ON b.name = f.asset_name
         ORDER BY b.acquisition_start_time DESC NULLS LAST, f.asset_name`,
        { type: 'json' },
      ),
    )
    .then((result) => {
      loadingEl.remove();
      const rows = Array.isArray(result) ? result
        : Array.isArray(result?.data) ? result.data
        : Array.from(result ?? []);
      buildPage(rows);
    })
    .catch((err) => {
      loadingEl.textContent = `Failed to load Fiber Photometry data: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    });

  function buildPage(allRows) {
    const fiberIdx = detectFiberIndices(allRows);
    const fibCols = fiberColumns(fiberIdx);
    const fibLabels = fiberLabels(fiberIdx);
    const columnLabels = { ...BASICS_LABELS, ...fibLabels };

    const allAvailableCols = [...ALWAYS_SHOWN_BASICS, ...fibCols, ...OPTIONAL_BASICS];
    const defaultDisplayCols = [...ALWAYS_SHOWN_BASICS, ...fibCols];

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

    // Alert section
    const missing = buildMissingTable(allRows, fiberIdx);
    if (missing.length > 0) {
      const alertSection = document.createElement('div');
      alertSection.className = 'fib-alert-section';

      const alertHeader = document.createElement('h3');
      alertHeader.className = 'fib-alert-title';
      alertHeader.textContent = `Subjects with incomplete fiber info (${missing.length})`;
      alertSection.appendChild(alertHeader);

      const alertDesc = document.createElement('p');
      alertDesc.className = 'fib-alert-desc';
      alertDesc.textContent = 'These subjects have assets where at least one fiber is missing a targeted structure or intended measurement.';
      alertSection.appendChild(alertDesc);

      const alertTable = document.createElement('table');
      alertTable.className = 'assets-table fib-alert-table';
      alertTable.innerHTML = `
        <thead><tr>
          <th>Subject</th>
          <th>Investigators</th>
          <th>Affected assets</th>
        </tr></thead>
        <tbody>
          ${missing.map((m) => {
            const subjectLink = m.subject_id
              ? `<a href="/subject?subject_id=${encodeURIComponent(m.subject_id)}">${escHtml(String(m.subject_id))}</a>`
              : '—';
            return `<tr>
              <td>${subjectLink}</td>
              <td>${escHtml(m.investigators || '—')}</td>
              <td>${m.assetCount}</td>
            </tr>`;
          }).join('')}
        </tbody>
      `;
      alertSection.appendChild(alertTable);
      topCard.appendChild(alertSection);
    }

    buildTable(allRows, topCard, settingsBtn, allAvailableCols, defaultDisplayCols, columnLabels, fiberIdx);
    container.appendChild(topCard);
  }

  function buildTable(allRows, target, settingsBtn, allAvailableCols, defaultDisplayCols, columnLabels, fiberIdx) {
    let sortCol = 'acquisition_start_time';
    let sortDir = 'desc';
    let visibleColumns = [...defaultDisplayCols, 'links'];
    let filters = Object.fromEntries(allAvailableCols.map((c) => [c, '']));
    let page = 0;
    let settingsModalOpen = false;

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
      return sortRows(filterRows(allRows, filters), sortCol, sortDir);
    }

    function refresh() {
      const rows = visibleRows();
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (page >= totalPages) page = totalPages - 1;

      const pageRows = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      tbody.innerHTML = pageRows.map((row) => renderFibRow(row, visibleColumns, fiberIdx, columnLabels)).join('');

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
  }

  return container;
}

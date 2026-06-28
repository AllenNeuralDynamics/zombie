/**
 * exaspim/view.js — ExaSPIM Assets page.
 *
 * Loads `platform_exaspim` (one row per asset) from S3,
 * joins with `asset_basics` for subject metadata.
 *
 * Pure helpers are exported for unit tests.
 */

import { buildS3ConsoleUrl, buildQcLink, buildMetadataLink, buildCoLink } from '../assets/links.js';
import { escHtml, formatDatetimeRaw, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD } from '../lib/utils.js';
import { createPlatformOverview } from '../lib/platform-overview.js';
import { ensureTable } from '../lib/registry.js';
import { queryRows } from '../lib/arrow.js';
import { createExaSpimMorphologySection } from './morphology.js';

// Re-export for backward compatibility with tests
export { sortRows, uniqueValues, filterRows };

// Fields pulled from asset_basics via JOIN
const BASICS_KEYS = [
  'subject_id', 'project_name', 'acquisition_start_time',
  'genotype', 'location', 'code_ocean', 'investigators', 'experimenters',
];

// Always-shown columns (cannot be hidden)
const ALWAYS_SHOWN = ['subject_id'];

// Default visible columns
const DEFAULT_COLS = [
  'subject_id', 'project_name', 'genotype', 'acquisition_start_time', 'processed',
];

// All available columns (for settings modal)
const ALL_COLS = [
  'subject_id', 'project_name', 'genotype', 'acquisition_start_time', 'processed',
  'investigators', 'experimenters', 'raw_name',
];

const COLUMN_LABELS = {
  subject_id: 'Subject',
  project_name: 'Project',
  genotype: 'Genotype',
  acquisition_start_time: 'Acquired',
  processed: 'Fused',
  investigators: 'Investigators',
  experimenters: 'Experimenters',
  raw_name: 'Asset Name',
};

// ---------------------------------------------------------------------------
// Link helpers
// ---------------------------------------------------------------------------

export function buildNeuroglancerLink(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  const safe = String(href).replace(/"/g, '&quot;');
  return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

function linkHtml(href, label) {
  if (!href) return '<span class="no-link">—</span>';
  return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}

export function isProcessed(row) {
  return row.processed === true || row.processed === 'true' || row.processed === 'Yes';
}

// ---------------------------------------------------------------------------
// Row renderer
// ---------------------------------------------------------------------------

export function renderExaSpimRow(row, visibleColumns) {
  const processedLabel = isProcessed(row)
    ? '<span class="badge badge-yes">Yes</span>'
    : '<span class="badge badge-no">No</span>';

  const proc = isProcessed(row);
  const s3Href = buildS3ConsoleUrl(proc ? (row.proc_location ?? null) : (row.location ?? null));
  const qcHref = buildQcLink(proc ? row.name : (row.raw_name ?? null));
  const metaHref = buildMetadataLink(proc ? row.name : (row.raw_name ?? null));
  const coHref = buildCoLink(proc ? (row.proc_code_ocean ?? null) : (row.code_ocean ?? null));

  const cellValues = {
    subject_id: row.subject_id
      ? `<a href="/view?subject_id=${encodeURIComponent(row.subject_id)}">${escHtml(String(row.subject_id))}</a>`
      : '',
    project_name: row.project_name
      ? `<a href="/view?project=${encodeURIComponent(row.project_name)}">${escHtml(String(row.project_name))}</a>`
      : '',
    genotype: escHtml(String(row.genotype ?? '')),
    acquisition_start_time: escHtml(formatDatetimeRaw(row.acquisition_start_time ?? null)),
    processed: processedLabel,
    investigators: escHtml(String(row.investigators ?? '')),
    experimenters: escHtml(String(row.experimenters ?? '')),
    raw_name: escHtml(String(row.raw_name ?? '')),
  };

  const cols = visibleColumns ?? DEFAULT_COLS;
  const cells = [...cols, 'links'].map((col) => {
    if (col === 'links') {
      const rawHtml = buildNeuroglancerLink(row.raw_link ?? null, 'Raw');
      const fusedHtml = buildNeuroglancerLink(row.fused_link ?? null, 'Fused');
      return `<td class="link-cell">` +
        `<div class="link-cell-split">` +
        `<span class="link-group-left">${rawHtml} ${fusedHtml}</span>` +
        `<span class="link-group-right">${linkHtml(coHref, 'CO')} ${linkHtml(qcHref, 'QC')} ${linkHtml(metaHref, 'Meta')} ${linkHtml(s3Href, 'S3')}</span>` +
        `</div>` +
        `</td>`;
    }
    return `<td>${cellValues[col] ?? ''}</td>`;
  });

  return `<tr>${cells.join('')}</tr>`;
}

// ---------------------------------------------------------------------------
// View factory
// ---------------------------------------------------------------------------

export function createExaSpimView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view exaspim-view';

  const loadingEl = document.createElement('p');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading ExaSPIM assets…';
  container.appendChild(loadingEl);

  ensureTable(coord, 'platform_exaspim')
    .then(() =>
      queryRows(coord,
        `SELECT s.name, s.raw_name, s.processed, s.raw_link, s.fused_link,
                b.subject_id, b.project_name, b.acquisition_start_time,
                b.genotype, b.location, b.code_ocean,
                b.investigators_normalized AS investigators,
                b.experimenters_normalized AS experimenters,
                p.location AS proc_location, p.code_ocean AS proc_code_ocean
         FROM platform_exaspim s
         LEFT JOIN asset_basics b ON b.name = s.raw_name
         LEFT JOIN asset_basics p ON p.name = s.name
         ORDER BY b.acquisition_start_time DESC NULLS LAST, s.name`,
      ),
    )
    .then((rows) => {
      loadingEl.remove();
      buildPage(rows);
    })
    .catch((err) => {
      loadingEl.textContent = `Failed to load ExaSPIM assets: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    });

  function buildPage(allRows) {
    const layout = document.createElement('div');
    layout.className = 'sessions-layout smartspim-layout';

    const filterPanel = document.createElement('div');
    filterPanel.className = 'sessions-filter-panel';

    const mainContent = document.createElement('div');
    mainContent.className = 'smartspim-main';

    layout.appendChild(filterPanel);
    layout.appendChild(mainContent);
    container.appendChild(createPlatformOverview(coord, {
      platformTableName: 'platform_exaspim',
      assetNameCol: 'name',
      assetFilter: { type: 'instrument_id_contains', value: 'exa' },
      platformKey: 'exaspim',
    }));
    container.appendChild(createExaSpimMorphologySection({ coordinator: coord }));
    container.appendChild(layout);

    // Subject sidebar
    const allSubjects = uniqueValues(allRows, 'subject_id').sort();
    const selectedSubjects = new Set();

    filterPanel.innerHTML = `<h3 class="sessions-panel-title">Filter</h3>`;

    const subjectGroup = document.createElement('div');
    subjectGroup.className = 'sessions-filter-group';

    const subjectLabel = document.createElement('div');
    subjectLabel.className = 'sessions-filter-label';
    subjectLabel.textContent = 'Subject ID';
    subjectGroup.appendChild(subjectLabel);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search…';
    searchInput.className = 'smartspim-subject-search';
    subjectGroup.appendChild(searchInput);

    const checkboxList = document.createElement('div');
    checkboxList.className = 'sessions-checkbox-list smartspim-subject-list';
    subjectGroup.appendChild(checkboxList);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'sessions-filter-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      selectedSubjects.clear();
      checkboxList.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; });
      onSubjectChange();
    });
    subjectGroup.appendChild(clearBtn);
    filterPanel.appendChild(subjectGroup);

    function renderSubjectCheckboxes(query) {
      const q = (query ?? '').toLowerCase().trim();
      const visible = q ? allSubjects.filter((s) => String(s).toLowerCase().includes(q)) : allSubjects;
      checkboxList.innerHTML = '';
      if (visible.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'sessions-filter-empty';
        empty.textContent = 'No matches';
        checkboxList.appendChild(empty);
        return;
      }
      for (const sid of visible) {
        const item = document.createElement('label');
        item.className = 'sessions-checkbox-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = sid;
        cb.checked = selectedSubjects.has(sid);
        cb.addEventListener('change', () => {
          if (cb.checked) selectedSubjects.add(sid);
          else selectedSubjects.delete(sid);
          onSubjectChange();
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode(' ' + sid));
        checkboxList.appendChild(item);
      }
    }

    renderSubjectCheckboxes('');
    searchInput.addEventListener('input', () => renderSubjectCheckboxes(searchInput.value));

    function getDisplayRows() {
      return selectedSubjects.size === 0
        ? allRows
        : allRows.filter((r) => selectedSubjects.has(String(r.subject_id ?? '')));
    }

    let topCard = null;

    function onSubjectChange() {
      if (topCard) topCard.remove();
      topCard = buildTopCard(getDisplayRows());
      mainContent.appendChild(topCard);
    }

    topCard = buildTopCard(getDisplayRows());
    mainContent.appendChild(topCard);
  }

  function buildTopCard(displayRows) {
    const topCard = document.createElement('div');
    topCard.className = 'smartspim-top-card';

    const header = document.createElement('div');
    header.className = 'assets-header';

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'assets-settings-btn icon-btn';
    settingsBtn.setAttribute('aria-label', 'Column settings');
    settingsBtn.innerHTML = '<img src="/icons/gear.svg" alt="Settings" />';
    header.appendChild(settingsBtn);

    topCard.appendChild(header);

    buildTable(displayRows, topCard, settingsBtn);
    return topCard;
  }

  function buildTable(allRows, target, settingsBtn) {
    let sortCol = 'acquisition_start_time';
    let sortDir = 'desc';
    let visibleColumns = [...DEFAULT_COLS];
    let filters = Object.fromEntries(ALL_COLS.map((c) => [c, '']));
    let page = 0;
    let settingsModalOpen = false;

    const uniques = {};
    for (const col of ALL_COLS) {
      uniques[col] = uniqueValues(allRows, col);
    }

    const useSelect = {};
    for (const col of ALL_COLS) {
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
      const displayCols = [...visibleColumns, 'links'];
      const headerRowHtml = displayCols.map((col) => {
        const label = COLUMN_LABELS[col] ?? col;
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
        const label = COLUMN_LABELS[col] ?? col;
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
      tbody.innerHTML = pageRows.map((row) => renderExaSpimRow(row, visibleColumns)).join('');

      const start = rows.length === 0 ? 0 : page * PAGE_SIZE + 1;
      const end = Math.min((page + 1) * PAGE_SIZE, rows.length);
      pagingBar.innerHTML = `
        <button class="page-btn" id="exaspim-prev-page" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
        <span class="page-info">${start}–${end} of ${rows.length.toLocaleString()}</span>
        <button class="page-btn" id="exaspim-next-page" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>
      `;
      pagingBar.querySelector('#exaspim-prev-page').addEventListener('click', () => { page--; refresh(); });
      pagingBar.querySelector('#exaspim-next-page').addEventListener('click', () => { page++; refresh(); });

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

      const listHtml = ALL_COLS.map((col) => {
        const isChecked = visibleColumns.includes(col);
        const isRequired = ALWAYS_SHOWN.includes(col);
        return `
          <label class="settings-checkbox-label">
            <input type="checkbox" class="settings-col-checkbox" data-col="${col}"
              ${isChecked ? 'checked' : ''} ${isRequired ? 'disabled' : ''} />
            <span>${COLUMN_LABELS[col] ?? col}${isRequired ? ' <em>(always shown)</em>' : ''}</span>
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
            if (!visibleColumns.includes(col)) {
              visibleColumns.splice(visibleColumns.length, 0, col);
            }
          } else {
            visibleColumns = visibleColumns.filter((c) => c !== col);
          }
          renderHeader();
          refresh();
        });
      });

      settingsModal.querySelector('.settings-reset-btn').addEventListener('click', () => {
        visibleColumns = [...DEFAULT_COLS];
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

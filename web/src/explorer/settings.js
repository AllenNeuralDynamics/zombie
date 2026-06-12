/**
 * settings.js — Settings Bar: multi-project selector, column filters, and data-type toggles.
 *
 * Pure URL helpers are exported for unit testing.
 * initSettings() wires a $queryFilter Param (holding selected projects +
 * extra column filters), checkbox data-type toggles, and URL state sync.
 *
 * $queryFilter.value shape:
 *   { projects: string[], extraFilters: Array<{ column: string, values: string[] }> }
 */

import { Param } from '@uwdata/vgplot';
import { getAssetAcorns, registerAcornTable, dropAcornTable, fetchSubjectIdsForQuery } from '../lib/metadata.js';
import { URL_PARAM_PROJECTS, URL_PARAM_DATA_TYPES, URL_PARAM_EXTRA_FILTERS } from '../constants.js';

// ---------------------------------------------------------------------------
// # Pure URL helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Extract the initially-selected project names from a URL search string.
 *
 * @param {string} search - URLSearchParams-compatible string, e.g. "?projects=foo,bar"
 * @returns {string[]} Array of project names (may be empty).
 */
export function getInitialProjectsFromUrl(search) {
  const params = new URLSearchParams(search);
  const raw = params.get(URL_PARAM_PROJECTS);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Extract the initial enabled data-type names from a URL search string.
 *
 * @param {string} search - URLSearchParams-compatible string.
 * @returns {string[]} Array of enabled acorn names (may be empty).
 */
export function getInitialDataTypesFromUrl(search) {
  const params = new URLSearchParams(search);
  const raw = params.get(URL_PARAM_DATA_TYPES);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Decode extra-filter entries from the URL `extraFilters` param.
 *
 * Encoding format: `col1:val1|val2,col2:val3`
 *   - Comma separates filter entries.
 *   - Colon separates column name from values.
 *   - Pipe separates individual values within one filter.
 *   - Each component is percent-encoded.
 *
 * @param {string} search - URLSearchParams-compatible string.
 * @returns {Array<{ column: string, values: string[] }>}
 */
export function getInitialExtraFiltersFromUrl(search) {
  const params = new URLSearchParams(search);
  const raw = params.get(URL_PARAM_EXTRA_FILTERS);
  if (!raw) return [];
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const colonIdx = token.indexOf(':');
      if (colonIdx < 0) return null;
      const column = decodeURIComponent(token.slice(0, colonIdx));
      const values = token
        .slice(colonIdx + 1)
        .split('|')
        .map((v) => decodeURIComponent(v.trim()))
        .filter(Boolean);
      return column && values.length > 0 ? { column, values } : null;
    })
    .filter(Boolean);
}

/**
 * Encode an extra-filters array into a URL param value string.
 *
 * @param {Array<{ column: string, values: string[] }>} extraFilters
 * @returns {string} Encoded string, or "" when empty.
 */
export function encodeExtraFilters(extraFilters) {
  return extraFilters
    .filter((f) => f.values.length > 0)
    .map(
      (f) =>
        encodeURIComponent(f.column) +
        ':' +
        f.values.map((v) => encodeURIComponent(v)).join('|'),
    )
    .join(',');
}

/**
 * Build a URL search string reflecting the current query filter, enabled
 * data types, and extra column filters.
 *
 * @param {string[]}                               projects         - Selected project names.
 * @param {string[]}                               enabledTypeNames - Enabled acorn names.
 * @param {Array<{ column: string, values: string[] }>} extraFilters - Additional column filters.
 * @param {string}                                 [baseSearch='']  - Existing search to merge.
 * @returns {string} URL search string (e.g. "?projects=foo&dataTypes=qc"), or "".
 */
export function buildSettingsUrl(projects, enabledTypeNames, extraFilters = [], baseSearch = '') {
  const params = new URLSearchParams(baseSearch);
  if (projects && projects.length > 0) {
    params.set(URL_PARAM_PROJECTS, projects.join(','));
  } else {
    params.delete(URL_PARAM_PROJECTS);
  }
  if (enabledTypeNames.length > 0) {
    params.set(URL_PARAM_DATA_TYPES, enabledTypeNames.join(','));
  } else {
    params.delete(URL_PARAM_DATA_TYPES);
  }
  const efs = encodeExtraFilters(extraFilters);
  if (efs) {
    params.set(URL_PARAM_EXTRA_FILTERS, efs);
  } else {
    params.delete(URL_PARAM_EXTRA_FILTERS);
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

// ---------------------------------------------------------------------------
// # DOM helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Build a labeled checkbox element for one data-type toggle.
 *
 * @param {string}  name    - Acorn name (used as the checkbox id prefix).
 * @param {boolean} checked - Initial checked state.
 * @returns {{ wrapperEl: HTMLLabelElement, checkbox: HTMLInputElement }}
 */
export function buildDataTypeCheckbox(name, checked) {
  const wrapperEl = document.createElement('label');
  wrapperEl.className = 'data-type-label';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = `dtype-${name}`;
  checkbox.checked = checked;

  const text = document.createTextNode(` ${name.replace(/_/g, ' ')}`);
  wrapperEl.appendChild(checkbox);
  wrapperEl.appendChild(text);

  return { wrapperEl, checkbox };
}

// ---------------------------------------------------------------------------
// # Internal DOM builders
// ---------------------------------------------------------------------------

/**
 * Build the project multi-select section.
 *
 * Renders a collapsible panel with a search input and one checkbox per
 * project.  The project list is loaded asynchronously from DuckDB.
 *
 * @param {object}   coord           - Mosaic coordinator.
 * @param {string[]} initialProjects - Project names checked on load.
 * @param {function(string[]): void} onChange - Called whenever selection changes.
 * @returns {{ el: HTMLElement, setProjects: function(string[]): void }}
 */
function buildProjectSection(coord, initialProjects, onChange) {
  const checkedSet = new Set(initialProjects);

  const sectionEl = document.createElement('div');
  sectionEl.className = 'query-section project-section';

  const headerEl = document.createElement('div');
  headerEl.className = 'query-section-header';

  const labelEl = document.createElement('span');
  labelEl.className = 'query-section-label';
  labelEl.textContent = 'Projects';

  const summaryEl = document.createElement('span');
  summaryEl.className = 'query-section-summary';
  summaryEl.textContent = initialProjects.length > 0 ? `${initialProjects.length} selected` : 'none';

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'query-section-toggle';
  toggleBtn.textContent = '▾';
  toggleBtn.setAttribute('aria-expanded', 'true');

  headerEl.appendChild(labelEl);
  headerEl.appendChild(summaryEl);
  headerEl.appendChild(toggleBtn);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'query-section-body';

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Filter projects…';
  searchInput.className = 'project-search';

  const listEl = document.createElement('div');
  listEl.className = 'project-list';
  listEl.textContent = 'Loading…';

  const actionsEl = document.createElement('div');
  actionsEl.className = 'project-actions';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.textContent = 'Select all';
  selectAllBtn.className = 'project-action-btn';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = 'Clear';
  clearBtn.className = 'project-action-btn';

  actionsEl.appendChild(selectAllBtn);
  actionsEl.appendChild(clearBtn);

  bodyEl.appendChild(actionsEl);
  bodyEl.appendChild(searchInput);
  bodyEl.appendChild(listEl);

  sectionEl.appendChild(headerEl);
  sectionEl.appendChild(bodyEl);

  toggleBtn.addEventListener('click', () => {
    const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    toggleBtn.setAttribute('aria-expanded', String(!expanded));
    toggleBtn.textContent = expanded ? '▸' : '▾';
    bodyEl.style.display = expanded ? 'none' : '';
  });

  let allProjects = [];
  const checkboxMap = new Map();

  function updateSummary() {
    const n = checkedSet.size;
    summaryEl.textContent = n > 0 ? `${n} selected` : 'none';
  }

  function renderList(projects) {
    listEl.innerHTML = '';
    for (const name of projects) {
      const label = document.createElement('label');
      label.className = 'project-checkbox-label';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = name;
      cb.checked = checkedSet.has(name);
      checkboxMap.set(name, cb);

      cb.addEventListener('change', () => {
        if (cb.checked) {
          checkedSet.add(name);
        } else {
          checkedSet.delete(name);
        }
        updateSummary();
        onChange([...checkedSet]);
      });

      const nameSpan = document.createElement('span');
      nameSpan.className = 'project-name';
      nameSpan.textContent = name;
      label.appendChild(cb);
      label.appendChild(nameSpan);
      listEl.appendChild(label);
    }
  }

  function getFilteredProjects() {
    const q = searchInput.value.trim().toLowerCase();
    return q ? allProjects.filter((p) => p.toLowerCase().includes(q)) : allProjects;
  }

  searchInput.addEventListener('input', () => renderList(getFilteredProjects()));

  selectAllBtn.addEventListener('click', () => {
    for (const name of getFilteredProjects()) {
      checkedSet.add(name);
      const cb = checkboxMap.get(name);
      if (cb) cb.checked = true;
    }
    updateSummary();
    onChange([...checkedSet]);
  });

  clearBtn.addEventListener('click', () => {
    for (const name of getFilteredProjects()) {
      checkedSet.delete(name);
      const cb = checkboxMap.get(name);
      if (cb) cb.checked = false;
    }
    updateSummary();
    onChange([...checkedSet]);
  });

  coord.query(
    'SELECT project_name FROM unique_project_names ORDER BY project_name',
  )
    .then((result) => {
      const col = result.getChild('project_name');
      allProjects = col
        ? Array.from({ length: col.length }, (_, i) => String(col.get(i)))
        : [];
      renderList(allProjects);
    })
    .catch(() => {
      listEl.textContent = 'Failed to load projects.';
    });

  return {
    el: sectionEl,
    setProjects: (names) => {
      checkedSet.clear();
      for (const n of names) checkedSet.add(n);
      for (const [name, cb] of checkboxMap) {
        cb.checked = checkedSet.has(name);
      }
      updateSummary();
    },
  };
}

/**
 * Fetch distinct non-null values for a column in asset_basics (max 300).
 *
 * @param {object} coord
 * @param {string} column
 * @returns {Promise<string[]>}
 */
async function fetchColumnValues(coord, column) {
  const safe = column.replace(/"/g, '""');
  try {
    const result = await coord.query(
      `SELECT DISTINCT "${safe}"::VARCHAR AS v FROM asset_basics WHERE "${safe}" IS NOT NULL ORDER BY v LIMIT 300`,
    );
    const col = result.getChild('v');
    if (!col) return [];
    return Array.from({ length: col.length }, (_, i) => String(col.get(i)));
  } catch {
    return [];
  }
}

/**
 * Build the extra-filters section.
 *
 * Each filter row lets the user pick an asset_basics column and then choose
 * values from a populated multi-select.  Rows can be added and removed.
 *
 * @param {object}   coord               - Mosaic coordinator.
 * @param {string[]} availableColumns    - Columns that can be filtered.
 * @param {Array<{ column: string, values: string[] }>} initialFilters
 * @param {function(Array<{ column: string, values: string[] }>): void} onChange
 * @returns {{ el: HTMLElement }}
 */
function buildExtraFiltersSection(coord, availableColumns, initialFilters, onChange) {
  const sectionEl = document.createElement('div');
  sectionEl.className = 'query-section filters-section';

  const headerEl = document.createElement('div');
  headerEl.className = 'query-section-header';

  const labelEl = document.createElement('span');
  labelEl.className = 'query-section-label';
  labelEl.textContent = 'Filters';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'add-filter-btn';
  addBtn.textContent = '+ Add';

  headerEl.appendChild(labelEl);
  headerEl.appendChild(addBtn);

  const rowsEl = document.createElement('div');
  rowsEl.className = 'filter-rows';

  sectionEl.appendChild(headerEl);
  sectionEl.appendChild(rowsEl);

  const filterRows = [];

  function notifyChange() {
    onChange(
      filterRows
        .map((r) => ({ column: r.column, values: r.getValues() }))
        .filter((f) => f.column && f.values.length > 0),
    );
  }

  function addFilterRow(initialColumn = '', initialValues = []) {
    const rowEl = document.createElement('div');
    rowEl.className = 'filter-row';

    const colSelect = document.createElement('select');
    colSelect.className = 'filter-col-select';

    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '— column —';
    colSelect.appendChild(blankOpt);

    for (const col of availableColumns) {
      const opt = document.createElement('option');
      opt.value = col;
      opt.textContent = col;
      opt.selected = col === initialColumn;
      colSelect.appendChild(opt);
    }

    const valuesEl = document.createElement('div');
    valuesEl.className = 'filter-values';

    const valuesHint = document.createElement('span');
    valuesHint.className = 'filter-values-hint';
    valuesHint.textContent = 'Select a column first';
    valuesEl.appendChild(valuesHint);

    let valuesSelect = null;
    let currentColumn = initialColumn;

    async function loadValues(column) {
      currentColumn = column;
      valuesEl.innerHTML = '';
      if (!column) {
        const hint = document.createElement('span');
        hint.className = 'filter-values-hint';
        hint.textContent = 'Select a column first';
        valuesEl.appendChild(hint);
        return;
      }
      const loadingSpan = document.createElement('span');
      loadingSpan.className = 'filter-values-hint';
      loadingSpan.textContent = 'Loading…';
      valuesEl.appendChild(loadingSpan);

      const vals = await fetchColumnValues(coord, column);
      valuesEl.innerHTML = '';

      if (vals.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'filter-values-hint';
        empty.textContent = 'No values found';
        valuesEl.appendChild(empty);
        return;
      }

      valuesSelect = document.createElement('select');
      valuesSelect.multiple = true;
      valuesSelect.className = 'filter-values-select';
      valuesSelect.size = Math.min(vals.length, 6);

      for (const v of vals) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        opt.selected = initialValues.includes(v);
        valuesSelect.appendChild(opt);
      }

      valuesSelect.addEventListener('change', notifyChange);
      valuesEl.appendChild(valuesSelect);
    }

    colSelect.addEventListener('change', () => {
      rowState.column = colSelect.value;
      loadValues(colSelect.value);
      notifyChange();
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'filter-remove-btn';
    removeBtn.textContent = '×';
    removeBtn.setAttribute('aria-label', 'Remove filter');

    removeBtn.addEventListener('click', () => {
      const idx = filterRows.indexOf(rowState);
      if (idx >= 0) filterRows.splice(idx, 1);
      rowEl.remove();
      notifyChange();
    });

    rowEl.appendChild(colSelect);
    rowEl.appendChild(valuesEl);
    rowEl.appendChild(removeBtn);
    rowsEl.appendChild(rowEl);

    const rowState = {
      column: initialColumn,
      getValues: () => {
        if (!valuesSelect) return [];
        return Array.from(valuesSelect.options)
          .filter((o) => o.selected)
          .map((o) => o.value);
      },
    };

    filterRows.push(rowState);

    if (initialColumn) loadValues(initialColumn);
  }

  addBtn.addEventListener('click', () => addFilterRow());

  for (const f of initialFilters) {
    addFilterRow(f.column, f.values);
  }

  return { el: sectionEl };
}

// ---------------------------------------------------------------------------
// # Settings initialisation (requires Mosaic coordinator + real DOM)
// ---------------------------------------------------------------------------

/**
 * Initialise the Settings Bar.
 *
 * Creates:
 * - A multi-select project list (loaded from `unique_project_names`).
 * - An extra-filters panel for arbitrary `asset_basics` column filtering.
 * - One checkbox per asset-type acorn that registers/drops DuckDB tables.
 * - URL state sync on every change.
 *
 * @param {object}               coord    - Mosaic coordinator instance.
 * @param {{ acorns: object[] }} metadata - Parsed cache_registry.json.
 * @returns {{
 *   $queryFilter:    import('@uwdata/mosaic-core').Param,
 *   getEnabledTypes: () => Map<string, boolean>,
 *   settingsEl:      HTMLElement,
 *   onTableLoading:  (cb: function) => void,
 *   onTableRegistered: (cb: function) => void,
 * }}
 */
export function initSettings(coord, metadata) {
  const assetAcorns = getAssetAcorns(metadata.acorns);

  const initialProjects = getInitialProjectsFromUrl(window.location.search);
  const initialExtraFilters = getInitialExtraFiltersFromUrl(window.location.search);
  const initialEnabledSet = new Set(getInitialDataTypesFromUrl(window.location.search));

  const tableLoadingCallbacks = [];
  const tableRegisteredCallbacks = [];
  const tableFailedCallbacks = [];

  function fireTableLoading(name) {
    for (const cb of tableLoadingCallbacks) cb(name);
  }

  function fireTableRegistered(name) {
    for (const cb of tableRegisteredCallbacks) cb(name);
  }

  function fireTableFailed(name) {
    for (const cb of tableFailedCallbacks) cb(name);
  }

  const $queryFilter = Param.value({ projects: initialProjects, extraFilters: initialExtraFilters });

  async function reregisterEnabledTables(queryFilter) {
    const enabledEntries = [...dataTypeState.entries()].filter(([, s]) => s.enabled);
    if (enabledEntries.length === 0) return;
    const subjectIds = await fetchSubjectIdsForQuery(coord, queryFilter);
    for (const [, state] of enabledEntries) {
      fireTableLoading(state.acorn.name);
      try {
        await registerAcornTable(coord, state.acorn, { subjectIds });
        fireTableRegistered(state.acorn.name);
      } catch (err) {
        console.error(`[DataExplorer] Failed to re-register "${state.acorn.name}":`, err);
        fireTableFailed(state.acorn.name);
      }
    }
  }

  $queryFilter.addEventListener('value', async (value) => {
    history.replaceState(
      {},
      '',
      buildSettingsUrl(value.projects, _getEnabledTypeNames(), value.extraFilters),
    );
    await reregisterEnabledTables(value);
  });

  const assetBasicsAcorn = metadata.acorns.find((a) => a.name === 'asset_basics');
  const filterableColumns = (assetBasicsAcorn?.columns ?? []).filter(
    (c) => c !== 'project_name',
  );

  const { el: projectSectionEl } = buildProjectSection(
    coord,
    initialProjects,
    (selectedProjects) => {
      const current = $queryFilter.value;
      $queryFilter.update({ ...current, projects: selectedProjects });
    },
  );

  const { el: filtersSectionEl } = buildExtraFiltersSection(
    coord,
    filterableColumns,
    initialExtraFilters,
    (extraFilters) => {
      const current = $queryFilter.value;
      $queryFilter.update({ ...current, extraFilters });
    },
  );

  const dataTypeState = new Map();

  const dataTypeContainer = document.createElement('div');
  dataTypeContainer.className = 'data-type-toggles';

  const togglesLabel = document.createElement('span');
  togglesLabel.className = 'toggles-label';
  togglesLabel.textContent = 'Data types:';
  dataTypeContainer.appendChild(togglesLabel);

  for (const acorn of assetAcorns) {
    const initialChecked = initialEnabledSet.has(acorn.name);
    const { wrapperEl, checkbox } = buildDataTypeCheckbox(acorn.name, initialChecked);

    dataTypeState.set(acorn.name, { acorn, enabled: initialChecked, checkbox });
    dataTypeContainer.appendChild(wrapperEl);

    if (initialChecked) {
      fireTableLoading(acorn.name);
      fetchSubjectIdsForQuery(coord, $queryFilter.value)
        .then((subjectIds) => registerAcornTable(coord, acorn, { subjectIds }))
        .then(() => {
          fireTableRegistered(acorn.name);
        })
        .catch((err) => {
          console.error(`[DataExplorer] Failed to register table "${acorn.name}":`, err);
          checkbox.checked = false;
          dataTypeState.get(acorn.name).enabled = false;
          fireTableFailed(acorn.name);
        });
    }

    checkbox.addEventListener('change', async () => {
      const state = dataTypeState.get(acorn.name);
      if (checkbox.checked) {
        checkbox.disabled = true;
        fireTableLoading(acorn.name);
        try {
          const subjectIds = await fetchSubjectIdsForQuery(coord, $queryFilter.value);
          await registerAcornTable(coord, acorn, { subjectIds });
          state.enabled = true;
          fireTableRegistered(acorn.name);
        } catch (err) {
          console.error(`[DataExplorer] Failed to register table "${acorn.name}":`, err);
          checkbox.checked = false;
          state.enabled = false;
          fireTableFailed(acorn.name);
        } finally {
          checkbox.disabled = false;
        }
      } else {
        await dropAcornTable(coord, acorn.name);
        state.enabled = false;
      }
      const qf = $queryFilter.value;
      history.replaceState(
        {},
        '',
        buildSettingsUrl(qf.projects, _getEnabledTypeNames(), qf.extraFilters),
      );
    });
  }

  function _getEnabledTypeNames() {
    return [...dataTypeState.entries()]
      .filter(([, s]) => s.enabled)
      .map(([name]) => name);
  }

  const settingsEl = document.createElement('div');
  settingsEl.className = 'settings-content';

  const queryEl = document.createElement('div');
  queryEl.className = 'query-panel';
  queryEl.appendChild(projectSectionEl);
  queryEl.appendChild(filtersSectionEl);

  settingsEl.appendChild(queryEl);
  if (assetAcorns.length > 0) {
    settingsEl.appendChild(dataTypeContainer);
  }

  return {
    $queryFilter,
    getEnabledTypes: () =>
      new Map([...dataTypeState.entries()].map(([k, v]) => [k, v.enabled])),
    settingsEl,
    onTableLoading: (cb) => tableLoadingCallbacks.push(cb),
    onTableRegistered: (cb) => tableRegisteredCallbacks.push(cb),
    onTableFailed: (cb) => tableFailedCallbacks.push(cb),
  };
}

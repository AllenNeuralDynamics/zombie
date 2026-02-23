/**
 * settings.js — Settings Bar: project selector and data-type toggles.
 *
 * Pure URL helpers are exported for unit testing.
 * initSettings() wires Mosaic Params, a menu widget, and checkbox DOM
 * elements together, then handles URL state sync.
 */

import { Param, menu } from '@uwdata/vgplot';
import { getAssetAcorns, registerAcornTable, dropAcornTable, fetchSubjectIdsForProject } from './metadata.js';
import { URL_PARAM_PROJECT, URL_PARAM_DATA_TYPES } from './constants.js';

// ---------------------------------------------------------------------------
// # Pure URL helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Extract the initial project name from a URL search string.
 *
 * @param {string} search - URLSearchParams-compatible string, e.g. "?project=foo"
 * @returns {string | null} Project name, or null if not present.
 */
export function getInitialProjectFromUrl(search) {
  const params = new URLSearchParams(search);
  return params.get(URL_PARAM_PROJECT) ?? null;
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
 * Build a URL search string reflecting the current project + enabled types.
 *
 * @param {string | null} project          - Selected project name, or null.
 * @param {string[]}      enabledTypeNames - Array of enabled acorn names.
 * @param {string}        [baseSearch='']  - Existing search string to merge with.
 * @returns {string} Updated search string, e.g. "?project=foo&dataTypes=qc".
 *                   Returns "" when both project and types are empty.
 */
export function buildSettingsUrl(project, enabledTypeNames, baseSearch = '') {
  const params = new URLSearchParams(baseSearch);
  if (project) {
    params.set(URL_PARAM_PROJECT, project);
  } else {
    params.delete(URL_PARAM_PROJECT);
  }
  if (enabledTypeNames.length > 0) {
    params.set(URL_PARAM_DATA_TYPES, enabledTypeNames.join(','));
  } else {
    params.delete(URL_PARAM_DATA_TYPES);
  }
  const str = params.toString();
  return str ? `?${str}` : '';
}

// ---------------------------------------------------------------------------
// # DOM helpers (tested indirectly via initSettings)
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

  // Pretty-print: underscores → spaces
  const text = document.createTextNode(` ${name.replace(/_/g, ' ')}`);
  wrapperEl.appendChild(checkbox);
  wrapperEl.appendChild(text);

  return { wrapperEl, checkbox };
}

// ---------------------------------------------------------------------------
// # Settings initialisation (requires Mosaic coordinator + real DOM)
// ---------------------------------------------------------------------------

/**
 * Initialise the Settings Bar.
 *
 * Creates:
 * - A `$project` Param bound to a Mosaic `menu` widget (populated from the
 *   `unique_project_names` DuckDB table registered at startup).
 * - One checkbox per asset-type acorn, which registers/drops the corresponding
 *   DuckDB table when toggled.
 * - URL state sync on every change.
 *
 * @param {object}              coord    - Mosaic coordinator instance.
 * @param {{ acorns: object[] }} metadata - Parsed squirrel.json.
 * @returns {{
 *   $project:        import('@uwdata/mosaic-core').Param,
 *   getEnabledTypes: () => Map<string, boolean>,
 *   settingsEl:      HTMLElement,
 * }}
 */
export function initSettings(coord, metadata) {
  const assetAcorns = getAssetAcorns(metadata.acorns);

  // Read initial state from URL
  const initialProject = getInitialProjectFromUrl(window.location.search);
  const initialEnabledSet = new Set(getInitialDataTypesFromUrl(window.location.search));

  // Subscribers notified when a table registration starts
  const tableLoadingCallbacks = [];

  function fireTableLoading(name) {
    for (const cb of tableLoadingCallbacks) cb(name);
  }

  // Subscribers notified when a table is registered
  const tableRegisteredCallbacks = [];

  function fireTableRegistered(name) {
    for (const cb of tableRegisteredCallbacks) cb(name);
  }

  // --- $project Param ---
  const $project = Param.value(initialProject);

  // Sync every project change back to the URL and re-register enabled tables
  // so they are filtered to the new project's subjects.
  $project.addEventListener('value', async (value) => {
    history.replaceState({}, '', buildSettingsUrl(value, _getEnabledTypeNames()));

    const enabledEntries = [...dataTypeState.entries()].filter(([, s]) => s.enabled);
    if (enabledEntries.length === 0) return;

    const subjectIds = await fetchSubjectIdsForProject(coord, value);
    for (const [, state] of enabledEntries) {
      fireTableLoading(state.acorn.name);
      try {
        await registerAcornTable(coord, state.acorn, { subjectIds });
        fireTableRegistered(state.acorn.name);
      } catch (err) {
        console.error(`[ZOMBIE] Failed to re-register "${state.acorn.name}" for new project:`, err);
      }
    }
  });

  // --- Project menu widget (Mosaic client: queries unique_project_names) ---
  const projectMenuEl = menu({
    from: 'unique_project_names',
    column: 'project_name',
    label: 'Project',
    value: initialProject,
    as: $project,
  });
  projectMenuEl.classList.add('project-menu');

  // --- Data-type toggle state ---
  // Maps acorn name → { acorn, enabled, checkbox }
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

    // Eagerly register tables that were already enabled via URL params,
    // filtered to the current project's subjects.
    if (initialChecked) {
      fireTableLoading(acorn.name);
      fetchSubjectIdsForProject(coord, $project.value)
        .then((subjectIds) => registerAcornTable(coord, acorn, { subjectIds }))
        .then(() => {
          fireTableRegistered(acorn.name);
        })
        .catch((err) => {
          console.error(`[ZOMBIE] Failed to register table "${acorn.name}":`, err);
          checkbox.checked = false;
          dataTypeState.get(acorn.name).enabled = false;
        });
    }

    checkbox.addEventListener('change', async () => {
      const state = dataTypeState.get(acorn.name);
      if (checkbox.checked) {
        checkbox.disabled = true;
        fireTableLoading(acorn.name);
        try {
          const subjectIds = await fetchSubjectIdsForProject(coord, $project.value);
          await registerAcornTable(coord, acorn, { subjectIds });
          state.enabled = true;
          fireTableRegistered(acorn.name);
        } catch (err) {
          console.error(`[ZOMBIE] Failed to register table "${acorn.name}":`, err);
          checkbox.checked = false;
          state.enabled = false;
        } finally {
          checkbox.disabled = false;
        }
      } else {
        await dropAcornTable(coord, acorn.name);
        state.enabled = false;
      }
      history.replaceState({}, '', buildSettingsUrl($project.value, _getEnabledTypeNames()));
    });
  }

  /** Return the names of all currently-enabled data types. */
  function _getEnabledTypeNames() {
    return [...dataTypeState.entries()]
      .filter(([, s]) => s.enabled)
      .map(([name]) => name);
  }

  // --- Compose the settings bar DOM ---
  const settingsEl = document.createElement('div');
  settingsEl.className = 'settings-content';
  settingsEl.appendChild(projectMenuEl);
  if (assetAcorns.length > 0) {
    settingsEl.appendChild(dataTypeContainer);
  }

  return {
    $project,
    /** Return a snapshot Map<name, enabled> of data-type checkbox states. */
    getEnabledTypes: () =>
      new Map([...dataTypeState.entries()].map(([k, v]) => [k, v.enabled])),
    settingsEl,
    /** Register a callback fired whenever a data-type table starts loading. */
    onTableLoading: (cb) => tableLoadingCallbacks.push(cb),
    /** Register a callback fired whenever a data-type table is successfully registered. */
    onTableRegistered: (cb) => tableRegisteredCallbacks.push(cb),
  };
}

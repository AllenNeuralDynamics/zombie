/**
 * contributions-view.js — CReDIT Author Contribution Matrix page.
 *
 * Pure helpers (parseAssetNames, extractAuthors, initMatrix, formatAuthorForLatex,
 * generateLatex, toEndpointPayload, fromEndpointPayload, rowsToWidgetAuthors)
 * are exported for unit testing.
 *
 * createContributionsView(options) builds and returns a DOM element.
 */

import { fetchDocDbRecordsByName } from '../lib/docdb.js';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { createPreview } from './preview.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * All 14 CRediT taxonomy roles in widget display order.
 * These match ALL_CREDIT_ROLES in preview.js (and the upstream authorship widget).
 */
export const CREDIT_CATEGORIES = [
  'Conceptualization',
  'Methodology',
  'Software',
  'Validation',
  'Formal analysis',
  'Investigation',
  'Resources',
  'Data curation',
  'Writing \u2013 original draft',
  'Writing \u2013 review & editing',
  'Visualization',
  'Supervision',
  'Project Administration',
  'Funding Acquisition',
];

/** Contribution levels in ascending order. */
export const CONTRIBUTION_LEVELS = ['None', 'Supporting', 'Equal', 'Lead'];

/**
 * Map from CREDIT_CATEGORIES display name to the endpoint's CreditRole enum value
 * (kebab-case, as defined in aind_metadata_viz.contributions.models.CreditRole).
 */
export const CREDIT_ROLE_ENUM = {
  'Conceptualization':               'conceptualization',
  'Methodology':                     'methodology',
  'Software':                        'software',
  'Validation':                      'validation',
  'Formal analysis':                 'formal-analysis',
  'Investigation':                   'investigation',
  'Resources':                       'resources',
  'Data curation':                   'data-curation',
  'Writing \u2013 original draft':   'writing-original-draft',
  'Writing \u2013 review & editing': 'writing-review-editing',
  'Visualization':                   'visualization',
  'Supervision':                     'supervision',
  'Project Administration':          'project-administration',
  'Funding Acquisition':             'funding-acquisition',
};

/** Reverse map: endpoint enum value → display name. */
export const CREDIT_ROLE_ENUM_REVERSE = Object.fromEntries(
  Object.entries(CREDIT_ROLE_ENUM).map(([k, v]) => [v, k]),
);

/**
 * LaTeX macro values for each contribution level.
 * Used to fill TikZ heatmap tiles.
 */
const LATEX_LEVEL_VALUES = { None: 0, Supporting: '\\lo', Equal: '\\med', Lead: '\\hi' };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse a comma-separated string of asset names into a deduplicated array.
 *
 * @param {string} str - e.g. "asset-a, asset-b, asset-a"
 * @returns {string[]}
 */
export function parseAssetNames(str) {
  if (!str) return [];
  const seen = new Set();
  return str
    .split(',')
    .map((s) => s.trim())
    .filter((s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}

/**
 * Walk a list of DocDB records and return unique author names with the
 * sources they were found in.
 *
 * Ports `_extract_authors` from contributions.py.
 *
 * @param {Array<Record<string, unknown>>} records
 * @returns {{ authors: string[], authorSources: Record<string, string[]> }}
 */
export function extractAuthors(records) {
  const authors = [];
  /** @type {Record<string, string[]>} */
  const authorSources = {};

  function addName(name, source) {
    if (!name) return;
    const trimmed = String(name).trim();
    const lower = trimmed.toLowerCase();
    if (!trimmed || lower === 'unknown' || lower === 'na' || lower === 'n/a') return;

    if (!authorSources[trimmed]) {
      authors.push(trimmed);
      authorSources[trimmed] = [];
    }
    if (!authorSources[trimmed].includes(source)) {
      authorSources[trimmed].push(source);
    }
  }

  for (const record of records) {
    const dataDesc = record.data_description ?? {};

    // Investigators
    for (const inv of dataDesc.investigators ?? []) {
      addName(typeof inv === 'object' ? inv?.name : inv, 'investigators');
    }

    // Funding fundees
    for (const funding of dataDesc.funding_source ?? []) {
      const fundee = funding.fundee;
      if (Array.isArray(fundee)) {
        for (const person of fundee) {
          addName(typeof person === 'object' ? person?.name : person, 'funding');
        }
      } else if (typeof fundee === 'string') {
        for (const part of fundee.replace(/ and /gi, ',').split(',')) {
          addName(part.trim(), 'funding');
        }
      }
    }

    // Acquisition experimenters
    for (const exp of record.acquisition?.experimenters ?? []) {
      addName(typeof exp === 'object' ? exp?.name : exp, 'acquisition');
    }

    // Procedures — subject_procedures
    for (const proc of record.procedures?.subject_procedures ?? []) {
      for (const exp of proc.experimenters ?? []) {
        addName(typeof exp === 'object' ? exp?.name : exp, 'procedures');
      }
    }

    // Procedures — specimen_procedures
    for (const proc of record.procedures?.specimen_procedures ?? []) {
      for (const exp of proc.experimenters ?? []) {
        addName(typeof exp === 'object' ? exp?.name : exp, 'procedures');
      }
    }

    // Processing — data_processes
    for (const process of record.processing?.data_processes ?? []) {
      for (const exp of process.experimenters ?? []) {
        addName(typeof exp === 'object' ? exp?.name : exp, 'processing');
      }
    }
  }

  return { authors, authorSources };
}

/**
 * Create an initial matrix row array from an author list.
 * Each row has `name`, `isFirst`, and one key per CREDIT_CATEGORIES entry.
 *
 * @param {string[]} authors
 * @returns {Array<{ name: string, isFirst: boolean } & Record<string, string>>}
 */
export function initMatrix(authors) {
  return authors.map((name) => {
    /** @type {Record<string, string>} */
    const contributions = {};
    for (const cat of CREDIT_CATEGORIES) contributions[cat] = 'None';
    return { name, isFirst: false, ...contributions };
  });
}

/**
 * Format an author name for LaTeX output: "First Last" → "F. Last".
 * Appends "*" when `isFirst` is true.
 *
 * @param {string} name
 * @param {boolean} isFirst
 * @returns {string}
 */
export function formatAuthorForLatex(name, isFirst) {
  const parts = name.trim().split(/\s+/);
  const formatted =
    parts.length >= 2 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : name;
  return isFirst ? `${formatted}*` : formatted;
}

/**
 * Generate the LaTeX `\section*{Author contribution matrix}` block.
 *
 * @param {ReturnType<typeof initMatrix>} rows
 * @returns {string}
 */
export function generateLatex(rows) {
  const colLines = [
    '    % column labels',
    '    \\foreach \\a [count=\\n] in {',
    ...CREDIT_CATEGORIES.map((c) => `        ${c},`),
    '    } {',
    '        \\node[col header] at (\\n,0) {\\a};',
    '    }',
  ];

  const rowLines = [
    '    % row labels',
    '    \\foreach \\a [count=\\i] in {',
    ...rows.map((row) => `        ${formatAuthorForLatex(row.name, row.isFirst)},`),
    '    } {',
    '        \\node[row label] at (0,-\\i) {\\a};',
    '    }',
  ];

  const heatmapLines = [
    '    \\foreach \\y [count=\\n] in {',
    ...rows.map((row) => {
      const values = CREDIT_CATEGORIES.map((cat) => LATEX_LEVEL_VALUES[row[cat]] ?? 0);
      return `        {${values.join(',')}},`;
    }),
    '    } {',
    '        % heatmap tiles',
    '        \\foreach \\x [count=\\m] in \\y {',
    '            \\node[fill=tilecolor!\\x!white, tile, text=white] (tile) at (\\m,-\\n) {};',
    '        }',
    '    }',
  ];

  const parts = [
    '\\section*{Author contribution matrix}',
    '\\begin{tikzpicture}[scale=0.6]',
    '',
    colLines.join('\n'),
    '',
    rowLines.join('\n'),
    '',
    heatmapLines.join('\n'),
    '',
    '    % description below heatmap ',
    '    \\node [legend line] at (1, 0 |- tile.south) {* these authors contributed equally};',
    '',
    '\\end{tikzpicture}',
  ];

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Endpoint format conversion
// ---------------------------------------------------------------------------

/**
 * Convert internal matrix rows to the ProjectContributions JSON payload
 * expected by POST /contributions/post?project=<name>.
 *
 * @param {ReturnType<typeof initMatrix>} rows
 * @param {string} projectName
 * @returns {{ project_name: string, contributors: Array }}
 */
export function toEndpointPayload(rows, projectName) {
  const contributors = rows.map((row) => {
    const credit_levels = [];
    for (const displayRole of CREDIT_CATEGORIES) {
      const level = row[displayRole];
      if (level && level !== 'None') {
        credit_levels.push({
          role: CREDIT_ROLE_ENUM[displayRole],
          level: level.toLowerCase(), // 'lead' | 'equal' | 'supporting'
        });
      }
    }
    return { person: { name: row.name }, credit_levels };
  });
  return { project_name: projectName, contributors };
}

/**
 * Convert a ProjectContributions JSON response (from GET /contributions/get)
 * into internal matrix rows.
 *
 * @param {{ project_name: string, contributors: Array }} data
 * @returns {ReturnType<typeof initMatrix>}
 */
export function fromEndpointPayload(data) {
  return (data.contributors || []).map((contributor) => {
    const row = { name: contributor.person?.name ?? '', isFirst: false };
    for (const cat of CREDIT_CATEGORIES) row[cat] = 'None';
    for (const cl of contributor.credit_levels || []) {
      const displayRole = CREDIT_ROLE_ENUM_REVERSE[cl.role];
      if (displayRole) {
        // Capitalize first letter: 'lead' → 'Lead'
        row[displayRole] = cl.level.charAt(0).toUpperCase() + cl.level.slice(1);
      }
    }
    return row;
  });
}

/**
 * Convert internal matrix rows to the widget author format used by preview.js.
 *
 * @param {ReturnType<typeof initMatrix>} rows
 * @returns {Array<{name:string, credit_levels:Array<{role:string,level:string}>}>}
 */
export function rowsToWidgetAuthors(rows) {
  return rows.map((row) => {
    const credit_levels = [];
    for (const displayRole of CREDIT_CATEGORIES) {
      const level = row[displayRole];
      if (level && level !== 'None') {
        credit_levels.push({ role: displayRole, level: level.toLowerCase() });
      }
    }
    return { name: row.name, credit_levels };
  });
}

// ---------------------------------------------------------------------------
// DOM component
// ---------------------------------------------------------------------------

/**
 * Build and return the contributions page element.
 *
 * @param {object} [options]
 * @param {string}   [options.assetName=''] - Comma-separated asset names
 *   (pre-populated from URL param `?asset_name=...`).
 * @param {object}   [options.docdbOptions={}] - Options forwarded to fetchDocDbRecordsByName.
 * @returns {HTMLElement}
 */
export function createContributionsView(options = {}) {
  const { assetName = '', docdbOptions = {} } = options;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** @type {Array<ReturnType<typeof initMatrix>[number]>} */
  let rows = [];

  /** @type {Record<string, string[]>} */
  let authorSources = {};

  // -------------------------------------------------------------------------
  // Root element
  // -------------------------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'contributions-view';
  root.innerHTML = `
    <div class="contributions-header">
      <h2>Author Contribution Matrix</h2>
      <div class="contributions-asset-input">
        <label for="cv-asset-names">Asset names (comma-separated)</label>
        <input id="cv-asset-names" type="text" placeholder="e.g. my_project_2024-01-01" />
        <button id="cv-load-btn" class="btn-primary">Load assets</button>
      </div>
      <div id="cv-info" class="contributions-info" aria-live="polite"></div>
    </div>

    <div class="contributions-project-section">
      <div class="contributions-project-row">
        <label for="cv-project-name">Project name</label>
        <input id="cv-project-name" type="text" placeholder="e.g. my-project-2024" />
        <button id="cv-get-btn" class="btn-secondary">Load from server</button>
        <button id="cv-post-btn" class="btn-primary" disabled>Save to server</button>
      </div>
      <div id="cv-endpoint-status" class="contributions-endpoint-status" aria-live="polite"></div>
    </div>

    <div class="contributions-controls" style="display:none">
      <div class="contributions-author-controls">
        <fieldset>
          <legend>Add author</legend>
          <input id="cv-new-author" type="text" placeholder="Full name" />
          <button id="cv-add-author-btn" class="btn-primary">Add</button>
        </fieldset>
        <fieldset>
          <legend>Remove author</legend>
          <select id="cv-remove-author-select"></select>
          <button id="cv-remove-author-btn" class="btn-danger">Remove</button>
        </fieldset>
        <fieldset>
          <legend>Reorder</legend>
          <select id="cv-reorder-select" size="6"></select>
          <div>
            <button id="cv-move-up-btn">\u2191 Up</button>
            <button id="cv-move-down-btn">\u2193 Down</button>
          </div>
        </fieldset>
      </div>
    </div>

    <div id="cv-table-container" class="contributions-table-container"></div>

    <div id="cv-latex-section" class="contributions-latex-section" style="display:none">
      <button id="cv-generate-latex-btn" class="btn-primary">Generate LaTeX</button>
      <pre id="cv-latex-output" class="contributions-latex-output" style="display:none"></pre>
    </div>

    <div id="cv-preview-section" class="contributions-preview-section" style="display:none">
      <div class="ae-preview-wrap">
        <h3>Preview</h3>
        <div id="cv-preview-container"></div>
      </div>
    </div>
  `;

  // -------------------------------------------------------------------------
  // Element references
  // -------------------------------------------------------------------------

  const assetInput = root.querySelector('#cv-asset-names');
  const loadBtn = root.querySelector('#cv-load-btn');
  const infoEl = root.querySelector('#cv-info');
  const controlsEl = root.querySelector('.contributions-controls');
  const tableContainer = root.querySelector('#cv-table-container');
  const removeSelect = root.querySelector('#cv-remove-author-select');
  const reorderSelect = root.querySelector('#cv-reorder-select');
  const newAuthorInput = root.querySelector('#cv-new-author');
  const latexSection = root.querySelector('#cv-latex-section');
  const latexOutput = root.querySelector('#cv-latex-output');
  const projectNameInput = root.querySelector('#cv-project-name');
  const getBtn = root.querySelector('#cv-get-btn');
  const postBtn = root.querySelector('#cv-post-btn');
  const endpointStatus = root.querySelector('#cv-endpoint-status');
  const previewSection = root.querySelector('#cv-preview-section');
  const previewContainer = root.querySelector('#cv-preview-container');

  if (assetName) assetInput.value = assetName;

  // -------------------------------------------------------------------------
  // Re-render helpers
  // -------------------------------------------------------------------------

  function renderTable() {
    tableContainer.innerHTML = '';
    if (rows.length === 0) return;

    const table = document.createElement('table');
    table.className = 'contributions-matrix';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const thAuthor = document.createElement('th');
    thAuthor.textContent = 'Author';
    headerRow.appendChild(thAuthor);
    const thFirst = document.createElement('th');
    thFirst.textContent = 'First\u00a0Author';
    headerRow.appendChild(thFirst);
    for (const cat of CREDIT_CATEGORIES) {
      const th = document.createElement('th');
      th.textContent = cat;
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    rows.forEach((row, rowIdx) => {
      const tr = document.createElement('tr');

      // Author name
      const tdName = document.createElement('td');
      tdName.textContent = row.name;
      if (authorSources[row.name]?.length) {
        tdName.title = `Sources: ${authorSources[row.name].join(', ')}`;
      }
      tr.appendChild(tdName);

      // First author checkbox
      const tdFirst = document.createElement('td');
      tdFirst.className = 'cell-center';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = row.isFirst;
      chk.setAttribute('aria-label', `${row.name} first author`);
      chk.addEventListener('change', () => {
        rows[rowIdx].isFirst = chk.checked;
        updatePreview();
      });
      tdFirst.appendChild(chk);
      tr.appendChild(tdFirst);

      // Contribution level selects
      for (const cat of CREDIT_CATEGORIES) {
        const td = document.createElement('td');
        td.className = `cell-center cell-${(row[cat] || 'none').toLowerCase()}`;
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `${row.name} \u2014 ${cat}`);
        for (const level of CONTRIBUTION_LEVELS) {
          const opt = document.createElement('option');
          opt.value = level;
          opt.textContent = level;
          if (level === row[cat]) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
          rows[rowIdx][cat] = sel.value;
          td.className = `cell-center cell-${sel.value.toLowerCase()}`;
          updatePreview();
        });
        td.appendChild(sel);
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    tableContainer.appendChild(table);
  }

  function syncAuthorLists() {
    const names = rows.map((r) => r.name);

    removeSelect.innerHTML = '';
    reorderSelect.innerHTML = '';
    for (const name of names) {
      const opt1 = document.createElement('option');
      opt1.value = name;
      opt1.textContent = name;
      removeSelect.appendChild(opt1);

      const opt2 = document.createElement('option');
      opt2.value = name;
      opt2.textContent = name;
      reorderSelect.appendChild(opt2);
    }
  }

  function updatePreview() {
    const authors = rowsToWidgetAuthors(rows);
    createPreview(previewContainer, authors);
  }

  function setRows(newRows) {
    rows = newRows;
    renderTable();
    syncAuthorLists();
    const hasRows = rows.length > 0;
    controlsEl.style.display = hasRows ? '' : 'none';
    latexSection.style.display = hasRows ? '' : 'none';
    latexOutput.style.display = 'none';
    previewSection.style.display = hasRows ? '' : 'none';
    postBtn.disabled = !hasRows;
    updatePreview();
  }

  // -------------------------------------------------------------------------
  // Load records from DocDB
  // -------------------------------------------------------------------------

  async function loadRecords() {
    const names = parseAssetNames(assetInput.value);
    if (names.length === 0) {
      infoEl.textContent = 'Enter at least one asset name.';
      return;
    }

    loadBtn.disabled = true;
    infoEl.textContent = `Loading ${names.length} asset(s)\u2026`;

    try {
      const records = await fetchDocDbRecordsByName(names, docdbOptions);
      const { authors, authorSources: sources } = extractAuthors(records);
      authorSources = sources;

      infoEl.innerHTML =
        `<strong>${records.length} record(s)</strong> loaded for ${names.length} asset(s). ` +
        `<strong>${authors.length} author(s)</strong> found.` +
        (authors.length
          ? '<ul>' +
            authors
              .map(
                (a) =>
                  `<li><strong>${a}</strong>: ${(sources[a] || []).join(', ')}</li>`,
              )
              .join('') +
            '</ul>'
          : '');

      setRows(initMatrix(authors));
    } catch (err) {
      infoEl.textContent = `Error: ${err.message}`;
      console.error('[contributions-view] load failed', err);
    } finally {
      loadBtn.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Endpoint GET / POST
  // -------------------------------------------------------------------------

  async function loadFromServer() {
    const project = projectNameInput.value.trim();
    if (!project) {
      endpointStatus.textContent = 'Enter a project name first.';
      endpointStatus.className = 'contributions-endpoint-status status-error';
      return;
    }

    getBtn.disabled = true;
    endpointStatus.textContent = `Fetching \u201c${project}\u201d from server\u2026`;
    endpointStatus.className = 'contributions-endpoint-status status-loading';

    try {
      const url = `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(project)}`;
      const res = await fetch(url);
      if (res.status === 404) throw new Error(`Project \u201c${project}\u201d not found on server.`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      const loadedRows = fromEndpointPayload(data);
      authorSources = {};
      setRows(loadedRows);
      endpointStatus.textContent = `\u2713 Loaded \u201c${project}\u201d \u2014 ${loadedRows.length} contributor(s).`;
      endpointStatus.className = 'contributions-endpoint-status status-success';
    } catch (err) {
      endpointStatus.textContent = `Error: ${err.message}`;
      endpointStatus.className = 'contributions-endpoint-status status-error';
      console.error('[contributions-view] GET failed', err);
    } finally {
      getBtn.disabled = false;
    }
  }

  async function saveToServer() {
    const project = projectNameInput.value.trim();
    if (!project) {
      endpointStatus.textContent = 'Enter a project name to save under.';
      endpointStatus.className = 'contributions-endpoint-status status-error';
      return;
    }
    if (rows.length === 0) return;

    postBtn.disabled = true;
    endpointStatus.textContent = `Saving \u201c${project}\u201d\u2026`;
    endpointStatus.className = 'contributions-endpoint-status status-loading';

    try {
      const payload = toEndpointPayload(rows, project);
      const url = `${CONTRIBUTIONS_API_BASE}/contributions/post?project=${encodeURIComponent(project)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }
      const result = await res.json();
      const commit = result.commit ? ` (commit: ${result.commit.slice(0, 8)})` : '';
      endpointStatus.textContent = `\u2713 Saved \u201c${project}\u201d${commit}`;
      endpointStatus.className = 'contributions-endpoint-status status-success';
    } catch (err) {
      endpointStatus.textContent = `Error: ${err.message}`;
      endpointStatus.className = 'contributions-endpoint-status status-error';
      console.error('[contributions-view] POST failed', err);
    } finally {
      postBtn.disabled = rows.length === 0;
    }
  }

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  loadBtn.addEventListener('click', loadRecords);
  assetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadRecords();
  });

  getBtn.addEventListener('click', loadFromServer);
  postBtn.addEventListener('click', saveToServer);
  projectNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadFromServer();
  });

  // Add author
  root.querySelector('#cv-add-author-btn').addEventListener('click', () => {
    const name = newAuthorInput.value.trim();
    if (!name || rows.some((r) => r.name === name)) return;
    const newRow = { name, isFirst: false };
    for (const cat of CREDIT_CATEGORIES) newRow[cat] = 'None';
    setRows([...rows, newRow]);
    newAuthorInput.value = '';
  });

  // Remove author
  root.querySelector('#cv-remove-author-btn').addEventListener('click', () => {
    const name = removeSelect.value;
    if (!name) return;
    setRows(rows.filter((r) => r.name !== name));
  });

  // Move up
  root.querySelector('#cv-move-up-btn').addEventListener('click', () => {
    const name = reorderSelect.value;
    if (!name) return;
    const idx = rows.findIndex((r) => r.name === name);
    if (idx <= 0) return;
    const next = [...rows];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    setRows(next);
    root.querySelector(`#cv-reorder-select option[value="${CSS.escape(name)}"]`).selected = true;
  });

  // Move down
  root.querySelector('#cv-move-down-btn').addEventListener('click', () => {
    const name = reorderSelect.value;
    if (!name) return;
    const idx = rows.findIndex((r) => r.name === name);
    if (idx < 0 || idx >= rows.length - 1) return;
    const next = [...rows];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    setRows(next);
    root.querySelector(`#cv-reorder-select option[value="${CSS.escape(name)}"]`).selected = true;
  });

  // Generate LaTeX
  root.querySelector('#cv-generate-latex-btn').addEventListener('click', () => {
    if (rows.length === 0) return;
    const latex = generateLatex(rows);
    latexOutput.textContent = latex;
    latexOutput.style.display = '';
  });

  // -------------------------------------------------------------------------
  // Auto-load when asset_name is provided via URL
  // -------------------------------------------------------------------------

  if (assetName) {
    Promise.resolve().then(loadRecords);
  }

  return root;
}

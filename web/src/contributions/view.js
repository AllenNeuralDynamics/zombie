/**
 * contributions-view.js — CReDIT Author Contribution Matrix page.
 *
 * Ported from src/zombie/contributions.py.
 *
 * Pure helpers (parseAssetNames, extractAuthors, initMatrix, formatAuthorForLatex,
 * generateLatex) are exported for unit testing.
 *
 * createContributionsView(options) builds and returns a DOM element.
 */

import { fetchDocDbRecordsByName } from '../lib/docdb.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** CReDIT taxonomy categories (order preserved from the Python source). */
export const CREDIT_CATEGORIES = [
  'Conceptualization',
  'Formal analysis',
  'Investigation',
  'Methodology',
  'Resources',
  'Software',
  'Writing---Original Draft',
  'Writing---Reviewing and Editing',
  'Funding acquisition',
];

/** Allowed contribution levels. */
export const CONTRIBUTION_LEVELS = ['None', 'Low', 'High'];

/**
 * LaTeX macro values for each contribution level.
 * Used to fill TikZ heatmap tiles.
 */
const LATEX_LEVEL_VALUES = { None: 0, Low: '\\lo', High: '\\hi' };

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
        <button id="cv-load-btn" class="btn-primary">Load</button>
      </div>
      <div id="cv-info" class="contributions-info" aria-live="polite"></div>
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
            <button id="cv-move-up-btn">↑ Up</button>
            <button id="cv-move-down-btn">↓ Down</button>
          </div>
        </fieldset>
      </div>
    </div>

    <div id="cv-table-container" class="contributions-table-container"></div>

    <div id="cv-latex-section" class="contributions-latex-section" style="display:none">
      <button id="cv-generate-latex-btn" class="btn-primary">Generate LaTeX</button>
      <pre id="cv-latex-output" class="contributions-latex-output" style="display:none"></pre>
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

  // Pre-populate from options
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
      });
      tdFirst.appendChild(chk);
      tr.appendChild(tdFirst);

      // Contribution level selects
      for (const cat of CREDIT_CATEGORIES) {
        const td = document.createElement('td');
        td.className = `cell-center cell-${(row[cat] || 'none').toLowerCase()}`;
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `${row.name} — ${cat}`);
        for (const level of CONTRIBUTION_LEVELS) {
          const opt = document.createElement('option');
          opt.value = level;
          opt.textContent = level;
          if (level === row[cat]) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
          rows[rowIdx][cat] = sel.value;
          // Update cell colour class
          td.className = `cell-center cell-${sel.value.toLowerCase()}`;
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

  function setRows(newRows) {
    rows = newRows;
    renderTable();
    syncAuthorLists();
    const hasRows = rows.length > 0;
    controlsEl.style.display = hasRows ? '' : 'none';
    latexSection.style.display = hasRows ? '' : 'none';
    latexOutput.style.display = 'none';
  }

  // -------------------------------------------------------------------------
  // Load records
  // -------------------------------------------------------------------------

  async function loadRecords() {
    const names = parseAssetNames(assetInput.value);
    if (names.length === 0) {
      infoEl.textContent = 'Enter at least one asset name.';
      return;
    }

    loadBtn.disabled = true;
    infoEl.textContent = `Loading ${names.length} asset(s)…`;

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
  // Event listeners
  // -------------------------------------------------------------------------

  loadBtn.addEventListener('click', loadRecords);
  assetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadRecords();
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
    // Re-select
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
    // Kick off load after the element is returned to the caller.
    Promise.resolve().then(loadRecords);
  }

  return root;
}

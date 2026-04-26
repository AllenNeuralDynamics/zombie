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
 * @param {{ authorOrcids?: Record<string,string>, authorAffIds?: Record<string,string[]>, affiliations?: Array<{id:string,name:string}> }} [meta]
 * @returns {{ project_name: string, contributors: Array }}
 */
export function toEndpointPayload(rows, projectName, meta = {}) {
  const { authorOrcids = {}, authorAffIds = {}, affiliations = [], sections = [], authorSectionIds = {}, assets = [] } = meta;
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
    const author = { name: row.name };
    const orcid = authorOrcids[row.name];
    if (orcid) author.registry_identifier = orcid;
    const affIds = authorAffIds[row.name] || [];
    const affName = affIds.map(id => affiliations.find(a => a.id === id)?.name).filter(Boolean)[0];
    if (affName) author.affiliation = affName;
    const sectionIds = authorSectionIds[row.name] || [];
    const sectionContribs = sectionIds.map(id => sections.find(s => s.id === id)?.title).filter(Boolean);
    return { author, credit_levels, ...(sectionContribs.length ? { section_contributions: sectionContribs } : {}) };
  });
  const topSections = sections.map(s => s.title).filter(Boolean);
  const topAssets = assets.filter(Boolean);
  return {
    project_name: projectName,
    ...(topAssets.length ? { assets: topAssets } : {}),
    ...(topSections.length ? { sections: topSections } : {}),
    contributors,
  };
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
    const row = { name: contributor.author?.name ?? '', isFirst: false };
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
 * @param {string}   [options.assetName=''] - Comma-separated asset names.
 * @param {string}   [options.projectName=''] - Project name.
 * @param {object}   [options.docdbOptions={}] - Options forwarded to fetchDocDbRecordsByName.
 * @returns {HTMLElement}
 */
export function createContributionsView(options = {}) {
  const { assetName = '', projectName = '', docdbOptions = {} } = options;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** @type {Array<ReturnType<typeof initMatrix>[number]>} */
  let rows = [];

  /** @type {Record<string, string[]>} */
  let authorSources = {};

  /** @type {Record<string, string>} orcid keyed by author name */
  let authorOrcids = {};

  /** @type {Record<string, string[]>} affiliation IDs keyed by author name */
  let authorAffIds = {};

  /** @type {Array<{id: string, name: string}>} */
  let affiliations = [
    { id: 'aind', name: 'Allen Institute for Neural Dynamics, Seattle, WA' },
  ];

  /** @type {Array<{id: string, title: string}>} Paper section headers. */
  let sections = [];

  /** @type {Record<string, string[]>} Section IDs each author contributed to. */
  let authorSectionIds = {};

  /** @type {string[]} Asset names that were loaded */
  let loadedAssetNames = [];

  /** @type {'preview'|'latex'} */
  let activeOutputTab = 'preview';

  /** @type {'asset-names'|'query'} */
  let activeAssetsTab = 'asset-names';

  let assetsOpen = true;

  /** @type {HTMLElement|null} Currently-selected history bubble. */
  let selectedHistoryBubble = null;

  // -------------------------------------------------------------------------
  // Root element
  // -------------------------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'contributions-view';
  root.innerHTML = `
    <!-- ── Assets section ───────────────────────────────────────────── -->
    <section class="cv-section cv-assets-section">
      <button class="cv-section-toggle" id="cv-assets-toggle" aria-expanded="true">
        <span class="cv-section-title">Assets</span>
        <span class="cv-toggle-icon">▲</span>
      </button>
      <div class="cv-section-body" id="cv-assets-body">
        <div class="cv-tabs" role="tablist">
          <button class="cv-tab cv-tab-active" id="cv-tab-asset-names" role="tab" aria-selected="true">Asset Names</button>
          <button class="cv-tab" id="cv-tab-query" role="tab" aria-selected="false">Query</button>
        </div>
        <div id="cv-panel-asset-names" class="cv-tab-panel">
          <div class="cv-asset-input-row">
            <input id="cv-asset-names" type="text" placeholder="e.g. my_project_2024-01-01, another_asset" />
            <button id="cv-load-btn" class="btn-primary">Load assets</button>
          </div>
        </div>
        <div id="cv-panel-query" class="cv-tab-panel" style="display:none">
          <p class="cv-placeholder">Query interface coming soon.</p>
        </div>
        <div id="cv-info" class="cv-info" aria-live="polite"></div>
      </div>
    </section>

    <!-- ── Project / server sync ────────────────────────────────────── -->
    <section class="cv-section cv-project-section">
      <div class="cv-project-row">
        <label for="cv-project-name">Project name</label>
        <input id="cv-project-name" type="text" placeholder="e.g. my-project-2024" />
        <button id="cv-get-btn" class="btn-secondary">Load from server</button>
        <button id="cv-post-btn" class="btn-primary" disabled>Save to server</button>
      </div>
      <div id="cv-endpoint-status" class="contributions-endpoint-status" aria-live="polite"></div>
      <div id="cv-assets-table-wrap" style="display:none">
        <table class="cv-assets-table">
          <thead><tr><th>Associated assets</th></tr></thead>
          <tbody id="cv-assets-tbody"></tbody>
        </table>
      </div>
    </section>

    <!-- ── Version history timeline ────────────────────────────────── -->
    <section class="cv-section cv-history-section" id="cv-history-section" style="display:none">
      <div class="cv-history-header">
        <span class="cv-section-title">Version History</span>
        <span class="cv-history-hint" id="cv-history-hint"></span>
      </div>
      <div class="subject-timeline-bubbles" id="cv-history-bubbles"></div>
    </section>

    <!-- ── Contributors section ─────────────────────────────────────── -->
    <section class="cv-section cv-contributors-section" id="cv-contributors-section" style="display:none">
      <h3 class="cv-section-heading">Contributors</h3>

      <div class="cv-authors-table-wrap">
        <div class="cv-table-scroll">
          <table class="cv-authors-table" id="cv-authors-table">
            <thead>
              <tr id="cv-authors-thead-row"></tr>
            </thead>
            <tbody id="cv-authors-tbody"></tbody>
          </table>
        </div>
        <button id="cv-add-author-btn" class="btn-secondary cv-add-row-btn">+ Add author</button>
      </div>

      <div class="cv-affiliations-section">
        <h4 class="cv-subsection-heading">Affiliations</h4>
        <table class="cv-affiliations-table" id="cv-affiliations-table">
          <thead><tr><th></th><th>Affiliation</th></tr></thead>
          <tbody id="cv-affiliations-tbody"></tbody>
        </table>
        <button id="cv-add-affiliation-btn" class="btn-secondary cv-add-row-btn">+ Add affiliation</button>
      </div>

      <div class="cv-sections-section">
        <h4 class="cv-subsection-heading">Paper Sections</h4>
        <table class="cv-sections-table" id="cv-sections-table">
          <thead><tr><th></th><th>Title</th></tr></thead>
          <tbody id="cv-sections-tbody"></tbody>
        </table>
        <button id="cv-add-section-btn" class="btn-secondary cv-add-row-btn">+ Add section</button>
      </div>
    </section>

    <!-- ── Preview / LaTeX output tabs ──────────────────────────────── -->
    <section class="cv-section cv-output-section" id="cv-output-section" style="display:none">
      <div class="cv-tabs" role="tablist">
        <button class="cv-tab cv-tab-active" id="cv-out-tab-preview" role="tab" aria-selected="true">Preview</button>
        <button class="cv-tab" id="cv-out-tab-latex" role="tab" aria-selected="false">Generate LaTeX</button>
      </div>
      <div id="cv-out-panel-preview" class="cv-tab-panel">
        <div id="cv-preview-container"></div>
      </div>
      <div id="cv-out-panel-latex" class="cv-tab-panel" style="display:none">
        <pre id="cv-latex-output" class="contributions-latex-output"></pre>
      </div>
    </section>
  `;

  // -------------------------------------------------------------------------
  // Element references
  // -------------------------------------------------------------------------

  const assetInput        = root.querySelector('#cv-asset-names');
  const loadBtn           = root.querySelector('#cv-load-btn');
  const infoEl            = root.querySelector('#cv-info');
  const assetsToggle      = root.querySelector('#cv-assets-toggle');
  const assetsBody        = root.querySelector('#cv-assets-body');
  const assetsTableWrap   = root.querySelector('#cv-assets-table-wrap');
  const assetsTbody       = root.querySelector('#cv-assets-tbody');
  const authorsTbody      = root.querySelector('#cv-authors-tbody');
  const authorsTheadRow   = root.querySelector('#cv-authors-thead-row');
  const contributorsSection = root.querySelector('#cv-contributors-section');
  const outputSection     = root.querySelector('#cv-output-section');
  const previewContainer  = root.querySelector('#cv-preview-container');
  const latexOutput       = root.querySelector('#cv-latex-output');
  const projectNameInput  = root.querySelector('#cv-project-name');
  const getBtn            = root.querySelector('#cv-get-btn');
  const postBtn           = root.querySelector('#cv-post-btn');
  const endpointStatus    = root.querySelector('#cv-endpoint-status');
  const affiliationsTbody = root.querySelector('#cv-affiliations-tbody');
  const sectionsTbody     = root.querySelector('#cv-sections-tbody');
  const historySection    = root.querySelector('#cv-history-section');
  const historyBubbles    = root.querySelector('#cv-history-bubbles');
  const historyHint       = root.querySelector('#cv-history-hint');

  if (assetName)    assetInput.value    = assetName;
  if (projectName)  projectNameInput.value = projectName;

  // -------------------------------------------------------------------------
  // URL sync & draft persistence
  // -------------------------------------------------------------------------

  const DRAFT_KEY = 'contributions:draft';

  function syncUrl() {
    const params = new URLSearchParams(window.location.search);
    const names = assetInput.value.trim();
    if (names) params.set('asset_name', names); else params.delete('asset_name');
    const project = projectNameInput.value.trim();
    if (project) params.set('project', project); else params.delete('project');
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }

  function saveDraft() {
    if (rows.length === 0) { sessionStorage.removeItem(DRAFT_KEY); return; }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        assetNames: assetInput.value.trim(),
        projectName: projectNameInput.value.trim(),
        rows, authorSources, authorOrcids, authorAffIds, affiliations, loadedAssetNames,
        sections, authorSectionIds,
      }));
    } catch (_) {}
  }

  // -------------------------------------------------------------------------
  // Assets tab panel
  // -------------------------------------------------------------------------

  function renderAssetsTable() {
    assetsTbody.innerHTML = '';
    for (const name of loadedAssetNames) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.textContent = name;
      tr.appendChild(td);
      assetsTbody.appendChild(tr);
    }
    assetsTableWrap.style.display = loadedAssetNames.length ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  // Affiliations table
  // -------------------------------------------------------------------------

  function renderAffiliationsTable() {
    affiliationsTbody.innerHTML = '';
    affiliations.forEach((aff, idx) => {
      const tr = document.createElement('tr');

      const tdX = document.createElement('td');
      const xBtn = document.createElement('button');
      xBtn.className = 'cv-x-btn';
      xBtn.textContent = '×';
      xBtn.setAttribute('aria-label', `Remove affiliation ${aff.name}`);
      xBtn.addEventListener('click', () => {
        affiliations = affiliations.filter((_, i) => i !== idx);
        // Drop this aff from all author selections
        for (const name of Object.keys(authorAffIds)) {
          authorAffIds[name] = (authorAffIds[name] || []).filter(id => id !== aff.id);
        }
        renderAffiliationsTable();
        renderAuthorsTable();
        updatePreview();
        saveDraft();
      });
      tdX.appendChild(xBtn);
      tr.appendChild(tdX);

      const tdName = document.createElement('td');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = aff.name;
      nameInput.className = 'cv-aff-name-input';
      nameInput.addEventListener('change', () => {
        affiliations[idx].name = nameInput.value;
        renderAuthorsTable();
        updatePreview();
        saveDraft();
      });
      tdName.appendChild(nameInput);
      tr.appendChild(tdName);

      affiliationsTbody.appendChild(tr);
    });
  }

  function renderSectionsTable() {
    sectionsTbody.innerHTML = '';
    sections.forEach((sec, idx) => {
      const tr = document.createElement('tr');

      const tdX = document.createElement('td');
      const xBtn = document.createElement('button');
      xBtn.className = 'cv-x-btn';
      xBtn.textContent = '×';
      xBtn.setAttribute('aria-label', `Remove section ${sec.title}`);
      xBtn.addEventListener('click', () => {
        sections = sections.filter((_, i) => i !== idx);
        for (const name of Object.keys(authorSectionIds)) {
          authorSectionIds[name] = (authorSectionIds[name] || []).filter(id => id !== sec.id);
        }
        renderSectionsTable();
        renderAuthorsTable();
        updatePreview();
        saveDraft();
      });
      tdX.appendChild(xBtn);
      tr.appendChild(tdX);

      const tdTitle = document.createElement('td');
      const titleInput = document.createElement('input');
      titleInput.type = 'text';
      titleInput.value = sec.title;
      titleInput.className = 'cv-sec-title-input';
      titleInput.placeholder = 'e.g. Introduction';
      titleInput.addEventListener('change', () => {
        sections[idx].title = titleInput.value;
        renderAuthorsTable();
        updatePreview();
        saveDraft();
      });
      tdTitle.appendChild(titleInput);
      tr.appendChild(tdTitle);

      sectionsTbody.appendChild(tr);
    });
  }

  // -------------------------------------------------------------------------
  // Chip-select helper
  // -------------------------------------------------------------------------

  /**
   * Build a chip-select widget: selected items shown as removable bubbles,
   * a "+" button opens a dropdown of remaining options.
   *
   * @param {Array<{id:string,name:string}>} options - All available options
   * @param {string[]} selectedIds - Currently selected IDs
   * @param {(ids:string[]) => void} onChange
   * @param {string} ariaLabel
   */
  function buildChipSelect(options, selectedIds, onChange, ariaLabel) {
    const wrap = document.createElement('div');
    wrap.className = 'cv-chip-select';
    wrap.setAttribute('aria-label', ariaLabel);

    function abbrevAff(name) {
      const beforeComma = name.split(',')[0];
      return beforeComma.split(/\s+/).map(w => w[0]?.toUpperCase() ?? '').join('');
    }

    function render(currentIds) {
      wrap.innerHTML = '';

      // Chips for selected items
      for (const id of currentIds) {
        const aff = options.find(o => o.id === id);
        if (!aff) continue;
        const chip = document.createElement('span');
        chip.className = 'cv-chip';
        chip.textContent = abbrevAff(aff.name);
        chip.title = aff.name;
        const x = document.createElement('button');
        x.className = 'cv-chip-remove';
        x.textContent = '×';
        x.setAttribute('aria-label', `Remove ${aff.name}`);
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = currentIds.filter(i => i !== id);
          onChange(next);
          render(next);
          updatePreview();
        });
        chip.appendChild(x);
        wrap.appendChild(chip);
      }

      // "+" add button — only if there are unselected options
      const remaining = options.filter(o => !currentIds.includes(o.id));
      if (remaining.length === 0) return;

      const addBtn = document.createElement('button');
      addBtn.className = 'cv-chip-add';
      addBtn.textContent = '+';
      addBtn.setAttribute('aria-label', 'Add affiliation');

      let dropdownOpen = false;
      let dropdown = null;

      function closeDropdown() {
        if (dropdown) { dropdown.remove(); dropdown = null; }
        dropdownOpen = false;
      }

      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (dropdownOpen) { closeDropdown(); return; }
        dropdownOpen = true;
        dropdown = document.createElement('div');
        dropdown.className = 'cv-chip-dropdown';
        for (const opt of remaining) {
          const item = document.createElement('button');
          item.className = 'cv-chip-dropdown-item';
          item.textContent = opt.name;
          item.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            const next = [...currentIds, opt.id];
            onChange(next);
            closeDropdown();
            render(next);
            updatePreview();
          });
          dropdown.appendChild(item);
        }
        wrap.appendChild(dropdown);
        // Close if clicking outside
        setTimeout(() => {
          document.addEventListener('click', closeDropdown, { once: true });
        }, 0);
      });

      wrap.appendChild(addBtn);
    }

    render(selectedIds);
    return wrap;
  }

  // -------------------------------------------------------------------------
  // Authors table
  // -------------------------------------------------------------------------

  function buildAuthorsTableHeader() {
    authorsTheadRow.innerHTML = '';
    const cols = ['', 'Name', 'ORCID', 'Affiliations', 'Sections', ...CREDIT_CATEGORIES];
    for (const col of cols) {
      const th = document.createElement('th');
      th.textContent = col;
      authorsTheadRow.appendChild(th);
    }
  }

  function renderAuthorsTable() {
    authorsTbody.innerHTML = '';
    rows.forEach((row, rowIdx) => {
      const tr = document.createElement('tr');

      // X — remove
      const tdX = document.createElement('td');
      const xBtn = document.createElement('button');
      xBtn.className = 'cv-x-btn';
      xBtn.textContent = '×';
      xBtn.setAttribute('aria-label', `Remove ${row.name}`);
      xBtn.addEventListener('click', () => {
        setRows(rows.filter((_, i) => i !== rowIdx));
      });
      tdX.appendChild(xBtn);
      tr.appendChild(tdX);

      // Name
      const tdName = document.createElement('td');
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = row.name;
      nameInput.className = 'cv-author-name-input';
      nameInput.addEventListener('change', () => {
        const oldName = rows[rowIdx].name;
        const newName = nameInput.value.trim();
        if (!newName || newName === oldName) return;
        rows[rowIdx].name = newName;
        // Migrate metadata maps
        if (authorOrcids[oldName]) { authorOrcids[newName] = authorOrcids[oldName]; delete authorOrcids[oldName]; }
        if (authorAffIds[oldName]) { authorAffIds[newName] = authorAffIds[oldName]; delete authorAffIds[oldName]; }
        if (authorSectionIds[oldName]) { authorSectionIds[newName] = authorSectionIds[oldName]; delete authorSectionIds[oldName]; }
        if (authorSources[oldName]) { authorSources[newName] = authorSources[oldName]; delete authorSources[oldName]; }
        updatePreview(); saveDraft();
      });
      tdName.appendChild(nameInput);
      tr.appendChild(tdName);

      // ORCID
      const tdOrcid = document.createElement('td');
      const orcidInput = document.createElement('input');
      orcidInput.type = 'text';
      orcidInput.value = authorOrcids[row.name] || '';
      orcidInput.className = 'cv-orcid-input';
      orcidInput.placeholder = '0000-0000-0000-0000';
      orcidInput.addEventListener('change', () => {
        authorOrcids[row.name] = orcidInput.value.trim();
        saveDraft();
      });
      tdOrcid.appendChild(orcidInput);
      tr.appendChild(tdOrcid);

      // Affiliations chip-select
      const tdAff = document.createElement('td');
      tdAff.appendChild(buildChipSelect(
        affiliations,
        authorAffIds[row.name] || [],
        (selectedIds) => { authorAffIds[row.name] = selectedIds; saveDraft(); },
        `${row.name} affiliations`,
      ));
      tr.appendChild(tdAff);

      // Sections chip-select
      const tdSec = document.createElement('td');
      tdSec.appendChild(buildChipSelect(
        sections.map(s => ({ id: s.id, name: s.title })),
        authorSectionIds[row.name] || [],
        (selectedIds) => { authorSectionIds[row.name] = selectedIds; updatePreview(); saveDraft(); },
        `${row.name} sections`,
      ));
      tr.appendChild(tdSec);

      // Credit category selects
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
          td.className = `cell-center cell-${sel.value.toLowerCase()}`;
          updatePreview(); saveDraft();
        });
        td.appendChild(sel);
        tr.appendChild(td);
      }

      authorsTbody.appendChild(tr);
    });
  }

  // -------------------------------------------------------------------------
  // Preview / LaTeX output
  // -------------------------------------------------------------------------

  function updatePreview() {
    const authors = rowsToWidgetAuthors(rows).map(a => {
      const affIds = authorAffIds[a.name] || [];
      const affNames = affIds
        .map(id => affiliations.find(af => af.id === id)?.name)
        .filter(Boolean);
      const secIds = authorSectionIds[a.name] || [];
      const sectionContribs = secIds
        .map(id => sections.find(s => s.id === id))
        .filter(Boolean)
        .map(s => ({ section: s.title }));
      return {
        ...a,
        orcid: authorOrcids[a.name] || undefined,
        affiliations: affNames.length ? affNames : undefined,
        section_contributions: sectionContribs.length ? sectionContribs : undefined,
      };
    });
    createPreview(previewContainer, authors);
  }

  function switchOutputTab(tab) {
    activeOutputTab = tab;
    root.querySelector('#cv-out-tab-preview').classList.toggle('cv-tab-active', tab === 'preview');
    root.querySelector('#cv-out-tab-latex').classList.toggle('cv-tab-active', tab === 'latex');
    root.querySelector('#cv-out-tab-preview').setAttribute('aria-selected', String(tab === 'preview'));
    root.querySelector('#cv-out-tab-latex').setAttribute('aria-selected', String(tab === 'latex'));
    root.querySelector('#cv-out-panel-preview').style.display = tab === 'preview' ? '' : 'none';
    root.querySelector('#cv-out-panel-latex').style.display  = tab === 'latex'   ? '' : 'none';
    if (tab === 'latex' && rows.length > 0) {
      latexOutput.textContent = generateLatex(rows);
    }
  }

  // -------------------------------------------------------------------------
  // Visibility helpers
  // -------------------------------------------------------------------------

  function setRows(newRows) {
    rows = newRows;
    buildAuthorsTableHeader();
    renderAuthorsTable();
    const hasRows = rows.length > 0;
    contributorsSection.style.display = hasRows ? '' : 'none';
    outputSection.style.display       = hasRows ? '' : 'none';
    updateProjectButtons();
    if (hasRows) {
      updatePreview();
      if (activeOutputTab === 'latex') latexOutput.textContent = generateLatex(rows);
    }
    saveDraft();
  }

  // -------------------------------------------------------------------------
  // Assets tab switching
  // -------------------------------------------------------------------------

  function switchAssetsTab(tab) {
    activeAssetsTab = tab;
    root.querySelector('#cv-tab-asset-names').classList.toggle('cv-tab-active', tab === 'asset-names');
    root.querySelector('#cv-tab-query').classList.toggle('cv-tab-active', tab === 'query');
    root.querySelector('#cv-tab-asset-names').setAttribute('aria-selected', String(tab === 'asset-names'));
    root.querySelector('#cv-tab-query').setAttribute('aria-selected', String(tab === 'query'));
    root.querySelector('#cv-panel-asset-names').style.display = tab === 'asset-names' ? '' : 'none';
    root.querySelector('#cv-panel-query').style.display       = tab === 'query'       ? '' : 'none';
  }

  // -------------------------------------------------------------------------
  // Load records from DocDB
  // -------------------------------------------------------------------------

  async function loadRecords() {
    const names = parseAssetNames(assetInput.value);
    if (names.length === 0) { infoEl.textContent = 'Enter at least one asset name.'; return; }

    loadBtn.disabled = true;
    loadedAssetNames = names;
    renderAssetsTable();
    projectNameInput.value = '';
    syncUrl();
    updateProjectButtons();
    infoEl.textContent = `Loading ${names.length} asset(s)\u2026`;

    try {
      const records = await fetchDocDbRecordsByName(names, docdbOptions);
      const { authors, authorSources: sources, authorOrcids: orcids } = extractAuthorsWithOrcids(records);
      authorSources = sources;
      authorOrcids = { ...orcids };

      infoEl.textContent = `${records.length} record(s) loaded — ${authors.length} author(s) found.`;

      setRows(initMatrix(authors));
      syncUrl();
    } catch (err) {
      infoEl.textContent = `Error: ${err.message}`;
      console.error('[contributions-view] load failed', err);
    } finally {
      loadBtn.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // Version history timeline
  // -------------------------------------------------------------------------

  function renderHistoryTimeline(commits) {
    historyBubbles.innerHTML = '';
    selectedHistoryBubble = null;
    if (!commits.length) { historySection.style.display = 'none'; return; }
    historySection.style.display = '';
    historyHint.textContent = `${commits.length} version${commits.length !== 1 ? 's' : ''}`;

    for (let i = 0; i < commits.length; i++) {
      const entry = commits[i];
      const hash = entry.commit ?? entry.sha ?? entry.hash ?? '';
      const rawDate = entry.date ?? entry.committed_date ?? entry.timestamp ?? entry.authored_date ?? '';
      const date = rawDate ? new Date(rawDate) : null;

      const bubble = document.createElement('button');
      bubble.className = 'tl-bubble';
      bubble.style.setProperty('--bubble-color', '#4338ca');
      bubble.dataset.commit = hash;

      const dot = document.createElement('span');
      dot.className = 'tl-bubble-dot';

      const hashEl = document.createElement('span');
      hashEl.className = 'tl-bubble-type';
      hashEl.textContent = hash ? hash.slice(0, 8) : `v${i + 1}`;

      const dateEl = document.createElement('span');
      dateEl.className = 'tl-bubble-date';
      if (date && !isNaN(date)) {
        dateEl.textContent = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
      } else {
        dateEl.textContent = entry.message ? String(entry.message).slice(0, 20) : '';
      }

      bubble.appendChild(dot);
      bubble.appendChild(hashEl);
      bubble.appendChild(dateEl);

      bubble.addEventListener('click', () => {
        if (selectedHistoryBubble) selectedHistoryBubble.classList.remove('tl-bubble--selected');
        bubble.classList.add('tl-bubble--selected');
        selectedHistoryBubble = bubble;
        loadVersion(hash);
      });

      historyBubbles.appendChild(bubble);

      // Auto-select the first bubble (most-recent version just loaded)
      if (i === 0) {
        bubble.classList.add('tl-bubble--selected');
        selectedHistoryBubble = bubble;
      }
    }
  }

  async function fetchHistory(project) {
    try {
      const url = `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(project)}&history=true`;
      const res = await fetch(url);
      if (!res.ok) { historySection.style.display = 'none'; return; }
      const data = await res.json();
      const commits = Array.isArray(data) ? data : (data.commits ?? data.history ?? []);
      renderHistoryTimeline(commits);
    } catch (_) {
      historySection.style.display = 'none';
    }
  }

  async function loadVersion(commit) {
    const project = projectNameInput.value.trim();
    if (!project || !commit) return;
    endpointStatus.textContent = `Loading version ${commit.slice(0, 8)}…`;
    endpointStatus.className = 'contributions-endpoint-status status-loading';
    try {
      const url = `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(project)}&commit=${encodeURIComponent(commit)}`;
      const res = await fetch(url);
      if (res.status === 404) throw new Error(`Version not found.`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      const loadedRows = fromEndpointPayload(data);
      const newOrcids = {};
      const newAffIds = {};
      const newAffiliations = [];
      const affByName = new Map();
      for (const contributor of data.contributors || []) {
        const name = contributor.author?.name;
        if (!name) continue;
        const orcid = contributor.author?.registry_identifier;
        if (orcid) newOrcids[name] = orcid;
        const affStr = contributor.author?.affiliation;
        if (affStr) {
          if (!affByName.has(affStr)) {
            const id = affStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
            affByName.set(affStr, id);
            newAffiliations.push({ id, name: affStr });
          }
          newAffIds[name] = [affByName.get(affStr)];
        }
      }
      authorOrcids = newOrcids;
      authorAffIds = newAffIds;
      affiliations = newAffiliations.length ? newAffiliations : affiliations;
      // Extract sections
      const newSectionTitles = Array.isArray(data.sections) ? data.sections : [];
      const newSections = [];
      const secByTitle = new Map();
      for (const raw of newSectionTitles) {
        const title = typeof raw === 'string' ? raw : (raw.title || raw.name || '');
        if (!title) continue;
        const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
        secByTitle.set(title, id);
        newSections.push({ id, title });
      }
      const newAuthorSectionIds = {};
      for (const contributor of data.contributors || []) {
        const name = contributor.author?.name;
        if (!name) continue;
        const scs = contributor.section_contributions || [];
        const ids = scs
          .map(sc => secByTitle.get(typeof sc === 'string' ? sc : (sc.section || '')))
          .filter(Boolean);
        if (ids.length) newAuthorSectionIds[name] = ids;
      }
      sections = newSections.length ? newSections : sections;
      authorSectionIds = newAuthorSectionIds;
      // Extract assets
      const newAssets = Array.isArray(data.assets) ? data.assets.filter(Boolean) : [];
      loadedAssetNames = newAssets;
      assetInput.value = newAssets.join(', ');
      renderAssetsTable();
      renderAffiliationsTable();
      renderSectionsTable();
      setRows(loadedRows);
      endpointStatus.textContent = `\u2713 Loaded version ${commit.slice(0, 8)} \u2014 ${loadedRows.length} contributor(s).`;
      endpointStatus.className = 'contributions-endpoint-status status-success';
    } catch (err) {
      endpointStatus.textContent = `Error: ${err.message}`;
      endpointStatus.className = 'contributions-endpoint-status status-error';
      console.error('[contributions-view] loadVersion failed', err);
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
    endpointStatus.textContent = `Fetching \u201c${project}\u201d\u2026`;
    endpointStatus.className = 'contributions-endpoint-status status-loading';
    try {
      const url = `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(project)}`;
      const res = await fetch(url);
      if (res.status === 404) throw new Error(`Project \u201c${project}\u201d not found on server.`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      const loadedRows = fromEndpointPayload(data);
      authorSources = {};
      // Extract orcids and affiliations from the new Author model
      const newOrcids = {};
      const newAffIds = {};
      const newAffiliations = [];
      const affByName = new Map();
      for (const contributor of data.contributors || []) {
        const name = contributor.author?.name;
        if (!name) continue;
        const orcid = contributor.author?.registry_identifier;
        if (orcid) newOrcids[name] = orcid;
        const affStr = contributor.author?.affiliation;
        if (affStr) {
          if (!affByName.has(affStr)) {
            const id = affStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
            affByName.set(affStr, id);
            newAffiliations.push({ id, name: affStr });
          }
          newAffIds[name] = [affByName.get(affStr)];
        }
      }
      authorOrcids = newOrcids;
      authorAffIds = newAffIds;
      affiliations = newAffiliations.length ? newAffiliations : affiliations;
      // Extract sections
      const newSectionTitles = Array.isArray(data.sections) ? data.sections : [];
      const newSections = [];
      const secByTitle = new Map();
      for (const raw of newSectionTitles) {
        const title = typeof raw === 'string' ? raw : (raw.title || raw.name || '');
        if (!title) continue;
        const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
        secByTitle.set(title, id);
        newSections.push({ id, title });
      }
      const newAuthorSectionIds = {};
      for (const contributor of data.contributors || []) {
        const name = contributor.author?.name;
        if (!name) continue;
        const scs = contributor.section_contributions || [];
        const ids = scs
          .map(sc => secByTitle.get(typeof sc === 'string' ? sc : (sc.section || '')))
          .filter(Boolean);
        if (ids.length) newAuthorSectionIds[name] = ids;
      }
      sections = newSections.length ? newSections : sections;
      authorSectionIds = newAuthorSectionIds;
      // Extract assets
      const newAssets = Array.isArray(data.assets) ? data.assets.filter(Boolean) : [];
      loadedAssetNames = newAssets;
      assetInput.value = newAssets.join(', ');
      renderAssetsTable();
      renderAffiliationsTable();
      renderSectionsTable();
      setRows(loadedRows);
      syncUrl();
      endpointStatus.textContent = `\u2713 Loaded \u201c${project}\u201d \u2014 ${loadedRows.length} contributor(s).`;
      endpointStatus.className = 'contributions-endpoint-status status-success';
      // Collapse assets section — irrelevant when working with a loaded project
      assetsOpen = false;
      assetsBody.style.display = 'none';
      assetsToggle.setAttribute('aria-expanded', 'false');
      assetsToggle.querySelector('.cv-toggle-icon').textContent = '▼';
      fetchHistory(project);
    } catch (err) {
      endpointStatus.textContent = `Error: ${err.message}`;
      endpointStatus.className = 'contributions-endpoint-status status-error';
      console.error('[contributions-view] GET failed', err);
    } finally {
      updateProjectButtons();
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
      const payload = toEndpointPayload(rows, project, { authorOrcids, authorAffIds, affiliations, sections, authorSectionIds, assets: loadedAssetNames });
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
      syncUrl();
      fetchHistory(project);
    } catch (err) {
      endpointStatus.textContent = `Error: ${err.message}`;
      endpointStatus.className = 'contributions-endpoint-status status-error';
      console.error('[contributions-view] POST failed', err);
    } finally {
      updateProjectButtons();
    }
  }

  // -------------------------------------------------------------------------
  // Button state management
  // -------------------------------------------------------------------------

  function updateProjectButtons() {
    const hasProject = projectNameInput.value.trim().length > 0;
    getBtn.disabled = !hasProject;
    postBtn.disabled = !hasProject || rows.length === 0;
  }

  // -------------------------------------------------------------------------
  // Event listeners
  // -------------------------------------------------------------------------

  // Assets collapsible toggle
  assetsToggle.addEventListener('click', () => {
    assetsOpen = !assetsOpen;
    assetsBody.style.display = assetsOpen ? '' : 'none';
    assetsToggle.setAttribute('aria-expanded', String(assetsOpen));
    assetsToggle.querySelector('.cv-toggle-icon').textContent = assetsOpen ? '▲' : '▼';
  });

  // Assets tabs
  root.querySelector('#cv-tab-asset-names').addEventListener('click', () => switchAssetsTab('asset-names'));
  root.querySelector('#cv-tab-query').addEventListener('click', () => switchAssetsTab('query'));

  // Load
  loadBtn.addEventListener('click', loadRecords);
  assetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
  assetInput.addEventListener('input', syncUrl);

  // Project
  getBtn.addEventListener('click', loadFromServer);
  postBtn.addEventListener('click', saveToServer);
  projectNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFromServer(); });
  projectNameInput.addEventListener('input', () => { syncUrl(); updateProjectButtons(); });

  // Add author
  root.querySelector('#cv-add-author-btn').addEventListener('click', () => {
    const newRow = { name: 'New Author', isFirst: false };
    for (const cat of CREDIT_CATEGORIES) newRow[cat] = 'None';
    setRows([...rows, newRow]);
  });

  // Add affiliation
  root.querySelector('#cv-add-affiliation-btn').addEventListener('click', () => {
    const id = `aff-${Date.now()}`;
    affiliations = [...affiliations, { id, name: '' }];
    renderAffiliationsTable();
    renderAuthorsTable();
    saveDraft();
  });

  root.querySelector('#cv-add-section-btn').addEventListener('click', () => {
    const id = `sec-${Date.now()}`;
    sections = [...sections, { id, title: '' }];
    renderSectionsTable();
    renderAuthorsTable();
    saveDraft();
  });

  // Output tabs
  root.querySelector('#cv-out-tab-preview').addEventListener('click', () => switchOutputTab('preview'));
  root.querySelector('#cv-out-tab-latex').addEventListener('click', () => switchOutputTab('latex'));

  // -------------------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------------------

  renderAffiliationsTable();
  renderSectionsTable();

  // Restore draft or auto-load
  let draftRestored = false;
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const draft = JSON.parse(raw);
      if (draft.rows?.length > 0) {
        assetInput.value = draft.assetNames || '';
        projectNameInput.value = draft.projectName || '';
        authorSources = draft.authorSources || {};
        authorOrcids  = draft.authorOrcids  || {};
        authorAffIds  = draft.authorAffIds  || {};
        if (draft.affiliations?.length) affiliations = draft.affiliations;
        if (draft.sections?.length) sections = draft.sections;
        authorSectionIds = draft.authorSectionIds || {};
        loadedAssetNames = draft.loadedAssetNames || [];
        renderAffiliationsTable();
        renderSectionsTable();
        renderAssetsTable();
        setRows(draft.rows);
        syncUrl();
        draftRestored = true;
      }
    }
  } catch (_) {}

  if (assetName && !draftRestored) {
    Promise.resolve().then(loadRecords);
  }

  updateProjectButtons();
  return root;
}

// ---------------------------------------------------------------------------
// Helper: extractAuthors with ORCID collection
// ---------------------------------------------------------------------------

function extractAuthorsWithOrcids(records) {
  const authors = [];
  const authorSources = {};
  const authorOrcids = {};

  function addName(nameOrObj, source) {
    const name = typeof nameOrObj === 'object' ? nameOrObj?.name : nameOrObj;
    if (!name) return;
    const trimmed = String(name).trim();
    const lower = trimmed.toLowerCase();
    if (!trimmed || lower === 'unknown' || lower === 'na' || lower === 'n/a') return;
    if (!authorSources[trimmed]) {
      authors.push(trimmed);
      authorSources[trimmed] = [];
    }
    if (!authorSources[trimmed].includes(source)) authorSources[trimmed].push(source);
    if (typeof nameOrObj === 'object') {
      const orcid = nameOrObj.orcid || nameOrObj.orcid_id || '';
      if (orcid && !authorOrcids[trimmed]) authorOrcids[trimmed] = orcid;
    }
  }

  for (const record of records) {
    const dataDesc = record.data_description ?? {};
    for (const inv of dataDesc.investigators ?? [])
      addName(inv, 'investigators');
    for (const funding of dataDesc.funding_source ?? []) {
      const fundee = funding.fundee;
      if (Array.isArray(fundee)) {
        for (const p of fundee) addName(p, 'funding');
      } else if (typeof fundee === 'string') {
        for (const part of fundee.replace(/ and /gi, ',').split(','))
          addName(part.trim(), 'funding');
      }
    }
    for (const exp of record.acquisition?.experimenters ?? [])
      addName(exp, 'acquisition');
    for (const proc of record.procedures?.subject_procedures ?? [])
      for (const exp of proc.experimenters ?? []) addName(exp, 'procedures');
    for (const proc of record.procedures?.specimen_procedures ?? [])
      for (const exp of proc.experimenters ?? []) addName(exp, 'procedures');
    for (const process of record.processing?.data_processes ?? [])
      for (const exp of process.experimenters ?? []) addName(exp, 'processing');
  }

  return { authors, authorSources, authorOrcids };
}

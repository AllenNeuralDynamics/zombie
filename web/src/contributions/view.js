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
import { CREDIT_ROLES } from './credit-helpers.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All 14 CRediT taxonomy roles in widget display order. */
export const CREDIT_CATEGORIES = CREDIT_ROLES;

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
  const { authorOrcids = {}, authorAffIds = {}, affiliations = [], sections = [], creditDescriptions = {}, creditLinkedSections = {}, assets = [], doi = '' } = meta;
  const contributors = rows.map((row) => {
    const credit_levels = [];
    for (const displayRole of CREDIT_CATEGORIES) {
      const level = row[displayRole];
      if (level && level !== 'None') {
        const roleEnum = CREDIT_ROLE_ENUM[displayRole];
        const desc = creditDescriptions[row.name]?.[roleEnum];
        const secIds = creditLinkedSections[row.name]?.[roleEnum] || [];
        const linkedSections = secIds.map(id => sections.find(s => s.id === id)?.title).filter(Boolean);
        credit_levels.push({
          role: roleEnum,
          level: level.toLowerCase(),
          ...(desc ? { description: desc } : {}),
          ...(linkedSections.length ? { linked_sections: linkedSections } : {}),
        });
      }
    }
    const author = { name: row.name };
    const orcid = authorOrcids[row.name];
    if (orcid) author.registry_identifier = orcid;
    const affIds = authorAffIds[row.name] || [];
    const affNames = affIds.map(id => affiliations.find(a => a.id === id)?.name).filter(Boolean);
    if (affNames.length) author.affiliation = affNames;
    return { author, author_level: row.author_level ?? null, credit_levels };
  });
  const topSections = sections.map(s => s.title).filter(Boolean);
  const topAssets = assets.filter(Boolean);
  return {
    project_name: projectName,
    ...(doi ? { doi } : {}),
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
    const row = { name: contributor.author?.name ?? '', isFirst: false, author_level: contributor.author_level ?? null };
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
 * Format an author name to dot-separated initials: "First Mid Last" → "F.M.L."
 *
 * @param {string} name
 * @returns {string}
 */
export function formatAuthorInitials(name) {
  return name.trim().split(/\s+/).map(p => (p[0] || '').toUpperCase() + '.').join('');
}

/**
 * Generate the CRediT contribution statement and per-author descriptions.
 *
 * Statement format: "Conceptualization, A.B., C.D.; Methodology, E.F.; ..."
 * Authors within each role are ordered Lead → Equal → Supporting.
 *
 * @param {ReturnType<typeof initMatrix>} rows
 * @param {Record<string, string>} [contribDescriptions] - Per-author free-text descriptions.
 * @returns {{ statement: string, descriptions: string }}
 */
export function generateContributionStatement(rows, creditDescriptions = {}) {
  const parts = [];
  for (const cat of CREDIT_CATEGORIES) {
    const initials = [];
    for (const level of ['Lead', 'Equal', 'Supporting']) {
      for (const row of rows) {
        if (row[cat] === level) initials.push(formatAuthorInitials(row.name));
      }
    }
    if (initials.length > 0) parts.push(`${cat}, ${initials.join(', ')}`);
  }
  const statement = parts.join('; ');

  const descLines = [];
  for (const row of rows) {
    const perRole = creditDescriptions[row.name];
    if (!perRole) continue;
    const roleDescs = Object.entries(perRole)
      .filter(([, v]) => v && v.trim())
      .map(([roleEnum, v]) => `${CREDIT_ROLE_ENUM_REVERSE[roleEnum] || roleEnum}: ${v.trim()}`);
    if (roleDescs.length) descLines.push(`${formatAuthorInitials(row.name)}: ${roleDescs.join('; ')}`);
  }

  return { statement, descriptions: descLines.join('\n') };
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
    return { name: row.name, author_level: row.author_level ?? null, credit_levels };
  });
}

// ---------------------------------------------------------------------------
// DOM component
// ---------------------------------------------------------------------------

/**
 * Render the contribution matrix to an HTMLCanvasElement and return it.
 *
 * Columns with no contributions are omitted (matching the image reference).
 * Colors use the page's indigo palette (rgba 99,102,241 at three opacities).
 *
 * @param {ReturnType<typeof initMatrix>} rows
 * @returns {HTMLCanvasElement}
 */
export function generateMatrixCanvas(rows) {
  const CELL        = 30;
  const NAME_W      = 170;
  const HEADER_H    = 155;  // enough room for ~45°-rotated text
  const PAD         = 20;
  const LEGEND_GAP  = 28;
  const LEGEND_W    = 76;   // "Supporting" at 11.5px ≈ 60px
  const LEGEND_STEP = 22;
  const FONT_BODY   = 'bold 12px Inter, system-ui, sans-serif';
  const FONT_HDR    = '500 11.5px Inter, system-ui, sans-serif';
  const FONT_LEGEND = '600 11.5px Inter, system-ui, sans-serif';

  // Only roles with at least one non-None entry
  const activeRoles = CREDIT_CATEGORIES.filter(cat =>
    rows.some(row => row[cat] && row[cat] !== 'None'),
  );

  const gridW   = activeRoles.length * CELL;
  const gridH   = rows.length * CELL;
  const canvasW = PAD + NAME_W + gridW + LEGEND_GAP + LEGEND_W + PAD;
  const canvasH = HEADER_H + gridH + PAD;

  const canvas = document.createElement('canvas');
  const dpr    = Math.ceil(window.devicePixelRatio || 1);
  canvas.width  = canvasW * dpr;
  canvas.height = canvasH * dpr;
  canvas.style.width  = canvasW + 'px';
  canvas.style.height = canvasH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Cell fill colours — indigo palette matching cell-lead/equal/supporting
  const FILL = {
    Lead:       'rgba(99,102,241,0.75)',
    Equal:      'rgba(99,102,241,0.40)',
    Supporting: 'rgba(99,102,241,0.18)',
  };

  // ── Column headers (rotated −45°) ──
  for (let ci = 0; ci < activeRoles.length; ci++) {
    const cx = PAD + NAME_W + ci * CELL + CELL / 2;
    const cy = HEADER_H - 8;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-Math.PI / 4);
    ctx.font         = FONT_HDR;
    ctx.fillStyle    = '#374151';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(activeRoles[ci], 4, 0);
    ctx.restore();
  }

  // ── Author rows ──
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const ry  = HEADER_H + ri * CELL;

    // Author name (right-aligned into name column)
    ctx.font         = FONT_BODY;
    ctx.fillStyle    = '#111827';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.name, PAD + NAME_W - 8, ry + CELL / 2);

    // Contribution cells
    for (let ci = 0; ci < activeRoles.length; ci++) {
      const level = row[activeRoles[ci]];
      if (!level || level === 'None') continue;
      const cx = PAD + NAME_W + ci * CELL;
      ctx.fillStyle = FILL[level] || FILL.Supporting;
      ctx.fillRect(cx + 1, ry + 1, CELL - 1, CELL - 1);
    }
  }

  // ── Vertical legend — right of matrix, centered — colored words only ──
  const LEGEND_COLORS = {
    Lead:       '#4338ca',
    Equal:      '#818cf8',
    Supporting: '#9ca3af',
  };
  const legendX      = PAD + NAME_W + gridW + LEGEND_GAP;
  const legendItems  = ['Lead', 'Equal', 'Supporting'];
  const legendTotalH = legendItems.length * LEGEND_STEP;
  const legendStartY = HEADER_H + gridH / 2 - legendTotalH / 2 + LEGEND_STEP / 2;

  ctx.font         = FONT_LEGEND;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < legendItems.length; i++) {
    ctx.fillStyle = LEGEND_COLORS[legendItems[i]];
    ctx.fillText(legendItems[i], legendX, legendStartY + i * LEGEND_STEP);
  }

  return canvas;
}

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

  /** @type {string|null} Author currently selected for editing. */
  let selectedAuthor = null;

  /** @type {Record<string, Record<string, string>>} Per-credit-role description, keyed by [authorName][roleEnum]. */
  let creditDescriptions = {};

  /** @type {Record<string, Record<string, string[]>>} Per-credit-role linked section IDs, keyed by [authorName][roleEnum]. */
  let creditLinkedSections = {};

  /** @type {string[]} Asset names that were loaded */
  let loadedAssetNames = [];

  /** @type {string} DOI for the paper. */
  let doi = '';

  let sharedDetailsOpen = false;

  /** @type {'preview'|'latex'|'statement'|'matrix-png'} */
  let activeOutputTab = 'preview';

  /** @type {'asset-names'|'query'} */
  let activeAssetsTab = 'asset-names';

  let assetsOpen = true;

  let projectLocked = false;
  let projectPassword = '';
  /** True when the server-side model has a password set (loaded via GET). */
  let serverLocked = false;

  /** @type {HTMLElement|null} Currently-selected history bubble. */
  let selectedHistoryBubble = null;

  // -------------------------------------------------------------------------
  // Root element
  // -------------------------------------------------------------------------

  const root = document.createElement('div');
  root.className = 'contributions-view';
  root.innerHTML = `
    <!-- ── Top bar: timeline (left) + project widget (right) ────────── -->
    <div class="cv-topbar">
      <section class="cv-history-section" id="cv-history-section" style="display:none">
        <div class="cv-history-header">
          <span class="cv-section-title">Version History</span>
          <span class="cv-history-hint" id="cv-history-hint"></span>
        </div>
        <div class="subject-timeline-bubbles" id="cv-history-bubbles"></div>
      </section>

      <div class="cv-project-widget">
        <div class="cv-pw-name-row">
          <label for="cv-project-name">Project</label>
          <input id="cv-project-name" type="text" placeholder="e.g. my-project-2024" />
        </div>
        <div class="cv-pw-lock-row">
          <label class="cv-pw-lock-label">
            <input type="checkbox" id="cv-project-locked" />
            <span>Lock project</span>
          </label>
        </div>
        <div class="cv-pw-password-row" id="cv-pw-password-row" style="display:none">
          <label for="cv-project-password">Password</label>
          <input id="cv-project-password" type="password" placeholder="Set a password" />
        </div>
        <div class="cv-pw-btn-row">
          <button id="cv-get-btn" class="btn-secondary">Load</button>
          <button id="cv-post-btn" class="btn-primary" disabled>Save</button>
        </div>
        <div id="cv-endpoint-status" class="contributions-endpoint-status" aria-live="polite"></div>
      </div>
    </div>

    <!-- ── Assets section ───────────────────────────────────────────── -->
    <section class="cv-section cv-assets-section">
      <button class="cv-section-toggle" id="cv-assets-toggle" aria-expanded="true">
        <span class="cv-section-title">Data Assets</span>
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
            <button id="cv-load-btn" class="btn-primary">Add assets</button>
          </div>
        </div>
        <div id="cv-panel-query" class="cv-tab-panel" style="display:none">
          <p class="cv-placeholder">Query interface coming soon.</p>
        </div>
        <div id="cv-assets-table-wrap" style="display:none">
          <table class="cv-assets-table">
            <thead><tr><th>Associated assets</th></tr></thead>
            <tbody id="cv-assets-tbody"></tbody>
          </table>
        </div>
        <div id="cv-info" class="cv-info" aria-live="polite"></div>
      </div>
    </section>

    <!-- ── Shared Details: DOI, Affiliations, Sections ─────────────── -->
    <section class="cv-section cv-shared-details-section">
      <button class="cv-section-toggle" id="cv-shared-details-toggle" aria-expanded="false">
        <span class="cv-section-title">Shared Details</span>
        <span class="cv-toggle-icon">▼</span>
      </button>
      <div class="cv-section-body" id="cv-shared-details-body" style="display:none">
        <div class="cv-doi-row">
          <label class="cv-detail-label" for="cv-doi-input">DOI</label>
          <input id="cv-doi-input" type="text" class="cv-doi-input" placeholder="e.g. 10.1234/example.2024" />
        </div>
        <div class="cv-meta-columns">
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
        </div>
      </div>
    </section>

    <!-- ── Contributors section ─────────────────────────────────────── -->
    <section class="cv-section cv-contributors-section" id="cv-contributors-section">
      <div class="cv-contributors-header">
        <h3 class="cv-section-heading">Contributors</h3>
        <div class="cv-author-selector-wrap" id="cv-author-selector-wrap" style="display:none">
          <label for="cv-author-selector" class="cv-selector-label">Edit as:</label>
          <select id="cv-author-selector" class="cv-author-select">
            <option value="">— select author —</option>
          </select>
        </div>
      </div>

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
    </section>

    <!-- ── Author detail editor ──────────────────────────────────────── -->
    <section class="cv-section cv-author-detail-section" id="cv-author-detail-section" style="display:none">
      <div class="cv-author-detail-header">
        <h3 class="cv-section-heading">Editing: <span id="cv-detail-name" class="cv-detail-name-badge"></span></h3>
      </div>

      <div class="cv-detail-meta-grid">
        <div class="cv-detail-meta-item">
          <label class="cv-detail-label" for="cv-detail-orcid">ORCID iD</label>
          <div class="cv-orcid-row">
            <input id="cv-detail-orcid" type="text" class="cv-orcid-input" placeholder="0000-0000-0000-0000" />
            <button type="button" id="cv-orcid-search-btn" class="btn-secondary cv-orcid-search-btn">Search</button>
          </div>
        </div>
        <div class="cv-detail-meta-item">
          <label class="cv-detail-label" for="cv-detail-author-level">Author level</label>
          <select id="cv-detail-author-level" class="cv-author-level-select">
            <option value="">None</option>
            <option value="first">first</option>
            <option value="senior">senior</option>
          </select>
        </div>
        <div class="cv-detail-meta-item cv-detail-aff-item">
          <label class="cv-detail-label">Affiliations</label>
          <div id="cv-detail-affiliations"></div>
        </div>
      </div>

      <h4 class="cv-subsection-heading">Contribution Details</h4>
      <p class="cv-placeholder cv-detail-hint" id="cv-detail-hint" style="display:none">
        No contributions assigned yet — set contribution levels in the matrix above.
      </p>
      <div id="cv-detail-credit-list" class="cv-detail-credit-list"></div>

    </section>

    <!-- ── Preview / LaTeX output tabs ──────────────────────────────── -->
    <section class="cv-section cv-output-section" id="cv-output-section">
      <div class="cv-tabs" role="tablist">
        <button class="cv-tab cv-tab-active" id="cv-out-tab-preview" role="tab" aria-selected="true">Preview</button>
        <button class="cv-tab" id="cv-out-tab-latex" role="tab" aria-selected="false">Generate LaTeX</button>
        <button class="cv-tab" id="cv-out-tab-statement" role="tab" aria-selected="false">Contribution Statement</button>
        <button class="cv-tab" id="cv-out-tab-matrix-png" role="tab" aria-selected="false">Download PNG</button>
      </div>
      <div id="cv-out-panel-preview" class="cv-tab-panel">
        <div id="cv-preview-container"></div>
      </div>
      <div id="cv-out-panel-latex" class="cv-tab-panel" style="display:none">
        <pre id="cv-latex-output" class="contributions-latex-output"></pre>
      </div>
      <div id="cv-out-panel-statement" class="cv-tab-panel" style="display:none">
        <p class="cv-statement-label">CRediT contribution statement</p>
        <textarea id="cv-statement-output" class="contributions-statement-output" readonly></textarea>
        <p class="cv-statement-label cv-statement-label-descriptions">Individual contribution descriptions</p>
        <textarea id="cv-descriptions-output" class="contributions-statement-output contributions-descriptions-output" readonly></textarea>
      </div>
      <div id="cv-out-panel-matrix-png" class="cv-tab-panel" style="display:none">
        <div class="cv-matrix-png-toolbar">
          <button id="cv-matrix-png-download" class="btn-primary">Download PNG</button>
        </div>
        <div id="cv-matrix-png-preview" class="cv-matrix-png-preview"></div>
      </div>
    </section>
  `;

  // -------------------------------------------------------------------------
  // Element references
  // -------------------------------------------------------------------------

  const assetInput          = root.querySelector('#cv-asset-names');
  const loadBtn             = root.querySelector('#cv-load-btn');
  const infoEl              = root.querySelector('#cv-info');
  const assetsToggle        = root.querySelector('#cv-assets-toggle');
  const assetsBody          = root.querySelector('#cv-assets-body');
  const assetsTableWrap     = root.querySelector('#cv-assets-table-wrap');
  const assetsTbody         = root.querySelector('#cv-assets-tbody');
  const authorsTbody        = root.querySelector('#cv-authors-tbody');
  const authorsTheadRow     = root.querySelector('#cv-authors-thead-row');
  const authorDetailSection = root.querySelector('#cv-author-detail-section');
  const outputSection       = root.querySelector('#cv-output-section');
  const previewContainer    = root.querySelector('#cv-preview-container');
  const latexOutput         = root.querySelector('#cv-latex-output');
  const projectNameInput    = root.querySelector('#cv-project-name');
  const projectLockedCheckbox = root.querySelector('#cv-project-locked');
  const projectPasswordInput  = root.querySelector('#cv-project-password');
  const pwPasswordRow         = root.querySelector('#cv-pw-password-row');
  const getBtn              = root.querySelector('#cv-get-btn');
  const postBtn             = root.querySelector('#cv-post-btn');
  const endpointStatus      = root.querySelector('#cv-endpoint-status');
  const affiliationsTbody   = root.querySelector('#cv-affiliations-tbody');
  const sectionsTbody       = root.querySelector('#cv-sections-tbody');
  const historySection      = root.querySelector('#cv-history-section');
  const historyBubbles      = root.querySelector('#cv-history-bubbles');
  const historyHint         = root.querySelector('#cv-history-hint');
  const statementOutput     = root.querySelector('#cv-statement-output');
  const descriptionsOutput  = root.querySelector('#cv-descriptions-output');
  const matrixPngPreview    = root.querySelector('#cv-matrix-png-preview');
  const matrixPngDownload   = root.querySelector('#cv-matrix-png-download');
  const doiInput            = root.querySelector('#cv-doi-input');

  if (assetName)    assetInput.value       = assetName;
  if (projectName)  projectNameInput.value = projectName;

  // -------------------------------------------------------------------------
  // URL sync & draft persistence
  // -------------------------------------------------------------------------

  const DRAFT_KEY = 'contributions:draft';

  function syncUrl() {
    const params = new URLSearchParams(window.location.search);
    const project = projectNameInput.value.trim();
    if (project) params.set('project', project); else params.delete('project');
    // asset_name is never written back to the URL — the input is ephemeral
    params.delete('asset_name');
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }

  function saveDraft() {
    if (rows.length === 0) { sessionStorage.removeItem(DRAFT_KEY); return; }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        assetNames: assetInput.value.trim(),
        projectName: projectNameInput.value.trim(),
        projectLocked,
        projectPassword,
        rows, authorSources, authorOrcids, authorAffIds, affiliations, loadedAssetNames,
        sections, creditDescriptions, creditLinkedSections, selectedAuthor, doi, serverLocked,
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
        renderAuthorDetail();
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
        renderAuthorDetail();
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
        for (const name of Object.keys(creditLinkedSections)) {
          for (const roleEnum of Object.keys(creditLinkedSections[name] || {})) {
            creditLinkedSections[name][roleEnum] = (creditLinkedSections[name][roleEnum] || []).filter(id => id !== sec.id);
          }
        }
        renderSectionsTable();
        renderAuthorDetail();
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
        renderAuthorDetail();
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

    function render(currentIds) {
      wrap.innerHTML = '';

      // Chips for selected items
      for (const id of currentIds) {
        const aff = options.find(o => o.id === id);
        if (!aff) continue;
        const chip = document.createElement('span');
        chip.className = 'cv-chip';
        chip.title = aff.name;
        const chipText = document.createElement('span');
        chipText.className = 'cv-chip-text';
        chipText.textContent = aff.name;
        chip.appendChild(chipText);
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
    const cols = ['', 'Name', ...CREDIT_CATEGORIES];
    for (const col of cols) {
      const th = document.createElement('th');
      th.textContent = col;
      authorsTheadRow.appendChild(th);
    }
  }

  function renderAuthorsTable() {
    authorsTbody.innerHTML = '';
    rows.forEach((row, rowIdx) => {
      const isActive = selectedAuthor !== null && row.name === selectedAuthor;
      const tr = document.createElement('tr');
      if (!isActive) tr.classList.add('cv-row-locked');

      // X — remove
      const tdX = document.createElement('td');
      const xBtn = document.createElement('button');
      xBtn.className = 'cv-x-btn';
      xBtn.textContent = '×';
      xBtn.setAttribute('aria-label', `Remove ${row.name}`);
      xBtn.addEventListener('click', () => {
        if (selectedAuthor === row.name) selectedAuthor = null;
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
      if (!isActive) nameInput.disabled = true;
      nameInput.addEventListener('change', () => {
        const oldName = rows[rowIdx].name;
        const newName = nameInput.value.trim();
        if (!newName || newName === oldName) return;
        rows[rowIdx].name = newName;
        if (authorOrcids[oldName])       { authorOrcids[newName] = authorOrcids[oldName]; delete authorOrcids[oldName]; }
        if (authorAffIds[oldName])       { authorAffIds[newName] = authorAffIds[oldName]; delete authorAffIds[oldName]; }
        if (creditDescriptions[oldName]) { creditDescriptions[newName] = creditDescriptions[oldName]; delete creditDescriptions[oldName]; }
        if (creditLinkedSections[oldName]) { creditLinkedSections[newName] = creditLinkedSections[oldName]; delete creditLinkedSections[oldName]; }
        if (authorSources[oldName])      { authorSources[newName] = authorSources[oldName]; delete authorSources[oldName]; }
        if (selectedAuthor === oldName)  selectedAuthor = newName;
        updateAuthorSelector();
        updatePreview(); saveDraft();
      });
      tdName.appendChild(nameInput);
      tr.appendChild(tdName);

      // Credit category selects
      for (const cat of CREDIT_CATEGORIES) {
        const td = document.createElement('td');
        td.className = `cell-center cell-${(row[cat] || 'none').toLowerCase()}`;
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `${row.name} \u2014 ${cat}`);
        if (!isActive) sel.disabled = true;
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
          if (selectedAuthor === row.name) renderAuthorDetail();
        });
        td.appendChild(sel);
        tr.appendChild(td);
      }

      authorsTbody.appendChild(tr);
    });
  }

  // -------------------------------------------------------------------------
  // Author selector & detail editor
  // -------------------------------------------------------------------------

  function updateAuthorSelector() {
    const sel = root.querySelector('#cv-author-selector');
    const wrap = root.querySelector('#cv-author-selector-wrap');
    if (!sel || !wrap) return;
    sel.innerHTML = '<option value="">\u2014 select author \u2014</option>';
    for (const row of rows) {
      const opt = document.createElement('option');
      opt.value = row.name;
      opt.textContent = row.name;
      if (row.name === selectedAuthor) opt.selected = true;
      sel.appendChild(opt);
    }
    wrap.style.display = rows.length > 0 ? '' : 'none';
  }

  function renderAuthorDetail() {
    if (!authorDetailSection) return;
    if (!selectedAuthor) { authorDetailSection.style.display = 'none'; return; }
    const row = rows.find(r => r.name === selectedAuthor);
    if (!row) { authorDetailSection.style.display = 'none'; return; }

    authorDetailSection.style.display = '';
    root.querySelector('#cv-detail-name').textContent = selectedAuthor;

    // ORCID
    const orcidInput = root.querySelector('#cv-detail-orcid');
    orcidInput.value = authorOrcids[selectedAuthor] || '';
    orcidInput.onchange = () => {
      authorOrcids[selectedAuthor] = orcidInput.value.trim();
      saveDraft();
    };

    // Author level
    const authorLevelSel = root.querySelector('#cv-detail-author-level');
    authorLevelSel.value = row.author_level || '';
    authorLevelSel.onchange = () => {
      row.author_level = authorLevelSel.value || null;
      updatePreview();
      saveDraft();
    };

    // ORCID public-API search
    const orcidSearchBtn = root.querySelector('#cv-orcid-search-btn');
    let orcidDropdownEl = null;
    function closeOrcidDropdown() {
      if (orcidDropdownEl) { orcidDropdownEl.remove(); orcidDropdownEl = null; }
    }
    orcidSearchBtn.onclick = async () => {
      closeOrcidDropdown();
      const prevText = orcidSearchBtn.textContent;
      orcidSearchBtn.disabled = true;
      orcidSearchBtn.textContent = '…';
      try {
        const parts = selectedAuthor.trim().split(/\s+/);
        const familyName = parts[parts.length - 1];
        const givenNames = parts.slice(0, -1).join('+');
        const q = givenNames
          ? `family-name:${encodeURIComponent(familyName)}+AND+given-names:${encodeURIComponent(givenNames)}`
          : `family-name:${encodeURIComponent(familyName)}`;
        const res = await fetch(`https://pub.orcid.org/v3.0/search/?q=${q}&rows=5`, {
          headers: { Accept: 'application/vnd.orcid+json' },
        });
        if (!res.ok) throw new Error(`ORCID API ${res.status}`);
        const data = await res.json();
        const orcids = (data.result || []).map(r => r['orcid-identifier']?.path).filter(Boolean);
        if (orcids.length === 0) {
          orcidSearchBtn.textContent = 'No results';
          setTimeout(() => { orcidSearchBtn.textContent = prevText; }, 2000);
        } else {
          orcidDropdownEl = document.createElement('div');
          orcidDropdownEl.className = 'cv-chip-dropdown cv-orcid-dropdown';
          for (const orcid of orcids) {
            const item = document.createElement('button');
            item.className = 'cv-chip-dropdown-item';
            item.textContent = orcid;
            item.addEventListener('mousedown', (e) => {
              e.preventDefault();
              orcidInput.value = orcid;
              authorOrcids[selectedAuthor] = orcid;
              closeOrcidDropdown();
              saveDraft();
            });
            orcidDropdownEl.appendChild(item);
          }
          const orcidRow = orcidInput.parentElement;
          orcidRow.style.position = 'relative';
          orcidRow.appendChild(orcidDropdownEl);
          setTimeout(() => { document.addEventListener('click', closeOrcidDropdown, { once: true }); }, 0);
        }
      } catch (_) {
        orcidSearchBtn.textContent = 'Error';
        setTimeout(() => { orcidSearchBtn.textContent = prevText; }, 2000);
      } finally {
        orcidSearchBtn.disabled = false;
        if (orcidSearchBtn.textContent === '…') orcidSearchBtn.textContent = prevText;
      }
    };

    // Affiliations chip-select
    const affContainer = root.querySelector('#cv-detail-affiliations');
    affContainer.innerHTML = '';
    affContainer.appendChild(buildChipSelect(
      affiliations,
      authorAffIds[selectedAuthor] || [],
      (ids) => { authorAffIds[selectedAuthor] = ids; updatePreview(); saveDraft(); },
      `${selectedAuthor} affiliations`,
    ));

    // Per-role contribution detail cards
    const creditList = root.querySelector('#cv-detail-credit-list');
    const hintEl = root.querySelector('#cv-detail-hint');
    creditList.innerHTML = '';
    const activeRoles = CREDIT_CATEGORIES.filter(cat => row[cat] && row[cat] !== 'None');

    if (activeRoles.length === 0) {
      hintEl.style.display = '';
      return;
    }
    hintEl.style.display = 'none';

    for (const cat of activeRoles) {
      const roleEnum = CREDIT_ROLE_ENUM[cat];
      const card = document.createElement('div');
      card.className = 'cv-credit-card';

      const header = document.createElement('div');
      header.className = 'cv-credit-card-header';
      const roleName = document.createElement('span');
      roleName.className = 'cv-credit-role-name';
      roleName.textContent = cat;
      const levelBadge = document.createElement('span');
      levelBadge.className = `cv-credit-level-badge cv-credit-level-${row[cat].toLowerCase()}`;
      levelBadge.textContent = row[cat];
      header.appendChild(roleName);
      header.appendChild(levelBadge);
      card.appendChild(header);

      const descLabel = document.createElement('label');
      descLabel.className = 'cv-detail-label';
      descLabel.textContent = 'Description';
      card.appendChild(descLabel);

      const descInput = document.createElement('textarea');
      descInput.className = 'cv-credit-desc-textarea';
      descInput.rows = 2;
      descInput.placeholder = 'Describe your specific contribution\u2026';
      descInput.value = creditDescriptions[selectedAuthor]?.[roleEnum] || '';
      descInput.addEventListener('change', () => {
        if (!creditDescriptions[selectedAuthor]) creditDescriptions[selectedAuthor] = {};
        creditDescriptions[selectedAuthor][roleEnum] = descInput.value.trim();
        saveDraft();
      });
      card.appendChild(descInput);

      if (sections.length > 0) {
        const secLabel = document.createElement('label');
        secLabel.className = 'cv-detail-label';
        secLabel.textContent = 'Sections';
        card.appendChild(secLabel);
        card.appendChild(buildChipSelect(
          sections.map(s => ({ id: s.id, name: s.title })),
          creditLinkedSections[selectedAuthor]?.[roleEnum] || [],
          (ids) => {
            if (!creditLinkedSections[selectedAuthor]) creditLinkedSections[selectedAuthor] = {};
            creditLinkedSections[selectedAuthor][roleEnum] = ids;
            updatePreview(); saveDraft();
          },
          `${selectedAuthor} sections for ${cat}`,
        ));
      }

      creditList.appendChild(card);
    }
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
      // Collect all unique sections this author is linked to across all roles
      const allSecIds = new Set();
      for (const roleEnum of Object.values(CREDIT_ROLE_ENUM)) {
        for (const id of (creditLinkedSections[a.name]?.[roleEnum] || [])) allSecIds.add(id);
      }
      const sectionContribs = [...allSecIds]
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
    for (const id of ['preview', 'latex', 'statement', 'matrix-png']) {
      root.querySelector(`#cv-out-tab-${id}`).classList.toggle('cv-tab-active', tab === id);
      root.querySelector(`#cv-out-tab-${id}`).setAttribute('aria-selected', String(tab === id));
      root.querySelector(`#cv-out-panel-${id}`).style.display = tab === id ? '' : 'none';
    }
    if (tab === 'latex' && rows.length > 0) {
      latexOutput.textContent = generateLatex(rows);
    }
    if (tab === 'statement' && rows.length > 0) {
      const { statement, descriptions } = generateContributionStatement(rows, creditDescriptions);
      statementOutput.value = statement;
      descriptionsOutput.value = descriptions;
    }
    if (tab === 'matrix-png' && rows.length > 0) {
      renderMatrixPng();
    }
  }

  function renderMatrixPng() {
    matrixPngPreview.innerHTML = '';
    const canvas = generateMatrixCanvas(rows);
    matrixPngPreview.appendChild(canvas);
  }

  // -------------------------------------------------------------------------
  // Visibility helpers
  // -------------------------------------------------------------------------

  function setRows(newRows) {
    rows = newRows;
    buildAuthorsTableHeader();
    renderAuthorsTable();
    updateAuthorSelector();
    renderAuthorDetail();
    updateProjectButtons();
    if (rows.length > 0) {
      updatePreview();
      if (activeOutputTab === 'latex') latexOutput.textContent = generateLatex(rows);
      if (activeOutputTab === 'statement') {
        const { statement, descriptions } = generateContributionStatement(rows, creditDescriptions);
        statementOutput.value = statement;
        descriptionsOutput.value = descriptions;
      }
      if (activeOutputTab === 'matrix-png') renderMatrixPng();
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
    // Merge the new names into loadedAssetNames (dedup)
    const existingAssetSet = new Set(loadedAssetNames);
    const newAssetNames = names.filter(n => !existingAssetSet.has(n));
    loadedAssetNames = [...loadedAssetNames, ...newAssetNames];
    renderAssetsTable();
    infoEl.textContent = `Loading ${names.length} asset(s)\u2026`;

    try {
      const records = await fetchDocDbRecordsByName(names, docdbOptions);
      const { authors, authorSources: sources, authorOrcids: orcids } = extractAuthorsWithOrcids(records);

      // Merge sources (add new sources without overwriting existing)
      for (const [name, srcs] of Object.entries(sources)) {
        if (!authorSources[name]) authorSources[name] = [];
        for (const src of srcs) {
          if (!authorSources[name].includes(src)) authorSources[name].push(src);
        }
      }

      // Merge orcids (don't overwrite existing entries)
      for (const [name, orcid] of Object.entries(orcids)) {
        if (!authorOrcids[name]) authorOrcids[name] = orcid;
      }

      // Add only authors not already present — never remove existing rows
      const existingNames = new Set(rows.map(r => r.name));
      const newAuthors = authors.filter(a => !existingNames.has(a));
      const addedRows = initMatrix(newAuthors);

      infoEl.textContent = `${records.length} record(s) loaded \u2014 ${newAuthors.length} new author(s) added.`;
      assetInput.value = '';

      setRows([...rows, ...addedRows]);
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

  // -------------------------------------------------------------------------
  // Extract state from GET payload (shared by loadFromServer and loadVersion)
  // -------------------------------------------------------------------------

  function extractPayloadMeta(data) {
    // Build sections index from top-level sections list
    const newSections = [];
    const secByTitle = new Map();
    for (const raw of (Array.isArray(data.sections) ? data.sections : [])) {
      const title = typeof raw === 'string' ? raw : (raw.title || raw.name || '');
      if (!title) continue;
      const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
      secByTitle.set(title, id);
      newSections.push({ id, title });
    }

    const newOrcids = {};
    const newAffIds = {};
    const newAffiliations = [];
    const newCreditDescriptions = {};
    const newCreditLinkedSections = {};
    const affByName = new Map();

    for (const contributor of data.contributors || []) {
      const name = contributor.author?.name;
      if (!name) continue;

      const orcid = contributor.author?.registry_identifier;
      if (orcid) newOrcids[name] = orcid;

      // affiliation is now an array of strings
      const affRaw = contributor.author?.affiliation;
      const affArr = Array.isArray(affRaw) ? affRaw
        : (typeof affRaw === 'string' && affRaw ? [affRaw] : []);
      for (const affStr of affArr) {
        if (!affByName.has(affStr)) {
          const id = affStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/, '');
          affByName.set(affStr, id);
          newAffiliations.push({ id, name: affStr });
        }
      }
      if (affArr.length) newAffIds[name] = affArr.map(s => affByName.get(s)).filter(Boolean);

      // description and linked_sections are now nested inside each credit_level
      for (const cl of contributor.credit_levels || []) {
        const roleEnum = cl.role;
        if (!roleEnum) continue;
        if (cl.description) {
          if (!newCreditDescriptions[name]) newCreditDescriptions[name] = {};
          newCreditDescriptions[name][roleEnum] = cl.description;
        }
        if (cl.linked_sections?.length) {
          const sectionIds = cl.linked_sections
            .map(s => secByTitle.get(typeof s === 'string' ? s : (s.section || s.title || '')))
            .filter(Boolean);
          if (sectionIds.length) {
            if (!newCreditLinkedSections[name]) newCreditLinkedSections[name] = {};
            newCreditLinkedSections[name][roleEnum] = sectionIds;
          }
        }
      }
    }

    return { newOrcids, newAffIds, newAffiliations, newSections, newCreditDescriptions, newCreditLinkedSections, newDoi: data.doi || '' };
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
      const { newOrcids, newAffIds, newAffiliations, newSections, newCreditDescriptions, newCreditLinkedSections } = extractPayloadMeta(data);
      authorOrcids = newOrcids;
      authorAffIds = newAffIds;
      affiliations = newAffiliations.length ? newAffiliations : affiliations;
      sections = newSections.length ? newSections : sections;
      creditDescriptions = newCreditDescriptions;
      creditLinkedSections = newCreditLinkedSections;
      const newAssets = Array.isArray(data.assets) ? data.assets.filter(Boolean) : [];
      loadedAssetNames = newAssets;
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
      const { newOrcids, newAffIds, newAffiliations, newSections, newCreditDescriptions, newCreditLinkedSections, newDoi } = extractPayloadMeta(data);
      authorOrcids = newOrcids;
      authorAffIds = newAffIds;
      affiliations = newAffiliations.length ? newAffiliations : affiliations;
      sections = newSections.length ? newSections : sections;
      creditDescriptions = newCreditDescriptions;
      creditLinkedSections = newCreditLinkedSections;
      doi = newDoi;
      doiInput.value = doi;
      const newAssets = Array.isArray(data.assets) ? data.assets.filter(Boolean) : [];
      loadedAssetNames = newAssets;
      renderAssetsTable();
      renderAffiliationsTable();
      renderSectionsTable();
      setRows(loadedRows);
      syncUrl();
      endpointStatus.textContent = `\u2713 Loaded \u201c${project}\u201d \u2014 ${loadedRows.length} contributor(s).`;
      endpointStatus.className = 'contributions-endpoint-status status-success';

      // Apply server-side locked state
      serverLocked = data.locked === true;
      if (serverLocked) {
        projectLocked = true;
        projectLockedCheckbox.checked = true;
        projectLockedCheckbox.disabled = true;
        pwPasswordRow.style.display = '';
        projectPasswordInput.placeholder = 'Password required to save';
        projectPassword = '';
        projectPasswordInput.value = '';
      } else {
        projectLockedCheckbox.disabled = false;
        projectPasswordInput.placeholder = 'Set a password';
      }

      // Collapse assets section \u2014 irrelevant when working with a loaded project
      assetsOpen = false;
      assetsBody.style.display = 'none';
      assetsToggle.setAttribute('aria-expanded', 'false');
      assetsToggle.querySelector('.cv-toggle-icon').textContent = '\u25bc';
      fetchHistory(project);
    } catch (err) {
      endpointStatus.textContent = `Error: ${err.message}`;
      endpointStatus.className = 'contributions-endpoint-status status-error';
      console.error('[contributions-view] GET failed', err);
    } finally {
      updateProjectButtons();
    }
  }

  /**
   * Hash a plaintext password with SHA-256 and return a hex string.
   * Passwords are never sent in plaintext over the wire.
   *
   * @param {string} password
   * @returns {Promise<string>}
   */
  async function hashPassword(password) {
    const encoded = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
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
      const payload = toEndpointPayload(rows, project, { authorOrcids, authorAffIds, affiliations, sections, creditDescriptions, creditLinkedSections, assets: loadedAssetNames, doi });
      let url = `${CONTRIBUTIONS_API_BASE}/contributions/post?project=${encodeURIComponent(project)}`;
      if (projectPassword) {
        const hashed = await hashPassword(projectPassword);
        url += `&password=${encodeURIComponent(hashed)}`;
      }
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
    const hasRows = rows.length > 0;
    // When server has a password, require the user to enter one before saving
    const passwordRequired = serverLocked;
    const hasPassword = projectPasswordInput.value.trim().length > 0;
    postBtn.disabled = !hasProject || !hasRows || (passwordRequired && !hasPassword);
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

  // Shared Details collapsible toggle
  root.querySelector('#cv-shared-details-toggle').addEventListener('click', () => {
    sharedDetailsOpen = !sharedDetailsOpen;
    root.querySelector('#cv-shared-details-body').style.display = sharedDetailsOpen ? '' : 'none';
    root.querySelector('#cv-shared-details-toggle').setAttribute('aria-expanded', String(sharedDetailsOpen));
    root.querySelector('#cv-shared-details-toggle').querySelector('.cv-toggle-icon').textContent = sharedDetailsOpen ? '▲' : '▼';
  });

  // DOI input
  doiInput.addEventListener('input', () => { doi = doiInput.value.trim(); saveDraft(); });

  // Assets tabs
  root.querySelector('#cv-tab-asset-names').addEventListener('click', () => switchAssetsTab('asset-names'));
  root.querySelector('#cv-tab-query').addEventListener('click', () => switchAssetsTab('query'));

  // Load
  loadBtn.addEventListener('click', loadRecords);
  assetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });

  // Project
  getBtn.addEventListener('click', loadFromServer);
  postBtn.addEventListener('click', saveToServer);
  projectNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadFromServer(); });
  projectNameInput.addEventListener('input', () => { syncUrl(); updateProjectButtons(); });

  // Lock toggle + password
  projectLockedCheckbox.addEventListener('change', () => {
    projectLocked = projectLockedCheckbox.checked;
    pwPasswordRow.style.display = projectLocked ? '' : 'none';
    saveDraft();
  });
  projectPasswordInput.addEventListener('input', () => {
    projectPassword = projectPasswordInput.value;
    updateProjectButtons();
    saveDraft();
  });

  // Add author
  root.querySelector('#cv-add-author-btn').addEventListener('click', () => {
    const newRow = { name: 'New Author', isFirst: false };
    for (const cat of CREDIT_CATEGORIES) newRow[cat] = 'None';
    setRows([...rows, newRow]);
  });

  // Author selector dropdown
  root.querySelector('#cv-author-selector').addEventListener('change', (e) => {
    selectedAuthor = e.target.value || null;
    renderAuthorsTable();
    renderAuthorDetail();
    saveDraft();
  });

  // Add affiliation
  root.querySelector('#cv-add-affiliation-btn').addEventListener('click', () => {
    const id = `aff-${Date.now()}`;
    affiliations = [...affiliations, { id, name: '' }];
    renderAffiliationsTable();
    renderAuthorDetail();
    saveDraft();
  });

  root.querySelector('#cv-add-section-btn').addEventListener('click', () => {
    const id = `sec-${Date.now()}`;
    sections = [...sections, { id, title: '' }];
    renderSectionsTable();
    renderAuthorDetail();
    saveDraft();
  });

  // Output tabs
  root.querySelector('#cv-out-tab-preview').addEventListener('click', () => switchOutputTab('preview'));
  root.querySelector('#cv-out-tab-latex').addEventListener('click', () => switchOutputTab('latex'));
  root.querySelector('#cv-out-tab-statement').addEventListener('click', () => switchOutputTab('statement'));
  root.querySelector('#cv-out-tab-matrix-png').addEventListener('click', () => switchOutputTab('matrix-png'));

  matrixPngDownload.addEventListener('click', () => {
    if (rows.length === 0) return;
    const canvas = generateMatrixCanvas(rows);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      const project = projectNameInput.value.trim() || 'contributions';
      a.download = `${project}-matrix.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  });

  // -------------------------------------------------------------------------
  // Initial render
  // -------------------------------------------------------------------------

  renderAffiliationsTable();
  renderSectionsTable();
  buildAuthorsTableHeader();

  // Restore draft or auto-load
  let draftRestored = false;
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const draft = JSON.parse(raw);
      // If the URL specifies a project that differs from the draft, discard the
      // draft and treat the URL as ground truth.
      const draftProject = (draft.projectName || '').trim();
      if (projectName && draftProject && projectName !== draftProject) {
        sessionStorage.removeItem(DRAFT_KEY);
      } else if (draft.rows?.length > 0) {
        assetInput.value = draft.assetNames || '';
        projectNameInput.value = draft.projectName || '';
        if (draft.projectLocked) {
          projectLocked = true;
          projectLockedCheckbox.checked = true;
          pwPasswordRow.style.display = '';
        }
        if (draft.serverLocked) {
          serverLocked = true;
          projectLockedCheckbox.disabled = true;
          projectPasswordInput.placeholder = 'Password required to save';
        }
        if (draft.projectPassword) {
          projectPassword = draft.projectPassword;
          projectPasswordInput.value = draft.projectPassword;
        }
        authorSources = draft.authorSources || {};
        authorOrcids  = draft.authorOrcids  || {};
        authorAffIds  = draft.authorAffIds  || {};
        if (draft.affiliations?.length) affiliations = draft.affiliations;
        if (draft.sections?.length) sections = draft.sections;
        creditDescriptions = draft.creditDescriptions || {};
        creditLinkedSections = draft.creditLinkedSections || {};
        selectedAuthor = draft.selectedAuthor || null;
        doi = draft.doi || '';
        doiInput.value = doi;
        loadedAssetNames = draft.loadedAssetNames || [];
        renderAffiliationsTable();
        renderSectionsTable();
        renderAssetsTable();
        setRows(draft.rows);
        updateAuthorSelector();
        renderAuthorDetail();
        syncUrl();
        draftRestored = true;
      }
    }
  } catch (_) {}

  if (assetName && !draftRestored) {
    Promise.resolve().then(loadRecords);
  }

  if (projectName && !draftRestored) {
    Promise.resolve().then(loadFromServer);
  } else if (draftRestored) {
    const draftProject = projectNameInput.value.trim();
    if (draftProject) {
      Promise.resolve().then(() => fetchHistory(draftProject));
    }
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

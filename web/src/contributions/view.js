/**
 * contributions-view.js — CRediT Author Contribution Matrix page.
 *
 * Pure helpers (parseAssetNames, extractAuthors, initMatrix, formatAuthorForLatex,
 * generateLatex, toEndpointPayload, fromEndpointPayload, rowsToWidgetAuthors)
 * are exported for unit testing.
 *
 * createContributionsView(options) mounts a Preact app and returns a DOM element.
 * Using Preact + htm for stable DOM and targeted updates — no more full teardowns.
 */

import { html, render } from 'htm/preact';
import { Fragment } from 'preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { fetchDocDbRecordsByName } from '../lib/docdb.js';
import { CONTRIBUTIONS_API_BASE } from '../constants.js';
import { createPreview } from './preview.js';
import { CREDIT_ROLES, LEVEL_LABELS, enabledLevels, getLastName } from './credit-helpers.js';
import { RoleTip } from './role-tooltip.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All 14 CRediT taxonomy roles in widget display order. */
export const CREDIT_CATEGORIES = CREDIT_ROLES;

/** Contribution levels in display order (Lead first). */
export const CONTRIBUTION_LEVELS = ['None', 'Lead', 'Equal', 'Supporting'];

/** Maps internal backend level names to the shared display labels. */
export const LEVEL_DISPLAY = Object.fromEntries(
  CONTRIBUTION_LEVELS.map((l) => [l, LEVEL_LABELS[l.toLowerCase()]]),
);


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

export const CREDIT_ROLE_ENUM_REVERSE = Object.fromEntries(
  Object.entries(CREDIT_ROLE_ENUM).map(([k, v]) => [v, k]),
);

const LATEX_LEVEL_VALUES = { None: 0, Supporting: '\\lo', Equal: '\\mid', Lead: '\\hi' };

// Escape characters that are special in LaTeX (currently just `&`).
function escapeLatex(str) {
  return String(str).replace(/&/g, '\\&');
}

const DRAFT_KEY = 'contributions:draft';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

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

export function extractAuthors(records) {
  const authors = [];
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
    if (!authorSources[trimmed].includes(source)) authorSources[trimmed].push(source);
  }

  for (const record of records) {
    const dataDesc = record.data_description ?? {};
    for (const inv of dataDesc.investigators ?? [])
      addName(typeof inv === 'object' ? inv?.name : inv, 'investigators');
    for (const funding of dataDesc.funding_source ?? []) {
      const fundee = funding.fundee;
      if (Array.isArray(fundee)) {
        for (const person of fundee)
          addName(typeof person === 'object' ? person?.name : person, 'funding');
      } else if (typeof fundee === 'string') {
        for (const part of fundee.replace(/ and /gi, ',').split(','))
          addName(part.trim(), 'funding');
      }
    }
    for (const exp of record.acquisition?.experimenters ?? [])
      addName(typeof exp === 'object' ? exp?.name : exp, 'acquisition');
    for (const proc of record.procedures?.subject_procedures ?? [])
      for (const exp of proc.experimenters ?? [])
        addName(typeof exp === 'object' ? exp?.name : exp, 'procedures');
    for (const proc of record.procedures?.specimen_procedures ?? [])
      for (const exp of proc.experimenters ?? [])
        addName(typeof exp === 'object' ? exp?.name : exp, 'procedures');
    for (const process of record.processing?.data_processes ?? [])
      for (const exp of process.experimenters ?? [])
        addName(typeof exp === 'object' ? exp?.name : exp, 'processing');
  }

  return { authors, authorSources };
}

export function initMatrix(authors) {
  return authors.map((name) => {
    const contributions = {};
    for (const cat of CREDIT_CATEGORIES) contributions[cat] = 'None';
    return { name, isFirst: false, ...contributions };
  });
}

export function formatAuthorForLatex(name, isFirst) {
  const parts = name.trim().split(/\s+/);
  const formatted =
    parts.length >= 2 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : name;
  return escapeLatex(isFirst ? `${formatted}*` : formatted);
}

/**
 * TikZ source for the contribution matrix. Like every other display path this
 * obeys the project settings: with `showLevels` off the heatmap is a flat
 * yes/no rather than shaded by a level the reader is not being shown, and rows
 * follow the publication order when the project has one.
 */
export function generateLatex(rows, settings = {}) {
  const showLevels = (settings.showLevels ?? true) && (settings.allowLevels ?? true);
  rows = orderRowsForPublication(rows);

  const colLines = [
    '    % column labels',
    '    \\foreach \\a [count=\\n] in {',
    ...CREDIT_CATEGORIES.map((c) => `        ${escapeLatex(c)},`),
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
      const values = CREDIT_CATEGORIES.map((cat) => {
        const level = row[cat];
        if (!level || level === 'None') return 0;
        return showLevels ? (LATEX_LEVEL_VALUES[level] ?? 0) : LATEX_LEVEL_VALUES.Equal;
      });
      return `        {${values.join(',')}},`;
    }),
    '    } {',
    '        % heatmap tiles',
    '        \\foreach \\x [count=\\m] in \\y {',
    '            \\node[fill=tilecolor!\\x!white, tile, text=white] (tile) at (\\m,-\\n) {};',
    '        }',
    '    }',
  ];
  return [
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
  ].join('\n');
}

/**
 * Fields the editor does not model but must not destroy.
 *
 * The grid edits names, CRediT roles and a handful of display properties;
 * everything else on a stored contributor is invisible to it. Anything
 * invisible that is *not* listed here is silently dropped the first time
 * anyone saves, so a new backend field belongs in one of these lists.
 *
 * `from_asset` is deliberately absent: the backend recomputes it from
 * `linked_assets`, so round-tripping those two is enough.
 * `registry_identifier`, `affiliation` and `email` are absent because the
 * editor does model them, via `authorOrcids` / `authorAffIds` /
 * `authorEmails`.
 */
const AUTHOR_PASSTHROUGH_KEYS = ['other_names', 'registry'];
const ROLE_PASSTHROUGH_KEYS = ['linked_assets', 'linked_sections', 'start_date', 'end_date'];

function isEmptyPassthrough(value) {
  return value == null || (Array.isArray(value) && value.length === 0);
}

export function toEndpointPayload(rows, projectName, meta = {}) {
  const {
    authorOrcids = {},
    authorEmails = {},
    authorAffIds = {},
    affiliations = [],
    sections = [],
    creditDescriptions = {},
    authorStartDates = {},
    authorEndDates = {},
    authorSectionLevels = {},
    assets = [],
    doi = [],
  } = meta;
  const contributors = rows.map((row) => {
    const credit_levels = [];
    for (const displayRole of CREDIT_CATEGORIES) {
      const level = row[displayRole];
      if (level && level !== 'None') {
        const roleEnum = CREDIT_ROLE_ENUM[displayRole];
        const desc = creditDescriptions[row.name]?.[roleEnum];
        credit_levels.push({
          role: roleEnum,
          level: level.toLowerCase(),
          ...(desc ? { description: desc } : {}),
          ...(row._passthrough?.roles?.[roleEnum] || {}),
        });
      }
    }
    const author = { name: row.name, ...(row._passthrough?.author || {}) };
    const orcid = authorOrcids[row.name];
    if (orcid) author.registry_identifier = orcid;
    const email = String(authorEmails[row.name] || '').trim();
    if (email) author.email = email;
    const affIds = authorAffIds[row.name] || [];
    const affNames = affIds.map((id) => affiliations.find((a) => a.id === id)?.name).filter(Boolean);
    if (affNames.length) author.affiliation = affNames;
    const startDate = authorStartDates[row.name];
    const endDate = authorEndDates[row.name];
    const sectionLevels = (authorSectionLevels[row.name] || [])
      .filter((sl) => sl.level && sl.level !== 'None' && sl.level !== 'none');
    return {
      author,
      author_level: row.author_level ?? null,
      ...(row.publication_order != null ? { publication_order: row.publication_order } : {}),
      ...(startDate ? { start_date: startDate } : {}),
      ...(endDate ? { end_date: endDate } : {}),
      ...(row.is_admin ? { is_admin: true } : {}),
      credit_levels,
      ...(sectionLevels.length ? { section_levels: sectionLevels } : {}),
    };
  });
  const topSections = sections.map((s) => s.title).filter(Boolean);
  const topAssets = assets.filter(Boolean);
  // A paper can be published in several venues, so doi is a list. Accept the
  // legacy scalar form from an old draft in localStorage.
  const topDois = (Array.isArray(doi) ? doi : [doi])
    .map((d) => String(d || '').trim())
    .filter(Boolean);
  return {
    project_name: projectName,
    ...(topDois.length ? { doi: topDois } : {}),
    ...(topAssets.length ? { assets: topAssets } : {}),
    ...(topSections.length ? { sections: topSections } : {}),
    contributors,
  };
}

export function fromEndpointPayload(data) {
  return (data.contributors || []).map((contributor) => {
    const row = {
      name: contributor.author?.name ?? '',
      isFirst: false,
      author_level: contributor.author_level ?? null,
      publication_order: contributor.publication_order ?? null,
      is_admin: contributor.is_admin ?? false,
    };
    for (const cat of CREDIT_CATEGORIES) row[cat] = 'None';

    // Stash the fields the editor cannot see so a save puts them back
    // untouched. Keyed by role enum, since that is what toEndpointPayload
    // rebuilds credit_levels from.
    const authorExtras = {};
    for (const key of AUTHOR_PASSTHROUGH_KEYS) {
      const value = contributor.author?.[key];
      if (!isEmptyPassthrough(value)) authorExtras[key] = value;
    }
    const roleExtras = {};

    for (const cl of contributor.credit_levels || []) {
      const displayRole = CREDIT_ROLE_ENUM_REVERSE[cl.role];
      if (displayRole) {
        row[displayRole] = cl.level.charAt(0).toUpperCase() + cl.level.slice(1);
      }
      const extras = {};
      for (const key of ROLE_PASSTHROUGH_KEYS) {
        if (!isEmptyPassthrough(cl[key])) extras[key] = cl[key];
      }
      if (Object.keys(extras).length) roleExtras[cl.role] = extras;
    }

    if (Object.keys(authorExtras).length || Object.keys(roleExtras).length) {
      row._passthrough = { author: authorExtras, roles: roleExtras };
    }
    return row;
  });
}

/**
 * Whether *name* matches an existing contributor row (case-insensitive,
 * trimmed). Used to block an anonymous add wizard from overwriting an
 * existing author's record — they have no identity to own that row, so a
 * name collision would be a silent overwrite the backend won't apply.
 */
export function authorNameExists(rows, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  return (rows || []).some((r) => String(r?.name || '').trim().toLowerCase() === key);
}

export function formatAuthorInitials(name) {
  return name.trim().split(/\s+/).map((p) => (p[0] || '').toUpperCase() + '.').join('');
}

/**
 * CRediT statement plus per-author descriptions.
 *
 * Authors are listed alphabetically by last name, within each role and in the
 * description block — the CRediT convention, and independent of contribution
 * level so the statement never implies a ranking. Ties on last name fall back
 * to the full name so the output is stable.
 */
export function generateContributionStatement(rows, creditDescriptions = {}) {
  const byLastName = [...(rows || [])].sort((a, b) =>
    getLastName(a.name).localeCompare(getLastName(b.name))
      || a.name.localeCompare(b.name));

  const parts = [];
  for (const cat of CREDIT_CATEGORIES) {
    const initials = byLastName
      .filter((row) => row[cat] && row[cat] !== 'None')
      .map((row) => formatAuthorInitials(row.name));
    if (initials.length > 0) parts.push(`${cat}, ${initials.join(', ')}`);
  }
  const statement = parts.join('; ');
  const descLines = [];
  for (const row of byLastName) {
    const perRole = creditDescriptions[row.name];
    if (!perRole) continue;
    const roleDescs = Object.entries(perRole)
      .filter(([, v]) => v && v.trim())
      .map(([roleEnum, v]) => `${CREDIT_ROLE_ENUM_REVERSE[roleEnum] || roleEnum}: ${v.trim()}`);
    if (roleDescs.length)
      descLines.push(`${formatAuthorInitials(row.name)}: ${roleDescs.join('; ')}`);
  }
  return { statement, descriptions: descLines.join('\n') };
}

/**
 * True when the project has a publication order — i.e. at least one row
 * carries a `publication_order`. An empty order is ignored everywhere.
 */
export function hasPublicationOrder(rows) {
  return (rows || []).some((r) => r?.publication_order != null);
}

/**
 * Rows sorted by `publication_order`, with unordered rows keeping their
 * existing relative position at the end. When no row has an order this is a
 * stable no-op, so callers can apply it unconditionally.
 */
export function orderRowsForPublication(rows) {
  return [...(rows || [])].sort((a, b) => {
    const ao = a?.publication_order, bo = b?.publication_order;
    if (ao == null && bo == null) return 0;
    if (ao == null) return 1;
    if (bo == null) return -1;
    return ao - bo;
  });
}

export function rowsToWidgetAuthors(rows) {
  return rows.map((row) => {
    const credit_levels = [];
    for (const displayRole of CREDIT_CATEGORIES) {
      const level = row[displayRole];
      if (level && level !== 'None') {
        credit_levels.push({ role: displayRole, level: level.toLowerCase() });
      }
    }
    return {
      name: row.name,
      author_level: row.author_level ?? null,
      publication_order: row.publication_order ?? null,
      credit_levels,
    };
  });
}

// ---------------------------------------------------------------------------
// generateMatrixCanvas
// ---------------------------------------------------------------------------

/**
 * Render the CRediT matrix to a canvas for PNG export.
 *
 * This is a display path like any other, so it obeys the same project
 * settings as the preview widget: `showLevels` controls whether the cells are
 * shaded by contribution level at all (not just whether a legend is drawn),
 * `allowLead`/`allowLevels` control which tiers may appear, and the rows are
 * laid out in publication order when the project has one.
 */
export function generateMatrixCanvas(rows, settings = {}) {
  const { allowLevels = true, allowLead = true } = settings;
  // Levels can only be shown if the project allows them in the first place.
  const showLevels = (settings.showLevels ?? true) && allowLevels;
  rows = orderRowsForPublication(rows);

  const CELL        = 30;
  const NAME_W      = 170;
  const HEADER_H    = 155;
  const PAD         = 20;
  const LEGEND_GAP  = 28;
  const LEGEND_W    = 76;
  const LEGEND_STEP = 22;
  const FONT_BODY   = 'bold 12px Inter, system-ui, sans-serif';
  const FONT_HDR    = '500 11.5px Inter, system-ui, sans-serif';
  const FONT_LEGEND = '600 11.5px Inter, system-ui, sans-serif';

  const activeRoles = CREDIT_CATEGORIES.filter((cat) =>
    rows.some((row) => row[cat] && row[cat] !== 'None'),
  );

  // Only the tiers this project offers, labelled the way the project labels
  // them — and nothing at all when levels aren't being shown.
  const legendItems = showLevels ? enabledLevels({ allowLevels, allowLead }) : [];

  const gridW   = activeRoles.length * CELL;
  const gridH   = rows.length * CELL;
  // No legend means no legend gutter, otherwise the PNG has dead space where
  // the legend used to be.
  const legendGutter = legendItems.length ? LEGEND_GAP + LEGEND_W : 0;
  const canvasW = PAD + NAME_W + gridW + legendGutter + PAD;
  const canvasH = HEADER_H + gridH + PAD;

  const canvas = document.createElement('canvas');
  const dpr    = Math.ceil(window.devicePixelRatio || 1);
  canvas.width  = canvasW * dpr;
  canvas.height = canvasH * dpr;
  canvas.style.width  = canvasW + 'px';
  canvas.style.height = canvasH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);

  const FILL = {
    Lead:       'rgba(99,102,241,0.75)',
    Equal:      'rgba(99,102,241,0.40)',
    Supporting: 'rgba(99,102,241,0.18)',
  };

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

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    const ry  = HEADER_H + ri * CELL;
    ctx.font         = FONT_BODY;
    ctx.fillStyle    = '#111827';
    ctx.textAlign    = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(row.name, PAD + NAME_W - 8, ry + CELL / 2);
    for (let ci = 0; ci < activeRoles.length; ci++) {
      const level = row[activeRoles[ci]];
      if (!level || level === 'None') continue;
      const cx = PAD + NAME_W + ci * CELL;
      // With levels hidden the matrix is a plain yes/no, so every filled cell
      // gets the same tone — shading by a level the legend no longer explains
      // would leak the hidden data. Matches the widget's `equal` fallback.
      ctx.fillStyle = showLevels ? (FILL[level] || FILL.Supporting) : FILL.Equal;
      ctx.fillRect(cx + 1, ry + 1, CELL - 1, CELL - 1);
    }
  }

  const LEGEND_COLORS = { lead: '#4338ca', equal: '#818cf8', supporting: '#9ca3af' };
  const legendX       = PAD + NAME_W + gridW + LEGEND_GAP;
  const legendTotalH  = legendItems.length * LEGEND_STEP;
  const legendStartY  = HEADER_H + gridH / 2 - legendTotalH / 2 + LEGEND_STEP / 2;
  ctx.font         = FONT_LEGEND;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < legendItems.length; i++) {
    ctx.fillStyle = LEGEND_COLORS[legendItems[i]];
    ctx.fillText(LEVEL_LABELS[legendItems[i]], legendX, legendStartY + i * LEGEND_STEP);
  }

  return canvas;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractPayloadMeta(data) {
  const newSections = [];
  const secByTitle = new Map();
  for (const raw of (Array.isArray(data.sections) ? data.sections : [])) {
    const title = typeof raw === 'string' ? raw : (raw.title || raw.name || '');
    if (!title) continue;
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    secByTitle.set(title, id);
    newSections.push({ id, title });
  }

  const newOrcids = {};
  const newEmails = {};
  const newAffIds = {};
  const newAffiliations = [];
  const newCreditDescriptions = {};
  const newStartDates = {};
  const newEndDates = {};
  const newSectionLevels = {};
  const affByName = new Map();

  for (const contributor of data.contributors || []) {
    const name = contributor.author?.name;
    if (!name) continue;
    const orcid = contributor.author?.registry_identifier;
    if (orcid) newOrcids[name] = orcid;
    const email = contributor.author?.email;
    if (email) newEmails[name] = email;
    const affRaw = contributor.author?.affiliation;
    const affArr = Array.isArray(affRaw)
      ? affRaw
      : typeof affRaw === 'string' && affRaw
      ? [affRaw]
      : [];
    for (const affStr of affArr) {
      if (!affByName.has(affStr)) {
        const id = affStr.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        affByName.set(affStr, id);
        newAffiliations.push({ id, name: affStr });
      }
    }
    if (affArr.length) newAffIds[name] = affArr.map((s) => affByName.get(s)).filter(Boolean);
    for (const cl of contributor.credit_levels || []) {
      const roleEnum = cl.role;
      if (!roleEnum) continue;
      if (cl.description) {
        if (!newCreditDescriptions[name]) newCreditDescriptions[name] = {};
        newCreditDescriptions[name][roleEnum] = cl.description;
      }
    }
    if (contributor.start_date) newStartDates[name] = contributor.start_date;
    if (contributor.end_date) newEndDates[name] = contributor.end_date;
    if (contributor.section_levels?.length) newSectionLevels[name] = contributor.section_levels;
  }
  return {
    newOrcids,
    newEmails,
    newAffIds,
    newAffiliations,
    newSections,
    newCreditDescriptions,
    newStartDates,
    newEndDates,
    newSectionLevels,
    // The server returns a list; tolerate the legacy scalar from old documents.
    newDoi: Array.isArray(data.doi) ? data.doi : (data.doi ? [data.doi] : []),
  };
}

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
    for (const inv of dataDesc.investigators ?? []) addName(inv, 'investigators');
    for (const funding of dataDesc.funding_source ?? []) {
      const fundee = funding.fundee;
      if (Array.isArray(fundee)) {
        for (const p of fundee) addName(p, 'funding');
      } else if (typeof fundee === 'string') {
        for (const part of fundee.replace(/ and /gi, ',').split(',')) addName(part.trim(), 'funding');
      }
    }
    for (const exp of record.acquisition?.experimenters ?? []) addName(exp, 'acquisition');
    for (const proc of record.procedures?.subject_procedures ?? [])
      for (const exp of proc.experimenters ?? []) addName(exp, 'procedures');
    for (const proc of record.procedures?.specimen_procedures ?? [])
      for (const exp of proc.experimenters ?? []) addName(exp, 'procedures');
    for (const process of record.processing?.data_processes ?? [])
      for (const exp of process.experimenters ?? []) addName(exp, 'processing');
  }
  return { authors, authorSources, authorOrcids };
}

// ---------------------------------------------------------------------------
// Preact components
// ---------------------------------------------------------------------------

// ── ChipSelect ──────────────────────────────────────────────────────────────

function ChipSelect({ options, selectedIds, onChange, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const selected  = options.filter((o) => selectedIds.includes(o.id));
  const remaining = options.filter((o) => !selectedIds.includes(o.id));

  return html`
    <div class="cv-chip-select" ref=${wrapRef} aria-label=${ariaLabel}>
      ${selected.map((opt) => html`
        <span key=${opt.id} class="cv-chip" title=${opt.name}>
          <span class="cv-chip-text">${opt.name}</span>
          <button type="button" class="cv-chip-remove" aria-label=${'Remove ' + opt.name}
                  onClick=${(e) => { e.stopPropagation(); onChange(selectedIds.filter((i) => i !== opt.id)); }}>
            ×
          </button>
        </span>
      `)}
      ${remaining.length > 0 && html`
        <div style="position:relative;display:inline-block">
          <button type="button" class="cv-chip-add"
                  onClick=${(e) => { e.stopPropagation(); setOpen((o) => !o); }}>+</button>
          ${open && html`
            <div class="cv-chip-dropdown">
              ${remaining.map((opt) => html`
                <button key=${opt.id} type="button" class="cv-chip-dropdown-item"
                        onMouseDown=${(e) => { e.preventDefault(); onChange([...selectedIds, opt.id]); setOpen(false); }}>
                  ${opt.name}
                </button>
              `)}
            </div>
          `}
        </div>
      `}
    </div>
  `;
}

// ── OrcidSearch ─────────────────────────────────────────────────────────────

function OrcidSearch({ authorName, value, onChange }) {
  const [open, setOpen]       = useState(false);
  const [results, setResults] = useState([]);
  const [busy, setBusy]       = useState(false);
  const [searchMsg, setSearchMsg] = useState('Search');
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  async function search() {
    setBusy(true); setSearchMsg('…');
    try {
      const parts = authorName.trim().split(/\s+/);
      const familyName  = parts[parts.length - 1];
      const givenNames  = parts.slice(0, -1).join('+');
      const q = givenNames
        ? `family-name:${encodeURIComponent(familyName)}+AND+given-names:${encodeURIComponent(givenNames)}`
        : `family-name:${encodeURIComponent(familyName)}`;
      const res = await fetch(`https://pub.orcid.org/v3.0/search/?q=${q}&rows=5`, {
        headers: { Accept: 'application/vnd.orcid+json' },
      });
      if (!res.ok) throw new Error(`ORCID API ${res.status}`);
      const data = await res.json();
      const orcids = (data.result || []).map((r) => r['orcid-identifier']?.path).filter(Boolean);
      setResults(orcids);
      setOpen(orcids.length > 0);
      setSearchMsg(orcids.length ? 'Search' : 'No results');
    } catch (e) {
      setSearchMsg('Error');
    } finally {
      setBusy(false);
    }
  }

  return html`
    <div class="cv-orcid-row" ref=${wrapRef} style="position:relative">
      <input id="cv-detail-orcid" type="text" class="cv-orcid-input"
             placeholder="0000-0000-0000-0000" value=${value || ''}
             onInput=${(e) => onChange(e.target.value)} />
      <button type="button" id="cv-orcid-search-btn" class="btn-secondary cv-orcid-search-btn"
              disabled=${busy} onClick=${search}>${searchMsg}</button>
      ${open && results.length > 0 && html`
        <div class="cv-chip-dropdown cv-orcid-dropdown">
          ${results.map((orcid) => html`
            <div key=${orcid} class="cv-orcid-dropdown-row">
              <button type="button" class="cv-chip-dropdown-item"
                      onMouseDown=${(e) => { e.preventDefault(); onChange(orcid); setOpen(false); }}>
                ${orcid}
              </button>
              <a href=${`https://orcid.org/${orcid}`} target="_blank" rel="noopener noreferrer"
                 class="cv-orcid-verify-link" title="Verify on orcid.org"
                 onMouseDown=${(e) => e.stopPropagation()}>verify ↗</a>
            </div>
          `)}
        </div>
      `}
    </div>
  `;
}

// ── AuthorDetailSection ──────────────────────────────────────────────────────

function AuthorDetailSection({
  row, selectedAuthor, authorOrcids, authorEmails, authorAffIds, affiliations, sections,
  creditDescriptions, authorStartDates, authorEndDates, authorSectionLevels, onChange,
  allowLead, allowLevels,
}) {
  if (!selectedAuthor || !row) {
    return html`
      <section class="cv-section cv-author-detail-section" id="cv-author-detail-section">
        <p class="cv-placeholder">Select an author from the matrix to edit details.</p>
      </section>
    `;
  }

  const activeRoles = CREDIT_CATEGORIES.filter((cat) => row[cat] && row[cat] !== 'None');
  const currentSectionLevels = authorSectionLevels[selectedAuthor] || [];

  function getSectionLevel(sectionTitle) {
    return currentSectionLevels.find((sl) => sl.section === sectionTitle)?.level || 'None';
  }
  function getSectionDescription(sectionTitle) {
    return currentSectionLevels.find((sl) => sl.section === sectionTitle)?.description || '';
  }

  return html`
    <section class="cv-section cv-author-detail-section" id="cv-author-detail-section">
      <div class="cv-author-detail-header">
        <h3 class="cv-section-heading">
          Editing: <span class="cv-detail-name-badge">${selectedAuthor}</span>
        </h3>
      </div>

      <div class="cv-detail-meta-grid">
        <div class="cv-detail-meta-item">
          <label class="cv-detail-label" for="cv-detail-orcid">ORCID iD</label>
          <${OrcidSearch}
            authorName=${selectedAuthor}
            value=${authorOrcids[selectedAuthor] || ''}
            onChange=${(val) => onChange('orcid', val)}
          />
        </div>
        <div class="cv-detail-meta-item">
          <label class="cv-detail-label" for="cv-detail-email">Email</label>
          <input id="cv-detail-email" type="email"
                 class="cv-wizard-input"
                 placeholder="name@example.org"
                 value=${authorEmails[selectedAuthor] || ''}
                 onInput=${(e) => onChange('email', e.target.value)} />
        </div>
        <div class="cv-detail-meta-item">
          <label class="cv-detail-label" for="cv-detail-author-level">Author level</label>
          <select id="cv-detail-author-level" class="cv-author-level-select"
                  value=${row.author_level || ''}
                  onChange=${(e) => onChange('authorLevel', e.target.value || null)}>
            <option value="">\u2014 none \u2014</option>
            <option value="first">first</option>
            <option value="senior">senior</option>
          </select>
        </div>
        <div class="cv-detail-meta-item">
          <label class="cv-detail-label" for="cv-detail-start-date">Join Date</label>
          <input id="cv-detail-start-date" type="date"
                 class="cv-wizard-input"
                 value=${authorStartDates[selectedAuthor] || ''}
                 onChange=${(e) => onChange('startDate', e.target.value || null)} />
        </div>
        <div class="cv-detail-meta-item">
          <label class="cv-detail-label" for="cv-detail-end-date">End Date</label>
          <input id="cv-detail-end-date" type="date"
                 class="cv-wizard-input"
                 value=${authorEndDates[selectedAuthor] || ''}
                 onChange=${(e) => onChange('endDate', e.target.value || null)} />
        </div>
        <div class="cv-detail-meta-item cv-detail-aff-item">
          <label class="cv-detail-label">Affiliations</label>
          <${ChipSelect}
            options=${affiliations}
            selectedIds=${authorAffIds[selectedAuthor] || []}
            onChange=${(ids) => onChange('affiliations', ids)}
            ariaLabel="${selectedAuthor} affiliations"
          />
        </div>
      </div>

      <h4 class="cv-subsection-heading">Contribution Details</h4>
      ${activeRoles.length === 0
        ? html`<p class="cv-placeholder cv-detail-hint">
            No contributions assigned yet — set levels in the matrix above.
          </p>`
        : activeRoles.map((cat) => {
          const roleEnum = CREDIT_ROLE_ENUM[cat];
          return html`
            <div key=${cat} class="cv-credit-card">
              <div class="cv-credit-card-header">
                <span class="cv-credit-role-name"><${RoleTip} name=${cat} /></span>
                ${allowLevels && html`<span class=${'cv-credit-level-badge cv-credit-level-' + row[cat].toLowerCase()}>${LEVEL_DISPLAY[row[cat]] || row[cat]}</span>`}
              </div>
              <label class="cv-detail-label">Description</label>
              <textarea class="cv-credit-desc-textarea" rows="2"
                        placeholder="Describe your specific contribution\u2026"
                        onInput=${(e) => onChange('creditDesc', { roleEnum, value: e.target.value })}>
                ${creditDescriptions[selectedAuthor]?.[roleEnum] || ''}
              </textarea>
            </div>
          `;
        })
      }

        ${sections.length > 0 && html`
        <h4 class="cv-subsection-heading">Section Contributions</h4>
        ${sections.map((sec) => {
          const level = getSectionLevel(sec.title);
          const description = getSectionDescription(sec.title);
          return html`
            <div key=${sec.id} class="cv-section-contrib-row">
              <span class="cv-section-contrib-title">${sec.title}</span>
              <select class="cv-section-contrib-level"
                      value=${level}
                      onChange=${(e) => onChange('sectionLevel', {
                        section: sec.title,
                        level: e.target.value,
                        description,
                      })}>
                <option value="None">\u2014 none \u2014</option>
                ${allowLevels
                  ? enabledLevels({ allowLevels, allowLead }).map((lvl) => html`
                      <option key=${lvl} value=${lvl}>${LEVEL_LABELS[lvl]}</option>
                    `)
                  : html`<option value="equal">contributed</option>`}
              </select>
              ${level !== 'None' && html`
                <input type="text" class="cv-section-contrib-desc"
                       placeholder="Description (optional)"
                       value=${description}
                       onInput=${(e) => onChange('sectionLevel', {
                         section: sec.title,
                         level,
                         description: e.target.value,
                       })} />
              `}
            </div>
          `;
        })}
      `}
    </section>
  `;
}

// ── PublicationOrderEditor ────────────────────────────────────────────────

/**
 * Drag-and-drop editor for the publication byline order.
 *
 * The order is stored as a 1-based `publication_order` on each row. "Unset"
 * means *no* row carries one — in that state every display path falls back to
 * its own default ordering and the preview widget hides its publication-order
 * chip entirely, so this editor must be able to return to it (Clear).
 */
function PublicationOrderEditor({ rows, onReorder, onClear }) {
  // The index is held in a ref as well as state: state drives the drag
  // styling, but the drop handler must read the value synchronously — a
  // state read there can still be null if drop lands before the re-render.
  const dragRef = useRef(null);
  const [dragIdx, setDragIdx] = useState(null);
  const [overIdx, setOverIdx] = useState(null);

  const ordered = useMemo(() => orderRowsForPublication(rows), [rows]);
  const isSet = rows.some((r) => r.publication_order != null);

  function startDrag(idx) { dragRef.current = idx; setDragIdx(idx); }
  function endDrag() { dragRef.current = null; setDragIdx(null); setOverIdx(null); }

  function drop(toIdx) {
    const from = dragRef.current;
    endDrag();
    if (from == null || from === toIdx) return;
    const next = [...ordered];
    const [moved] = next.splice(from, 1);
    next.splice(toIdx, 0, moved);
    onReorder(next.map((r) => r.name));
  }

  if (!rows.length) {
    return html`<p class="cv-placeholder cv-detail-hint">Add authors first, then order them here.</p>`;
  }

  return html`
    <div class="cv-pub-order">
      <p class="cv-detail-hint">
        ${isSet
          ? 'Drag to reorder. This order is used wherever authors are listed.'
          : 'No publication order set — displays fall back to their own default order. Drag an author to set one.'}
      </p>
      <ol class="cv-pub-order-list">
        ${ordered.map((row, idx) => html`
          <li key=${row.name}
              class=${'cv-pub-order-item'
                + (dragIdx === idx ? ' cv-pub-order-dragging' : '')
                + (overIdx === idx && dragIdx !== idx ? ' cv-pub-order-over' : '')}
              draggable="true"
              onDragStart=${() => startDrag(idx)}
              onDragEnd=${endDrag}
              onDragOver=${(e) => { e.preventDefault(); setOverIdx(idx); }}
              onDrop=${(e) => { e.preventDefault(); drop(idx); }}>
            <span class="cv-pub-order-handle" aria-hidden="true">⠿</span>
            <span class="cv-pub-order-num">${idx + 1}</span>
            <span class="cv-pub-order-name">${row.name || '(unnamed)'}</span>
          </li>
        `)}
      </ol>
      <div class="cv-pub-order-actions">
        ${isSet
          ? html`<button class="btn-secondary cv-add-row-btn" onClick=${onClear}>
                   Clear publication order
                 </button>`
          : html`<button class="btn-secondary cv-add-row-btn"
                         onClick=${() => onReorder(ordered.map((r) => r.name))}>
                   Set publication order
                 </button>`}
      </div>
    </div>
  `;
}

// ── ProjectSettingsSection ────────────────────────────────────────────────

function ProjectSettingsSection({
  open, onToggle,
  showSections, onShowSectionsChange,
  showLevels, onShowLevelsChange,
  showTimeline, onShowTimelineChange,
  allowLead, onAllowLeadChange,
  allowLevels, onAllowLevelsChange,
  isAdmin, editLocked, onEditLockedChange,
  rows, onToggleRowAdmin, onReorderPublication, onClearPublicationOrder,
}) {
  function handleAllowLevels(val) {
    onAllowLevelsChange(val);
    if (!val) onShowLevelsChange(false);
  }

  return html`
    <section class="cv-section cv-settings-section">
      <button class="cv-section-toggle" id="cv-settings-toggle"
              aria-expanded=${String(open)} onClick=${onToggle}>
        <span class="cv-section-title">Project Settings</span>
        <span class="cv-toggle-icon">${open ? '\u25b2' : '\u25bc'}</span>
      </button>
      ${open && html`
        <div class="cv-section-body">
          <div class="cv-settings-grid">
            <div class="cv-settings-group">
              <h4 class="cv-subsection-heading">Display settings</h4>
              <label class="cv-settings-label">
                <input type="checkbox" checked=${showSections}
                       onChange=${(e) => onShowSectionsChange(e.target.checked)} />
                <span>Show sections tab in preview</span>
              </label>
              <label class="cv-settings-label">
                <input type="checkbox" checked=${showLevels} disabled=${!allowLevels}
                       onChange=${(e) => onShowLevelsChange(e.target.checked)} />
                <span>Show contribution levels in preview</span>
              </label>
              <label class="cv-settings-label">
                <input type="checkbox" checked=${showTimeline}
                       onChange=${(e) => onShowTimelineChange(e.target.checked)} />
                <span>Show timeline tab in preview</span>
              </label>
            </div>
            <div class="cv-settings-group">
              <h4 class="cv-subsection-heading">Author workflow</h4>
              <label class="cv-settings-label">
                <input type="checkbox" checked=${allowLevels}
                       onChange=${(e) => handleAllowLevels(e.target.checked)} />
                <span>Allow contribution levels (++/+) in add workflow and editor</span>
              </label>
              <label class="cv-settings-label">
                <input type="checkbox" checked=${allowLead} disabled=${!allowLevels}
                       onChange=${(e) => onAllowLeadChange(e.target.checked)} />
                <span>Allow Lead designation in add workflow and editor</span>
              </label>
            </div>
            <div class="cv-settings-group cv-settings-group-wide">
              <h4 class="cv-subsection-heading">Publication order</h4>
              <${PublicationOrderEditor} rows=${rows}
                onReorder=${onReorderPublication}
                onClear=${onClearPublicationOrder} />
            </div>
            ${isAdmin && html`
              <div class="cv-settings-group">
                <h4 class="cv-subsection-heading">Access (admin)</h4>
                <label class="cv-settings-label">
                  <input type="checkbox" checked=${editLocked}
                         onChange=${(e) => onEditLockedChange(e.target.checked)} />
                  <span>Lock project — prevent all edits until an admin unlocks</span>
                </label>
                <div class="cv-admins-list">
                  <span class="cv-admins-label">Project admins</span>
                  ${rows.length === 0
                    ? html`<p class="cv-placeholder cv-detail-hint">Add authors first, then grant admin here.</p>`
                    : rows.map((r) => html`
                        <label key=${r.name} class="cv-settings-label">
                          <input type="checkbox" checked=${!!r.is_admin}
                                 onChange=${(e) => onToggleRowAdmin(r.name, e.target.checked)} />
                          <span>${r.name || '(unnamed)'}</span>
                        </label>
                      `)}
                </div>
              </div>
            `}
          </div>
        </div>
      `}
    </section>
  `;
}

// ── SharedDetailsSection ─────────────────────────────────────────────────────

function SharedDetailsSection({
  open, onToggle, doi, onDoiChange,
  affiliations, onAffiliationsChange, sections, onSectionsChange,
}) {
  // `doi` is a list; tolerate a legacy scalar restored from an old draft.
  const dois = Array.isArray(doi) ? doi : (doi ? [doi] : []);
  function addDoi() { onDoiChange([...dois, '']); }
  function removeDoi(idx) { onDoiChange(dois.filter((_, i) => i !== idx)); }
  function updateDoi(idx, value) {
    onDoiChange(dois.map((d, i) => (i === idx ? value : d)));
  }

  function addAffiliation() {
    onAffiliationsChange([...affiliations, { id: `aff-${Date.now()}`, name: '' }]);
  }
  function removeAffiliation(idx) {
    onAffiliationsChange(affiliations.filter((_, i) => i !== idx));
  }
  function updateAffiliationName(idx, name) {
    onAffiliationsChange(affiliations.map((a, i) => i === idx ? { ...a, name } : a));
  }
  function addSection() {
    onSectionsChange([...sections, { id: `sec-${Date.now()}`, title: '' }]);
  }
  function removeSection(idx) {
    onSectionsChange(sections.filter((_, i) => i !== idx));
  }
  function updateSectionTitle(idx, title) {
    onSectionsChange(sections.map((s, i) => i === idx ? { ...s, title } : s));
  }

  return html`
    <section class="cv-section cv-shared-details-section">
      <button class="cv-section-toggle" id="cv-shared-details-toggle"
              aria-expanded=${String(open)} onClick=${onToggle}>
        <span class="cv-section-title">Shared Details</span>
        <span class="cv-toggle-icon">${open ? '\u25b2' : '\u25bc'}</span>
      </button>
      ${open && html`
        <div class="cv-section-body">
          <div class="cv-doi-block">
            <label class="cv-detail-label" for="cv-doi-input-0">DOIs</label>
            <p class="cv-detail-hint">
              A project may be published in more than one venue — add a DOI for each.
            </p>
            ${dois.length === 0
              ? html`<p class="cv-placeholder cv-detail-hint">No DOIs yet.</p>`
              : dois.map((d, idx) => html`
                  <div key=${idx} class="cv-doi-row">
                    <button class="cv-x-btn" aria-label=${'Remove DOI ' + (d || idx + 1)}
                            onClick=${() => removeDoi(idx)}>×</button>
                    <input id=${'cv-doi-input-' + idx} type="text" class="cv-doi-input"
                           placeholder="e.g. 10.1234/example.2024" value=${d}
                           onInput=${(e) => updateDoi(idx, e.target.value)} />
                  </div>
                `)}
            <button id="cv-add-doi-btn" class="btn-secondary cv-add-row-btn"
                    onClick=${addDoi}>+ Add DOI</button>
          </div>
          <div class="cv-meta-columns">
            <div class="cv-affiliations-section">
              <h4 class="cv-subsection-heading">Affiliations</h4>
              <table class="cv-affiliations-table">
                <thead><tr><th></th><th>Affiliation</th></tr></thead>
                <tbody>
                  ${affiliations.map((aff, idx) => html`
                    <tr key=${aff.id}>
                      <td>
                        <button class="cv-x-btn" aria-label=${'Remove ' + aff.name}
                                onClick=${() => removeAffiliation(idx)}>×</button>
                      </td>
                      <td>
                        <input type="text" value=${aff.name} class="cv-aff-name-input"
                               onInput=${(e) => updateAffiliationName(idx, e.target.value)} />
                      </td>
                    </tr>
                  `)}
                </tbody>
              </table>
              <button id="cv-add-affiliation-btn" class="btn-secondary cv-add-row-btn"
                      onClick=${addAffiliation}>+ Add affiliation</button>
            </div>
            <div class="cv-sections-section">
              <h4 class="cv-subsection-heading">Paper Sections</h4>
              <table class="cv-sections-table">
                <thead><tr><th></th><th>Title</th></tr></thead>
                <tbody>
                  ${sections.map((sec, idx) => html`
                    <tr key=${sec.id}>
                      <td>
                        <button class="cv-x-btn" aria-label=${'Remove section ' + sec.title}
                                onClick=${() => removeSection(idx)}>×</button>
                      </td>
                      <td>
                        <input type="text" value=${sec.title} class="cv-sec-title-input"
                               placeholder="e.g. Introduction"
                               onInput=${(e) => updateSectionTitle(idx, e.target.value)} />
                      </td>
                    </tr>
                  `)}
                </tbody>
              </table>
              <button id="cv-add-section-btn" class="btn-secondary cv-add-row-btn"
                      onClick=${addSection}>+ Add section</button>
            </div>
          </div>
        </div>
      `}
    </section>
  `;
}

// ── PreviewPanel ─────────────────────────────────────────────────────────────

function PreviewPanel({ rows, authorOrcids, authorAffIds, affiliations, sections, authorSectionLevels, showSections, showLevels, showTimeline, allowLead, allowLevels }) {
  const containerRef = useRef(null);

  const authors = useMemo(() =>
    rowsToWidgetAuthors(rows).map((a) => {
      const affIds   = authorAffIds[a.name] || [];
      const affNames = affIds.map((id) => affiliations.find((af) => af.id === id)?.name).filter(Boolean);
      const sectionContribs = (authorSectionLevels[a.name] || [])
        .filter((sl) => sl.level && sl.level !== 'None' && sl.level !== 'none')
        .map((sl) => ({ section: sl.section, level: sl.level, ...(sl.description ? { description: sl.description } : {}) }));
      return {
        ...a,
        orcid: authorOrcids[a.name] || undefined,
        affiliations: affNames.length ? affNames : undefined,
        section_contributions: sectionContribs.length ? sectionContribs : undefined,
      };
    }),
  [rows, authorOrcids, authorAffIds, affiliations, sections, authorSectionLevels]);

  useEffect(() => {
    if (containerRef.current) {
      createPreview(containerRef.current, authors,
        { showSections, showLevels, showTimeline, allowLead, allowLevels });
    }
  }, [authors, showSections, showLevels, showTimeline, allowLead, allowLevels]);

  return html`<div ref=${containerRef} id="cv-preview-container"></div>`;
}

// ── OutputSection ──────────────────────────────────────────────────────────

function OutputSection({
  activeTab, onTabChange, rows, authorOrcids, authorAffIds, affiliations,
  sections, authorSectionLevels, creditDescriptions, projectName,
  showSections, showLevels, showTimeline, allowLead, allowLevels,
}) {
  function LaTeXPanel() {
    return html`<pre class="contributions-latex-output">${generateLatex(rows, { showLevels, allowLevels })}</pre>`;
  }

  function StatementPanel() {
    const { statement, descriptions } = generateContributionStatement(rows, creditDescriptions);
    return html`
      <${Fragment}>
        <p class="cv-statement-label">CRediT contribution statement</p>
        <textarea class="contributions-statement-output" readonly>${statement}</textarea>
        <p class="cv-statement-label cv-statement-label-descriptions">Individual contribution descriptions</p>
        <textarea class="contributions-statement-output contributions-descriptions-output" readonly>${descriptions}</textarea>
      <//>
    `;
  }

  function MatrixPngPanel() {
    const canvasRef = useRef(null);
    const pngSettings = { showLevels, allowLead, allowLevels };
    useEffect(() => {
      if (canvasRef.current && rows.length > 0) {
        canvasRef.current.innerHTML = '';
        canvasRef.current.appendChild(generateMatrixCanvas(rows, pngSettings));
      }
      // Re-draw when the data or any setting that affects it changes —
      // an empty dep list left the preview showing a stale image.
    }, [rows, showLevels, allowLead, allowLevels]);

    function download() {
      if (!rows.length) return;
      generateMatrixCanvas(rows, pngSettings).toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${projectName || 'contributions'}-matrix.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');
    }

    return html`
      <${Fragment}>
        <div class="cv-matrix-png-toolbar">
          <button class="btn-primary" onClick=${download}>Download PNG</button>
        </div>
        <div class="cv-matrix-png-preview" ref=${canvasRef}></div>
      <//>
    `;
  }

  const TABS = [
    { id: 'preview',    label: 'Preview' },
    { id: 'latex',      label: 'Generate LaTeX' },
    { id: 'statement',  label: 'Contribution Statement' },
    { id: 'matrix-png', label: 'Download PNG' },
  ];

  return html`
    <section class="cv-section cv-output-section" id="cv-output-section">
      <div class="cv-tabs" role="tablist">
        ${TABS.map(({ id, label }) => html`
          <button key=${id} class=${'cv-tab' + (activeTab === id ? ' cv-tab-active' : '')}
                  id=${'cv-out-tab-' + id} role="tab" aria-selected=${String(activeTab === id)}
                  onClick=${() => onTabChange(id)}>
            ${label}
          </button>
        `)}
      </div>
      ${rows.length === 0
        ? html`<p class="cv-placeholder" style="padding:16px">Load assets or a project to see output.</p>`
        : html`
          <div class="cv-tab-panel">
            ${activeTab === 'preview'    && html`<${PreviewPanel}
              rows=${rows} authorOrcids=${authorOrcids} authorAffIds=${authorAffIds}
              affiliations=${affiliations} sections=${sections}
              authorSectionLevels=${authorSectionLevels}
              showSections=${showSections} showLevels=${showLevels} showTimeline=${showTimeline}
              allowLead=${allowLead} allowLevels=${allowLevels} />`}
            ${activeTab === 'latex'      && html`<${LaTeXPanel} />`}
            ${activeTab === 'statement'  && html`<${StatementPanel} />`}
            ${activeTab === 'matrix-png' && html`<${MatrixPngPanel} />`}
          </div>
        `
      }
    </section>
  `;
}

// ── HistorySection ─────────────────────────────────────────────────────────

function HistorySection({ commits, selectedCommit, onSelectCommit }) {
  if (!commits.length) return null;
  return html`
    <section class="cv-history-section">
      <div class="cv-history-header">
        <span class="cv-section-title">Version History</span>
        <span class="cv-history-hint">${commits.length} version${commits.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="subject-timeline-bubbles">
        ${commits.map((entry, i) => {
          const hash    = entry.commit ?? entry.sha ?? entry.hash ?? '';
          const rawDate = entry.date ?? entry.committed_date ?? entry.timestamp ?? entry.authored_date ?? '';
          const date    = rawDate ? new Date(rawDate) : null;
          const isSelected = selectedCommit === hash;
          return html`
            <button key=${hash || i}
                    class=${'tl-bubble' + (isSelected ? ' tl-bubble--selected' : '')}
                    style="--bubble-color:#4338ca" onClick=${() => onSelectCommit(hash)}>
              <span class="tl-bubble-dot"></span>
              <span class="tl-bubble-type">${hash ? hash.slice(0, 8) : `v${i + 1}`}</span>
              <span class="tl-bubble-date">
                ${date && !isNaN(date)
                  ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                  : (entry.message ? String(entry.message).slice(0, 20) : '')}
              </span>
            </button>
          `;
        })}
      </div>
    </section>
  `;
}

// ── ProjectWidget ──────────────────────────────────────────────────────────

function ProjectWidget({
  projectName, onProjectNameChange, endpointStatus,
  canLoad, canSave, onLoad, onSave,
}) {
  return html`
    <div class="cv-project-widget">
      <div class="cv-pw-name-row">
        <label for="cv-project-name">Project</label>
        <input id="cv-project-name" type="text" placeholder="e.g. my-project-2024"
               value=${projectName}
               onInput=${(e) => onProjectNameChange(e.target.value)}
               onKeyDown=${(e) => e.key === 'Enter' && canLoad && onLoad()} />
      </div>
      <div class="cv-pw-btn-row">
        <button id="cv-get-btn" class="btn-secondary" disabled=${!canLoad} onClick=${onLoad}>Load</button>
        <button id="cv-post-btn" class="btn-primary"  disabled=${!canSave} onClick=${onSave}>Save</button>
      </div>
      ${endpointStatus.text && html`
        <div class=${'contributions-endpoint-status ' + endpointStatus.cls} aria-live="polite">
          ${endpointStatus.text}
        </div>
      `}
    </div>
  `;
}

// ── AuthorRow ──────────────────────────────────────────────────────────────

function AuthorRow({ row, rowIdx, isActive, onRemove, onRename, onCategoryChange, allowLead, allowLevels }) {
  const levels = allowLevels
    ? (allowLead ? CONTRIBUTION_LEVELS : CONTRIBUTION_LEVELS.filter((l) => l !== 'Lead'))
    : ['None', 'Equal'];

  return html`
    <tr class=${isActive ? 'cv-row-active' : ''}>
      <td>
        <button class="cv-x-btn" aria-label=${'Remove ' + row.name}
                onClick=${() => onRemove(rowIdx)}>×</button>
      </td>
      <td>
        <input type="text" value=${row.name} class="cv-author-name-input"
               onBlur=${(e) => onRename(rowIdx, e.target.value)} />
      </td>
      ${CREDIT_CATEGORIES.map((cat) => html`
        <td key=${cat} class=${'cell-center cell-' + (row[cat] || 'None').toLowerCase()}>
          ${allowLevels
            ? html`<select aria-label=${row.name + ' \u2014 ' + cat}
                    value=${row[cat]}
                    onChange=${(e) => onCategoryChange(rowIdx, cat, e.target.value)}>
                ${levels.map((level) => html`
                  <option key=${level} value=${level}>${LEVEL_DISPLAY[level] || level}</option>
                `)}
              </select>`
            : html`<input type="checkbox"
                    aria-label=${row.name + ' \u2014 ' + cat}
                    checked=${row[cat] !== 'None'}
                    onChange=${(e) => onCategoryChange(rowIdx, cat, e.target.checked ? 'Equal' : 'None')} />`
          }
        </td>
      `)}
    </tr>
  `;
}

// ── ContributionsApp (root) ────────────────────────────────────────────────

const DEFAULT_AFFILIATIONS = [
  { id: 'aind', name: 'Allen Institute for Neural Dynamics, Seattle, WA' },
];

/**
 * CopyContributorLink — blue button that copies the public self-add link
 * (`/contributions/add?project=…`). Any ORCID-authenticated contributor who
 * opens it can add/edit their own author row; no invite token is needed.
 */
function CopyContributorLink({ project }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/contributions/add?project=${encodeURIComponent(project)}`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_) { /* clipboard unavailable */ }
  }
  return html`
    <button type="button" class="btn-primary cv-add-row-btn cv-copy-contributor-link"
            title=${link} onClick=${copy}>
      ${copied ? '✓ Link copied' : 'Copy link for contributors to add themselves'}
    </button>
  `;
}

function ContributionsApp({ initialProjectName, initialAssetName, initialDraft, docdbOptions, actionsRef, isAdmin, isNew, currentUser }) {
  // ── State ────────────────────────────────────────────────────────────────
  const [rows, setRows]                       = useState(initialDraft?.rows || []);
  const [selectedAuthor, setSelectedAuthor]   = useState(initialDraft?.selectedAuthor || null);
  const [authorSources, setAuthorSources]     = useState(initialDraft?.authorSources || {});
  const [authorOrcids, setAuthorOrcids]       = useState(initialDraft?.authorOrcids || {});
  const [authorEmails, setAuthorEmails]       = useState(initialDraft?.authorEmails || {});
  const [authorAffIds, setAuthorAffIds]       = useState(initialDraft?.authorAffIds || {});
  const [affiliations, setAffiliations]       = useState(initialDraft?.affiliations?.length ? initialDraft.affiliations : DEFAULT_AFFILIATIONS);
  const [sections, setSections]               = useState(initialDraft?.sections || []);
  const [creditDescs, setCreditDescs]         = useState(initialDraft?.creditDescriptions || {});
  const [authorStartDates, setAuthorStartDates] = useState(initialDraft?.authorStartDates || {});
  const [authorEndDates, setAuthorEndDates] = useState(initialDraft?.authorEndDates || {});
  const [authorSectionLevels, setAuthorSectionLevels] = useState(initialDraft?.authorSectionLevels || {});
  const [loadedAssets, setLoadedAssets]       = useState(initialDraft?.loadedAssetNames || []);
  // A list — a project may be published in several venues. Drafts saved before
  // that change hold a single string, so normalise on restore.
  const [doi, setDoi]                         = useState(
    Array.isArray(initialDraft?.doi) ? initialDraft.doi
      : (initialDraft?.doi ? [initialDraft.doi] : []));
  const [projectName, setProjectName]         = useState(initialDraft?.projectName || initialProjectName);
  const [assetsOpen, setAssetsOpen]           = useState(true);
  const [sharedOpen, setSharedOpen]           = useState(false);
  const [settingsOpen, setSettingsOpen]       = useState(false);
  const [activeOutputTab, setActiveOutputTab] = useState('preview');
  const [activeAssetsTab, setActiveAssetsTab] = useState('asset-names');
  const [assetInput, setAssetInput]           = useState(initialAssetName || '');
  const [assetInfo, setAssetInfo]             = useState('');
  const [loadingAssets, setLoadingAssets]     = useState(false);
  const [endpointStatus, setEndpointStatus]   = useState({ text: '', cls: '' });
  const [historyCommits, setHistoryCommits]   = useState([]);
  const [selectedCommit, setSelectedCommit]   = useState(null);
  const [showSections, setShowSections]       = useState(initialDraft?.showSections ?? false);
  const [showLevels, setShowLevels]           = useState(initialDraft?.showLevels ?? true);
  const [showTimeline, setShowTimeline]       = useState(initialDraft?.showTimeline ?? false);
  const [allowLead, setAllowLead]             = useState(initialDraft?.allowLead ?? true);
  const [allowLevels, setAllowLevels]         = useState(initialDraft?.allowLevels ?? true);
  const [editLocked, setEditLocked]           = useState(initialDraft?.editLocked ?? false);
  const [existsOnServer, setExistsOnServer]   = useState(initialDraft?.existsOnServer ?? false);

  // Ref to latest state values — safe to read in async handlers
  const sr = useRef({});
  sr.current = { rows, selectedAuthor, authorSources, authorOrcids, authorEmails, authorAffIds,
    affiliations, sections, creditDescs, authorStartDates, authorEndDates, authorSectionLevels,
    loadedAssets, doi, projectName,
    showSections, showLevels, showTimeline, allowLead, allowLevels, editLocked };

  // ── Draft persistence ────────────────────────────────────────────────────
  useEffect(() => {
    if (rows.length === 0) { sessionStorage.removeItem(DRAFT_KEY); return; }
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
        projectName, rows, selectedAuthor, authorSources, authorOrcids, authorEmails, authorAffIds,
        affiliations, sections, creditDescriptions: creditDescs,
        authorStartDates, authorEndDates, authorSectionLevels,
        loadedAssetNames: loadedAssets, doi,
        showSections, showLevels, showTimeline, allowLead, allowLevels, editLocked,
        existsOnServer,
      }));
    } catch (_) {}
  }, [rows, selectedAuthor, authorSources, authorOrcids, authorEmails, authorAffIds, affiliations, sections,
    creditDescs, authorStartDates, authorEndDates, authorSectionLevels, loadedAssets, doi, projectName,
    showSections, showLevels, showTimeline, allowLead, allowLevels, editLocked, existsOnServer]);

  // ── URL sync ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (projectName) params.set('project', projectName); else params.delete('project');
    params.delete('asset_name');
    const qs = params.toString();
    history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
  }, [projectName]);

  // ── Asset loading ─────────────────────────────────────────────────────────
  async function loadRecords() {
    const names = parseAssetNames(sr.current.assetInput ?? assetInput);
    if (!names.length) { setAssetInfo('Enter at least one asset name.'); return; }
    setLoadingAssets(true);
    const existing = new Set(sr.current.loadedAssets);
    setLoadedAssets((prev) => [...prev, ...names.filter((n) => !existing.has(n))]);
    setAssetInfo(`Loading ${names.length} asset(s)\u2026`);
    try {
      const records = await fetchDocDbRecordsByName(names, docdbOptions);
      const { authors, authorSources: srcs, authorOrcids: orcids } = extractAuthorsWithOrcids(records);
      setAuthorSources((prev) => {
        const next = { ...prev };
        for (const [name, sources] of Object.entries(srcs)) {
          if (!next[name]) next[name] = [];
          for (const src of sources) if (!next[name].includes(src)) next[name].push(src);
        }
        return next;
      });
      setAuthorOrcids((prev) => {
        const next = { ...prev };
        for (const [name, orcid] of Object.entries(orcids)) if (!next[name]) next[name] = orcid;
        return next;
      });
      const existingNames = new Set(sr.current.rows.map((r) => r.name));
      const newAuthors = authors.filter((a) => !existingNames.has(a));
      setAssetInfo(`${records.length} record(s) loaded \u2014 ${newAuthors.length} new author(s) added.`);
      setAssetInput('');
      setRows((prev) => [...prev, ...initMatrix(newAuthors)]);
    } catch (err) {
      setAssetInfo(`Error: ${err.message}`);
    } finally {
      setLoadingAssets(false);
    }
  }

  // ── Project load ──────────────────────────────────────────────────────────
  async function loadFromServer() {
    const project = sr.current.projectName;
    if (!project) { setEndpointStatus({ text: 'Enter a project name first.', cls: 'status-error' }); return; }
    setEndpointStatus({ text: `Fetching \u201c${project}\u201d\u2026`, cls: 'status-loading' });
    try {
      const loadUrl = `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(project)}`;
      const res = await fetch(loadUrl);
      if (res.status === 404) throw new Error(`Project \u201c${project}\u201d not found on server.`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      const loadedRows = fromEndpointPayload(data);
      const { newOrcids, newEmails, newAffIds, newAffiliations, newSections, newCreditDescriptions,
        newStartDates, newEndDates, newSectionLevels, newDoi } = extractPayloadMeta(data);
      setAuthorSources({});
      setAuthorOrcids(newOrcids);
      setAuthorEmails(newEmails);
      setAuthorAffIds(newAffIds);
      if (newAffiliations.length) setAffiliations(newAffiliations);
      if (newSections.length) setSections(newSections);
      setCreditDescs(newCreditDescriptions);
      setAuthorStartDates(newStartDates);
      setAuthorEndDates(newEndDates);
      setAuthorSectionLevels(newSectionLevels);
      setDoi(newDoi);
      setLoadedAssets(Array.isArray(data.assets) ? data.assets.filter(Boolean) : []);
      setRows(loadedRows);
      setEndpointStatus({
        text: `\u2713 Loaded \u201c${project}\u201d \u2014 ${loadedRows.length} contributor(s).`,
        cls: 'status-success',
      });
      setShowSections(data.show_sections ?? false);
      setShowLevels(data.show_levels ?? true);
      setShowTimeline(data.show_timeline ?? false);
      setAllowLead(data.allow_lead ?? true);
      setAllowLevels(data.allow_levels ?? true);
      setEditLocked(data.edit_locked ?? false);
      setExistsOnServer(true);
      setAssetsOpen(false);
      fetchHistory(project);
    } catch (err) {
      console.error('[contributions] load failed:', err);
      setEndpointStatus({ text: `Error: ${err.message}`, cls: 'status-error' });
    }
  }

  // ── Project save ──────────────────────────────────────────────────────────
  async function saveToServer({ allowEmpty = false } = {}) {
    const { projectName: project, rows: r, authorOrcids: orc, authorEmails: eml, authorAffIds: affIds,
      affiliations: affs, sections: secs, creditDescs: cds,
      authorStartDates: startDates, authorSectionLevels: secLevels,
      loadedAssets: assets, doi: d,
      showSections: ss, showLevels: sl, showTimeline: st, allowLead: al, allowLevels: alv,
      editLocked: el } = sr.current;
    if (!project || (!r.length && !allowEmpty)) return;
    setEndpointStatus({ text: `Saving \u201c${project}\u201d\u2026`, cls: 'status-loading' });
    try {
      const payload = toEndpointPayload(r, project, {
        authorOrcids: orc, authorEmails: eml, authorAffIds: affIds, affiliations: affs,
        sections: secs, creditDescriptions: cds,
        authorStartDates: startDates, authorSectionLevels: secLevels,
        assets, doi: d,
      });
      payload.show_sections = ss;
      payload.show_levels = sl;
      payload.show_timeline = st;
      payload.edit_locked = el;
      payload.allow_lead = al;
      payload.allow_levels = alv;
      const url = `${CONTRIBUTIONS_API_BASE}/contributions/post?project=${encodeURIComponent(project)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // Members/admins save via their ORCID session cookie.
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }
      const result = await res.json();
      const commit = result.commit ? ` (commit: ${result.commit.slice(0, 8)})` : '';
      setEndpointStatus({
        text: `\u2713 Saved \u201c${project}\u201d${commit}`,
        cls: 'status-success',
      });
      setExistsOnServer(true);
      fetchHistory(project);
    } catch (err) {
      console.error('[contributions] save failed:', err);
      setEndpointStatus({ text: `Error: ${err.message}`, cls: 'status-error' });
    }
  }

  // ── Version history ───────────────────────────────────────────────────────
  async function fetchHistory(project) {
    try {
      const res = await fetch(
        `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(project)}&history=true`,
      );
      if (!res.ok) { setHistoryCommits([]); return; }
      const data = await res.json();
      const commits = Array.isArray(data) ? data : (data.commits ?? data.history ?? []);
      setHistoryCommits(commits);
      if (commits.length)
        setSelectedCommit(commits[0].commit ?? commits[0].sha ?? commits[0].hash ?? '');
    } catch (_) {
      setHistoryCommits([]);
    }
  }

  async function loadVersion(commit) {
    const project = sr.current.projectName;
    if (!project || !commit) return;
    setEndpointStatus({ text: `Loading version ${commit.slice(0, 8)}\u2026`, cls: 'status-loading' });
    try {
      const res = await fetch(
        `${CONTRIBUTIONS_API_BASE}/contributions/get?project=${encodeURIComponent(project)}&commit=${encodeURIComponent(commit)}`,
      );
      if (res.status === 404) throw new Error('Version not found.');
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      const loadedRows = fromEndpointPayload(data);
      const { newOrcids, newEmails, newAffIds, newAffiliations, newSections,
        newCreditDescriptions, newStartDates, newEndDates, newSectionLevels } = extractPayloadMeta(data);
      setAuthorOrcids(newOrcids);
      setAuthorEmails(newEmails);
      setAuthorAffIds(newAffIds);
      if (newAffiliations.length) setAffiliations(newAffiliations);
      if (newSections.length) setSections(newSections);
      setCreditDescs(newCreditDescriptions);
      setAuthorStartDates(newStartDates);
      setAuthorEndDates(newEndDates);
      setAuthorSectionLevels(newSectionLevels);
      setLoadedAssets(Array.isArray(data.assets) ? data.assets.filter(Boolean) : []);
      setRows(loadedRows);
      setEndpointStatus({
        text: `\u2713 Loaded version ${commit.slice(0, 8)} \u2014 ${loadedRows.length} contributor(s).`,
        cls: 'status-success',
      });
    } catch (err) {
      setEndpointStatus({ text: `Error: ${err.message}`, cls: 'status-error' });
    }
  }


  // ── Row mutations ──────────────────────────────────────────────────────────
  function removeRow(idx) {
    const removed = sr.current.rows[idx];
    if (sr.current.selectedAuthor === removed.name) setSelectedAuthor(null);
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  function renameRow(idx, newName) {
    const { rows: r, authorOrcids: orc, authorEmails: eml, authorAffIds: affIds,
      creditDescs: cds, authorSectionLevels: secLevs, authorSources: srcs, selectedAuthor: sel } = sr.current;
    const oldName = r[idx]?.name;
    if (!newName || !oldName || newName === oldName) return;
    setRows((prev) => prev.map((row, i) => i === idx ? { ...row, name: newName } : row));
    if (orc[oldName])  setAuthorOrcids((p)  => { const n = { ...p, [newName]: p[oldName] }; delete n[oldName]; return n; });
    if (eml[oldName])  setAuthorEmails((p)   => { const n = { ...p, [newName]: p[oldName] }; delete n[oldName]; return n; });
    if (affIds[oldName]) setAuthorAffIds((p) => { const n = { ...p, [newName]: p[oldName] }; delete n[oldName]; return n; });
    if (cds[oldName])  setCreditDescs((p)   => { const n = { ...p, [newName]: p[oldName] }; delete n[oldName]; return n; });
    if (secLevs[oldName]) setAuthorSectionLevels((p) => { const n = { ...p, [newName]: p[oldName] }; delete n[oldName]; return n; });
    if (srcs[oldName]) setAuthorSources((p) => { const n = { ...p, [newName]: p[oldName] }; delete n[oldName]; return n; });
    if (sel === oldName) setSelectedAuthor(newName);
  }

  function updateCategory(idx, cat, value) {
    setRows((prev) => prev.map((row, i) => i === idx ? { ...row, [cat]: value } : row));
  }

  function handleDetailChange(kind, payload) {
    const author = sr.current.selectedAuthor;
    if (!author) return;
    if (kind === 'orcid') {
      setAuthorOrcids((prev) => ({ ...prev, [author]: payload }));
    } else if (kind === 'email') {
      setAuthorEmails((prev) => ({ ...prev, [author]: payload }));
    } else if (kind === 'authorLevel') {
      setRows((prev) => prev.map((r) => r.name === author ? { ...r, author_level: payload } : r));
    } else if (kind === 'affiliations') {
      setAuthorAffIds((prev) => ({ ...prev, [author]: payload }));
    } else if (kind === 'startDate') {
      setAuthorStartDates((prev) => ({ ...prev, [author]: payload }));
    } else if (kind === 'endDate') {
      setAuthorEndDates((prev) => ({ ...prev, [author]: payload }));
    } else if (kind === 'sectionLevel') {
      const { section, level, description } = payload;
      setAuthorSectionLevels((prev) => {
        const current = prev[author] || [];
        const idx = current.findIndex((sl) => sl.section === section);
        let next;
        if (!level || level === 'None' || level === 'none') {
          next = current.filter((sl) => sl.section !== section);
        } else if (idx >= 0) {
          next = current.map((sl, i) => i === idx ? { section, level, ...(description ? { description } : {}) } : sl);
        } else {
          next = [...current, { section, level, ...(description ? { description } : {}) }];
        }
        return { ...prev, [author]: next };
      });
    } else if (kind === 'creditDesc') {
      setCreditDescs((prev) => ({
        ...prev,
        [author]: { ...(prev[author] || {}), [payload.roleEnum]: payload.value },
      }));
    }
  }

  // Create a brand-new project: seed the logged-in user as the project's admin
  // contributor, then save so that admin membership is persisted explicitly
  // (not relying on any backend side effect).
  async function createNewProject() {
    setEndpointStatus({ text: 'Creating new project\u2026', cls: 'status-loading' });
    const me = currentUser;
    const adminName = (me?.name || me?.orcid || '').trim();
    if (adminName) {
      const adminRow = { name: adminName, isFirst: false, author_level: null, is_admin: true };
      for (const cat of CREDIT_CATEGORIES) adminRow[cat] = 'None';
      const seededRows = [adminRow];
      const seededOrcids = me?.orcid ? { [adminName]: me.orcid } : {};
      // Reflect in the UI…
      setRows(seededRows);
      setAuthorOrcids(seededOrcids);
      setSelectedAuthor(adminName);
      // …and in the ref the imminent save reads from (state updates are async).
      sr.current.rows = seededRows;
      sr.current.authorOrcids = seededOrcids;
    }
    await saveToServer({ allowEmpty: true });
  }

  // Expose imperative handles for auto-load scheduling in createContributionsView
  actionsRef.loadRecords    = loadRecords;
  actionsRef.loadFromServer = loadFromServer;
  actionsRef.createNewProject = createNewProject;
  actionsRef.fetchHistory   = fetchHistory;

  // ── Derived ────────────────────────────────────────────────────────────────
  const hasProject = projectName.trim().length > 0;
  const canLoad    = hasProject;
  const canSave    = hasProject && rows.length > 0;
  const selectedRow = rows.find((r) => r.name === selectedAuthor) || null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return html`
    <div class="contributions-view">

      <div class="cv-topbar">
        <${HistorySection}
          commits=${historyCommits}
          selectedCommit=${selectedCommit}
          onSelectCommit=${(hash) => { setSelectedCommit(hash); loadVersion(hash); }}
        />
        <${ProjectWidget}
          projectName=${projectName}
          onProjectNameChange=${setProjectName}
          endpointStatus=${endpointStatus}
          canLoad=${canLoad}
          canSave=${canSave}
          onLoad=${loadFromServer}
          onSave=${saveToServer}
        />
      </div>

      <section class="cv-section cv-assets-section">
        <button class="cv-section-toggle" id="cv-assets-toggle"
                aria-expanded=${String(assetsOpen)} onClick=${() => setAssetsOpen((o) => !o)}>
          <span class="cv-section-title">Data Assets</span>
          <span class="cv-toggle-icon">${assetsOpen ? '\u25b2' : '\u25bc'}</span>
        </button>
        ${assetsOpen && html`
          <div class="cv-section-body">
            <div class="cv-tabs" role="tablist">
              ${['asset-names', 'query'].map((t) => html`
                <button key=${t} class=${'cv-tab' + (activeAssetsTab === t ? ' cv-tab-active' : '')}
                        role="tab" aria-selected=${String(activeAssetsTab === t)}
                        onClick=${() => setActiveAssetsTab(t)}>
                  ${t === 'asset-names' ? 'Asset Names' : 'Query'}
                </button>
              `)}
            </div>
            ${activeAssetsTab === 'asset-names' && html`
              <div class="cv-asset-input-row">
                <input id="cv-asset-names" type="text"
                       placeholder="e.g. my_project_2024-01-01, another_asset"
                       value=${assetInput}
                       onInput=${(e) => setAssetInput(e.target.value)}
                       onKeyDown=${(e) => e.key === 'Enter' && loadRecords()} />
                <button id="cv-load-btn" class="btn-primary"
                        disabled=${loadingAssets} onClick=${loadRecords}>
                  ${loadingAssets ? 'Loading\u2026' : 'Add assets'}
                </button>
              </div>
            `}
            ${activeAssetsTab === 'query' && html`
              <p class="cv-placeholder">Query interface coming soon.</p>
            `}
            ${loadedAssets.length > 0 && html`
              <div class="cv-assets-table-wrap">
                <table class="cv-assets-table">
                  <thead><tr><th>Associated assets</th></tr></thead>
                  <tbody>
                    ${loadedAssets.map((name) => html`<tr key=${name}><td>${name}</td></tr>`)}
                  </tbody>
                </table>
              </div>
            `}
            ${assetInfo && html`<div class="cv-info" aria-live="polite">${assetInfo}</div>`}
          </div>
        `}
      </section>

      <${SharedDetailsSection}
        open=${sharedOpen}
        onToggle=${() => setSharedOpen((o) => !o)}
        doi=${doi}
        onDoiChange=${setDoi}
        affiliations=${affiliations}
        onAffiliationsChange=${setAffiliations}
        sections=${sections}
        onSectionsChange=${(newSecs) => {
          const wasEmpty = sections.filter((s) => s.title.trim()).length === 0;
          const nowHas = newSecs.filter((s) => s.title.trim()).length > 0;
          if (wasEmpty && nowHas) setShowSections(true);
          setSections(newSecs);
        }}
      />

      <${ProjectSettingsSection}
        open=${settingsOpen}
        onToggle=${() => setSettingsOpen((o) => !o)}
        showSections=${showSections} onShowSectionsChange=${setShowSections}
        showLevels=${showLevels} onShowLevelsChange=${setShowLevels}
        showTimeline=${showTimeline} onShowTimelineChange=${setShowTimeline}
        allowLead=${allowLead} onAllowLeadChange=${setAllowLead}
        allowLevels=${allowLevels} onAllowLevelsChange=${(val) => {
          setAllowLevels(val);
          if (!val) setShowLevels(false);
        }}
        isAdmin=${isAdmin}
        editLocked=${editLocked} onEditLockedChange=${setEditLocked}
        rows=${rows}
        onToggleRowAdmin=${(name, val) =>
          setRows((prev) => prev.map((r) => r.name === name ? { ...r, is_admin: val } : r))}
        onReorderPublication=${(names) => setRows((prev) => {
          // `names` is the full byline, front to back — renumber from 1.
          const rank = new Map(names.map((n, i) => [n, i + 1]));
          return prev.map((r) => ({ ...r, publication_order: rank.get(r.name) ?? null }));
        })}
        onClearPublicationOrder=${() =>
          setRows((prev) => prev.map((r) => ({ ...r, publication_order: null })))}
      />

      <section class="cv-section cv-contributors-section">
        <div class="cv-contributors-header">
          <h3 class="cv-section-heading">Contributors</h3>
          ${rows.length > 0 && html`
            <div class="cv-author-selector-wrap">
              <label for="cv-author-selector" class="cv-selector-label">Edit as:</label>
              <select id="cv-author-selector" class="cv-author-select"
                      value=${selectedAuthor || ''}
                      onChange=${(e) => setSelectedAuthor(e.target.value || null)}>
                <option value="">\u2014 select author \u2014</option>
                ${rows.map((r) => html`<option key=${r.name} value=${r.name}>${r.name}</option>`)}
              </select>
            </div>
          `}
        </div>
        <div class="cv-authors-table-wrap">
          <div class="cv-table-scroll" id="cv-authors-table-scroll">
            <table class="cv-authors-table">
              <thead>
                <tr id="cv-authors-thead-row">
                  <th></th>
                  <th>Name</th>
                  ${CREDIT_CATEGORIES.map((cat) => html`<th key=${cat}><${RoleTip} name=${cat} /></th>`)}
                </tr>
              </thead>
              <tbody id="cv-authors-tbody">
                ${rows.map((row, idx) => html`
                  <${AuthorRow}
                    key=${row.name + '-' + idx}
                    row=${row}
                    rowIdx=${idx}
                    isActive=${selectedAuthor === row.name}
                    onRemove=${removeRow}
                    onRename=${renameRow}
                    onCategoryChange=${updateCategory}
                    allowLead=${allowLead}
                    allowLevels=${allowLevels}
                  />
                `)}
              </tbody>
            </table>
          </div>
          <div class="cv-add-row-actions">
            <button class="btn-secondary cv-add-row-btn" onClick=${() => {
              const newRow = { name: 'New Author', isFirst: false, author_level: null };
              for (const cat of CREDIT_CATEGORIES) newRow[cat] = 'None';
              setRows((prev) => [...prev, newRow]);
            }}>+ Add author</button>
            ${isAdmin && projectName && html`<${CopyContributorLink} project=${projectName} />`}
          </div>
        </div>
      </section>

      <${AuthorDetailSection}
        row=${selectedRow}
        selectedAuthor=${selectedAuthor}
        authorOrcids=${authorOrcids}
        authorEmails=${authorEmails}
        authorAffIds=${authorAffIds}
        affiliations=${affiliations}
        sections=${sections}
        creditDescriptions=${creditDescs}
        authorStartDates=${authorStartDates}
        authorEndDates=${authorEndDates}
        authorSectionLevels=${authorSectionLevels}
        onChange=${handleDetailChange}
        allowLead=${allowLead}
        allowLevels=${allowLevels}
      />

      <${OutputSection}
        activeTab=${activeOutputTab}
        onTabChange=${setActiveOutputTab}
        rows=${rows}
        authorOrcids=${authorOrcids}
        authorAffIds=${authorAffIds}
        affiliations=${affiliations}
        sections=${sections}
        authorSectionLevels=${authorSectionLevels}
        creditDescriptions=${creditDescs}
        projectName=${projectName}
        showSections=${showSections}
        showLevels=${showLevels}
        showTimeline=${showTimeline}
        allowLead=${allowLead}
        allowLevels=${allowLevels}
      />

    </div>
  `;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Mount the contributions page into a new <div> and return it.
 *
 * @param {object} [options]
 * @param {string}   [options.assetName='']    Comma-separated asset names to pre-load.
 * @param {string}   [options.projectName='']  Project name to pre-load.
 * @param {object}   [options.docdbOptions={}] Options forwarded to fetchDocDbRecordsByName.
 * @returns {HTMLElement}
 */
export function createContributionsView(options = {}) {
  const { assetName = '', projectName = '', docdbOptions = {}, isAdmin = false, isNew = false, currentUser = null } = options;

  // Restore draft synchronously before first render.
  // Drafts are only kept for projects that don't exist on the server yet —
  // existing projects always re-fetch from the server on mount.
  let draftRestored = false;
  let initialDraft = null;
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (raw) {
      const draft = JSON.parse(raw);
      const draftProject = (draft.projectName || '').trim();
      const isForeignProject = draftProject && projectName !== draftProject;
      // Treat missing flag as "server-known" so legacy drafts are discarded
      // and the server is always the source of truth for existing projects.
      const isServerKnown = draft.existsOnServer !== false;
      if (isForeignProject || isServerKnown) {
        sessionStorage.removeItem(DRAFT_KEY);
      } else if (draft.rows?.length > 0) {
        initialDraft = draft;
        draftRestored = true;
      }
    }
  } catch (_) {}

  // actionsRef is populated synchronously during the first Preact render pass
  const actionsRef = {};
  const container = document.createElement('div');

  render(
    html`<${ContributionsApp}
      initialProjectName=${projectName}
      initialAssetName=${assetName}
      initialDraft=${initialDraft}
      docdbOptions=${docdbOptions}
      actionsRef=${actionsRef}
      isAdmin=${isAdmin}
      isNew=${isNew}
      currentUser=${currentUser}
    />`,
    container,
  );

  // Schedule async auto-loads — same microtask timing as before
  if (assetName && !draftRestored) {
    Promise.resolve().then(() => actionsRef.loadRecords?.());
  }
  if (isNew && !draftRestored) {
    // New project: don't try to load (it 404s) — create it so the creator is
    // registered as admin on the backend.
    Promise.resolve().then(() => actionsRef.createNewProject?.());
  } else if (projectName && !draftRestored) {
    Promise.resolve().then(() => actionsRef.loadFromServer?.());
  } else if (draftRestored && initialDraft?.projectName) {
    Promise.resolve().then(() => actionsRef.fetchHistory?.(initialDraft.projectName));
  }

  return container;
}

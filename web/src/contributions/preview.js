/**
 * preview.js — Authorship widget preview for the Contributions page.
 *
 * Adapted from https://github.com/AllenNeuralDynamics/AuthorshipExtractor
 * (MIT License, Jérôme Lecoq et al.)
 *
 * Modifications vs. the upstream widget:
 *   - "Collaboration" (chord diagram / network) tab removed
 *   - "Timeline" tab removed
 *   - CRediT matrix is transposed: authors are rows, roles are columns
 *   - No dataset-switcher (single data source from the page state)
 *   - Exported as createPreview(container, authors) rather than anywidget render()
 *   - Added "Explore" tab: force-directed network via explore.js
 */

// To disable the Explore tab: comment out the line below and the 'explore' tab case in buildWidget().
import { createExploreView } from './explore.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const ALL_CREDIT_ROLES = [
  'Conceptualization', 'Methodology', 'Software', 'Validation',
  'Formal analysis', 'Investigation', 'Resources', 'Data curation',
  'Writing – original draft', 'Writing – review & editing',
  'Visualization', 'Supervision', 'Project Administration', 'Funding Acquisition',
];

const ROLE_ICONS = {
  'Conceptualization': '💡', 'Methodology': '🔬', 'Software': '💻',
  'Validation': '✅', 'Formal analysis': '📊', 'Investigation': '🔍',
  'Resources': '🧰', 'Data curation': '🗄️',
  'Writing – original draft': '✍️',
  'Writing – review & editing': '📝',
  'Visualization': '📈',
  'Supervision': '👥', 'Project Administration': '📋', 'Funding Acquisition': '💰',
};

const AVATAR_COLORS = [
  '#4f46e5', '#0d9488', '#7c3aed', '#d97706',
  '#e11d48', '#059669', '#1e40af', '#4338ca',
];

const LEVEL_RANK = { lead: 3, equal: 2, supporting: 1 };

// ─── CSS injection ──────────────────────────────────────────────────────────

let _cssInjected = false;

function ensureWidgetCSS() {
  if (_cssInjected) return;
  _cssInjected = true;

  // Fetch and inject the upstream authorship-widget.css plus our overrides
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://cdn.jsdelivr.net/gh/AllenNeuralDynamics/AuthorshipExtractor@main/authorship-widget.css';
  document.head.appendChild(link);

  // Google Fonts – Inter
  const fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap';
  document.head.appendChild(fontLink);

  // Local overrides: flipped matrix column headers + author-row cells
  const style = document.createElement('style');
  style.id = 'ae-preview-overrides';
  style.textContent = `
    /* Matrix centering — override upstream width:100% */
    .ae-matrix-wrap {
      overflow-x: auto;
    }
    .ae-matrix {
      width: auto !important;
    }
    /* Flipped matrix: role headers as columns */
    .ae-matrix-role-col-th {
      padding: 2px 2px 0;
      vertical-align: bottom;
      text-align: center;
      min-width: 28px;
      width: 28px;
    }
    .ae-matrix-role-col-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding-bottom: 6px;
    }
    .ae-matrix-role-col-label {
      writing-mode: vertical-lr;
      transform: rotate(180deg);
      font-size: 11px;
      font-weight: 500;
      color: #4b5563;
      max-height: 90px;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.2;
    }
    /* Author sticky row-header cell */
    .ae-matrix-author-row-td {
      background: #fff;
      padding: 4px 12px 4px 4px;
      border-bottom: 1px solid #f9fafb;
      white-space: nowrap;
      text-align: right;
    }
    .ae-matrix-author-row-name {
      font-size: 11px;
      font-weight: 500;
      color: #374151;
      cursor: pointer;
    }
    .ae-matrix-author-row-name:hover {
      color: #4338ca;
      text-decoration: underline;
    }
    /* Corner cell (empty top-left) */
    .ae-matrix-corner-cell {
      background: #fff;
    }
    /* Dark mode overrides */
    .ae-dark .ae-matrix-role-col-label { color: #9ca3af; }
    .ae-dark .ae-matrix-author-row-td { background: #1f2937; border-bottom-color: #374151; }
    .ae-dark .ae-matrix-author-row-name { color: #d1d5db; }
    .ae-dark .ae-matrix-author-row-name:hover { color: #a5b4fc; }
    .ae-dark .ae-matrix-corner-cell { background: #1f2937; }
    .ae-dark .ae-matrix { --ae-matrix-bg: #1f2937; }
    /* Preview wrapper */
    .ae-preview-wrap {
      margin-top: 24px;
      padding-top: 20px;
      border-top: 2px solid #e5e7eb;
    }
    .ae-preview-wrap h3 {
      font-size: 15px;
      font-weight: 600;
      color: #374151;
      margin: 0 0 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    /* Profile cards */
    .ae-profile-card {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 14px 16px;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
      background: #fff;
      margin-bottom: 10px;
    }
    .ae-dark .ae-profile-card { background: #1f2937; border-color: #374151; }
    .ae-profile-info { flex: 1; min-width: 0; }
    .ae-profile-name-row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 3px;
    }
    .ae-profile-name { font-size: 14px; font-weight: 700; color: #111827; }
    .ae-dark .ae-profile-name { color: #f3f4f6; }
    .ae-career-stage { font-size: 11px; color: #6b7280; }
    .ae-orcid-badge { display: inline-flex; align-items: center; text-decoration: none; }
    .ae-orcid-badge:hover svg { opacity: 0.8; }
    .ae-profile-aff { font-size: 12px; color: #6b7280; margin: 0 0 6px; }
    .ae-dark .ae-profile-aff { color: #9ca3af; }
    .ae-profile-roles { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
    .ae-profile-sections { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 6px; }
    .ae-profile-sections-label { font-size: 11px; color: #6b7280; margin-right: 2px; }
    .ae-section-badge { padding: 2px 7px; border-radius: 8px; font-size: 10px; font-weight: 500; background: #e0f2fe; color: #0369a1; white-space: nowrap; }
    .ae-dark .ae-section-badge { background: #075985; color: #bae6fd; }
    .ae-avatar {
      width: 44px; height: 44px; border-radius: 50%;
      color: #fff; font-size: 14px; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; position: relative;
    }
    .ae-avatar-badge {
      position: absolute; bottom: -2px; right: -2px;
      background: #f59e0b; border-radius: 50%;
      width: 16px; height: 16px; font-size: 9px;
      display: flex; align-items: center; justify-content: center; color: #fff;
    }
      padding: 32px;
      text-align: center;
      color: #9ca3af;
      font-size: 13px;
      font-style: italic;
      border: 1px dashed #e5e7eb;
      border-radius: 10px;
    }
    /* Vertical colored-word legend */
    .ae-matrix-legend {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      gap: 6px;
      padding: 0 0 0 20px;
      flex-shrink: 0;
    }
    .ae-legend-word {
      font-size: 12px;
      font-weight: 600;
    }
    .ae-legend-word-lead { color: #4338ca; }
    .ae-legend-word-equal { color: #818cf8; }
    .ae-legend-word-supporting { color: #9ca3af; }
    .ae-dark .ae-legend-word-lead { color: #a5b4fc; }
    .ae-dark .ae-legend-word-equal { color: #818cf8; }
    .ae-dark .ae-legend-word-supporting { color: #6b7280; }
    /* Author-level group labels */
    .ae-level-group-label {
      font-size: 11px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .ae-level-group-sep {
      font-size: 12px;
      color: #d1d5db;
      margin: 0 4px;
    }
    .ae-dark .ae-level-group-label { color: #9ca3af; }
    .ae-dark .ae-level-group-sep { color: #4b5563; }
    /* Author levels toggle switch */
    .ae-author-levels-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 8px;
      cursor: pointer;
      user-select: none;
    }
    .ae-toggle-track {
      width: 32px;
      height: 18px;
      border-radius: 9px;
      background: #d1d5db;
      position: relative;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .ae-toggle-track.ae-toggle-on {
      background: #4338ca;
    }
    .ae-toggle-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2);
      transition: transform 0.2s;
    }
    .ae-toggle-track.ae-toggle-on .ae-toggle-thumb {
      transform: translateX(14px);
    }
    .ae-toggle-label {
      font-size: 12px;
      color: #374151;
      white-space: nowrap;
    }
    .ae-dark .ae-toggle-track { background: #4b5563; }
    .ae-dark .ae-toggle-track.ae-toggle-on { background: #4338ca; }
    .ae-dark .ae-toggle-label { color: #d1d5db; }
    /* Shared authorship symbols */
    .ae-author-level-sym {
      font-size: 10px;
      font-weight: 600;
      color: #6b7280;
      margin-left: 1px;
    }
    .ae-dark .ae-author-level-sym { color: #9ca3af; }
    /* Author level legend */
    .ae-author-level-legend {
      margin-top: 10px;
      font-size: 11px;
      color: #6b7280;
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    .ae-dark .ae-author-level-legend { color: #9ca3af; }
  `;
  document.head.appendChild(style);
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
}

function getColor(name) {
  return AVATAR_COLORS[hashStr(name) % AVATAR_COLORS.length];
}

function getInitials(name) {
  const parts = name.split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getLastName(name) {
  const parts = name.split(/\s+/);
  return parts[parts.length - 1];
}

function getFirstName(name) {
  const parts = name.split(/\s+/);
  return parts[0];
}

function normalizeRole(r) {
  return r.toLowerCase().replace(/\s+/g, ' ').replace(/—/g, '–').trim();
}

function rolesMatch(a, b) {
  return normalizeRole(a) === normalizeRole(b);
}

function findCreditLevel(author, roleName) {
  if (!author.credit_levels) return null;
  const found = author.credit_levels.find(cl => rolesMatch(cl.role, roleName));
  return found ? found.level : null;
}

function el(tag, attrs, ...children) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'className') e.className = v;
      else if (k === 'innerHTML') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
  }
  for (const c of children) {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  }
  return e;
}

// ─── Author hover popover ────────────────────────────────────────────────────

let _popoverEl = null;
let _popoverTimeout = null;
let _popoverStyleInjected = false;

function ensurePopoverStyles() {
  if (_popoverStyleInjected) return;
  _popoverStyleInjected = true;
  const style = document.createElement('style');
  style.id = 'ae-popover-styles';
  style.textContent = `
    .ae-popover {
      position: fixed; z-index: 10000; width: 260px;
      background: rgba(255,255,255,0.97); backdrop-filter: blur(12px);
      border: 1px solid #e5e7eb; border-radius: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06);
      padding: 12px; font-family: 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      font-size: 12px; color: #111827; pointer-events: auto;
      animation: ae-pop-in 0.15s ease-out;
    }
    @keyframes ae-pop-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
    .ae-popover-header { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
    .ae-popover-avatar { width:32px; height:32px; border-radius:50%; color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
    .ae-popover-info { min-width:0; }
    .ae-popover-name { font-size:13px; font-weight:600; color:#111827; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .ae-popover-stage { font-size:11px; color:#6b7280; }
    .ae-popover-aff { font-size:11px; color:#6b7280; line-height:1.3; margin-bottom:8px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
    .ae-popover-roles { display:flex; flex-wrap:wrap; gap:3px; margin-bottom:6px; }
    .ae-popover-role { padding:2px 6px; border-radius:8px; font-size:10px; font-weight:500; color:#fff; white-space:nowrap; }
    .ae-popover-role-lead { background:#4338ca; }
    .ae-popover-role-equal { background:#a5b4fc; color:#312e81; }
    .ae-popover-role-supporting { background:#e5e7eb; color:#4b5563; }
    .ae-popover-role-more { background:#f3f4f6; color:#6b7280; }
    .ae-popover-stats { display:flex; gap:12px; font-size:10px; color:#9ca3af; border-top:1px solid #f3f4f6; padding-top:6px; }
    @media (prefers-reduced-motion:reduce) { .ae-popover { animation:none; } }
    html[data-theme="dark"] .ae-popover { background:rgba(31,41,55,0.97); border-color:#4b5563; box-shadow:0 8px 24px rgba(0,0,0,0.3),0 2px 8px rgba(0,0,0,0.2); color:#e5e7eb; }
    html[data-theme="dark"] .ae-popover-name { color:#f3f4f6; }
    html[data-theme="dark"] .ae-popover-stage { color:#9ca3af; }
    html[data-theme="dark"] .ae-popover-aff { color:#9ca3af; }
    html[data-theme="dark"] .ae-popover-role-equal { background:#4338ca; color:#c7d2fe; }
    html[data-theme="dark"] .ae-popover-role-supporting { background:#4b5563; color:#d1d5db; }
    html[data-theme="dark"] .ae-popover-role-more { background:#374151; color:#9ca3af; }
    html[data-theme="dark"] .ae-popover-stats { color:#9ca3af; border-top-color:#374151; }
  `;
  document.head.appendChild(style);
}

function attachAuthorPopover(element, author) {
  element.style.cursor = 'pointer';
  element.addEventListener('mouseenter', () => {
    clearTimeout(_popoverTimeout);
    _popoverTimeout = setTimeout(() => {
      if (element.isConnected) showPopover(element, author);
    }, 250);
  });
  element.addEventListener('mouseleave', () => {
    clearTimeout(_popoverTimeout);
    _popoverTimeout = setTimeout(hidePopover, 200);
  });
}

function showPopover(anchor, author) {
  hidePopover();
  ensurePopoverStyles();
  const color = getColor(author.name);
  const pop = el('div', { className: 'ae-popover' });
  pop.addEventListener('mouseenter', () => clearTimeout(_popoverTimeout));
  pop.addEventListener('mouseleave', () => {
    clearTimeout(_popoverTimeout);
    _popoverTimeout = setTimeout(hidePopover, 150);
  });

  const header = el('div', { className: 'ae-popover-header' });
  header.appendChild(el('div', {
    className: 'ae-popover-avatar',
    style: { backgroundColor: color },
  }, getInitials(author.name)));
  const info = el('div', { className: 'ae-popover-info' });
  info.appendChild(el('div', { className: 'ae-popover-name' }, author.name));
  if (author.career_stage) {
    info.appendChild(el('div', { className: 'ae-popover-stage' }, author.career_stage));
  }
  header.appendChild(info);
  pop.appendChild(header);

  if (author.affiliations?.length) {
    const affText = author.affiliations
      .map(a => typeof a === 'string' ? a : (a.name || a))
      .join(' · ');
    pop.appendChild(el('div', { className: 'ae-popover-aff' }, affText));
  }

  const credits = author.credit_levels || [];
  if (credits.length) {
    const badges = el('div', { className: 'ae-popover-roles' });
    for (const cr of credits) {
      badges.appendChild(el('span', {
        className: `ae-popover-role ae-popover-role-${cr.level}`,
      }, cr.role.replace('Writing – ', 'W: ').replace('Formal ', 'F. ')));
    }
    pop.appendChild(badges);
  }

  const secs = (author.section_contributions || []).length;
  const figs = (author.figure_contributions || []).length;
  if (credits.length || secs || figs) {
    const stats = el('div', { className: 'ae-popover-stats' });
    if (credits.length) stats.appendChild(el('span', {}, `${credits.length} roles`));
    if (secs) stats.appendChild(el('span', {}, `${secs} sections`));
    if (figs) stats.appendChild(el('span', {}, `${figs} figures`));
    pop.appendChild(stats);
  }

  document.body.appendChild(pop);
  _popoverEl = pop;

  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let top = rect.bottom + 6;
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  if (left < 8) left = 8;
  if (left + popRect.width > window.innerWidth - 8) left = window.innerWidth - 8 - popRect.width;
  if (top + popRect.height > window.innerHeight - 8) {
    top = rect.top - popRect.height - 6;
  }
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
}

function hidePopover() {
  if (_popoverEl) {
    _popoverEl.remove();
    _popoverEl = null;
  }
}

// ─── Sort logic ──────────────────────────────────────────────────────────────

function sortAuthors(authors, sortKey) {
  const sorted = [...authors];

  if (sortKey.startsWith('credit:')) {
    const roleName = sortKey.slice(7);
    return sorted.sort((a, b) => {
      const aRank = LEVEL_RANK[findCreditLevel(a, roleName)] || 0;
      const bRank = LEVEL_RANK[findCreditLevel(b, roleName)] || 0;
      if (bRank !== aRank) return bRank - aRank;
      return getLastName(a.name).localeCompare(getLastName(b.name));
    });
  }

  switch (sortKey) {
    case 'alpha':
      return sorted.sort((a, b) => getLastName(a.name).localeCompare(getLastName(b.name)));
    case 'most-roles':
      return sorted.sort((a, b) => (b.credit_levels?.length || 0) - (a.credit_levels?.length || 0));
    default:
      return sorted;
  }
}

// ─── Main render ─────────────────────────────────────────────────────────────

/**
 * Create or update the preview widget inside `container`.
 *
 * @param {HTMLElement} container - Host element to render into.
 * @param {Array<{name:string, credit_levels:Array<{role:string,level:string}>}>} authors
 *   Author objects in widget format.
 */
export function createPreview(container, authors) {
  ensureWidgetCSS();

  // Remove previous widget if any
  const prev = container.querySelector('.ae-widget');
  if (prev) prev.remove();

  if (!authors || authors.length === 0) {
    container.innerHTML = '';
    const empty = el('div', { className: 'ae-preview-empty' },
      'Load assets and assign contributions to see the preview.');
    container.appendChild(empty);
    return;
  }

  // ── Dark mode detection ──
  function detectDarkMode() {
    const html = document.documentElement;
    if (html.getAttribute('data-theme') === 'dark') return true;
    if (html.classList.contains('dark')) return true;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  let isDark = detectDarkMode();

  // State
  let sortKey = 'alpha';
  let expanded = true;
  let activeTab = container.dataset.cvTab || 'explore';
  let showCreditMenu = false;
  let searchQuery = '';
  let useAuthorLevels = container.dataset.cvUseAuthorLevels === 'true';
  // Cleanup function for the Explore tab's network view (cancelled on tab switch)
  let exploreCleanup  = null;
  // Persists zoom/pan across tab switches; reset to null only when authors change entirely
  let exploreZoomState = null;

  function matchesSearch(author, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    if (author.name.toLowerCase().includes(q)) return true;
    if (author.affiliations) {
      for (const aff of author.affiliations) {
        const affStr = typeof aff === 'string' ? aff : (aff.name || aff.id || '');
        if (affStr.toLowerCase().includes(q)) return true;
      }
    }
    if (author.credit_levels) {
      for (const cl of author.credit_levels) {
        if (cl.role.toLowerCase().includes(q)) return true;
      }
    }
    return false;
  }

  function getHighlightedSet(sortedAuthors) {
    if (!searchQuery) return null;
    const set = new Set();
    for (let i = 0; i < sortedAuthors.length; i++) {
      if (matchesSearch(sortedAuthors[i], searchQuery)) set.add(i);
    }
    return set;
  }

  function rerender() {
    // Tear down Explore network view before replacing the widget DOM
    if (exploreCleanup) { exploreCleanup(); exploreCleanup = null; }
    const newWidget = buildWidget();
    const oldWidget = container.querySelector('.ae-widget');
    if (oldWidget) {
      oldWidget.replaceWith(newWidget);
    } else {
      container.innerHTML = '';
      container.appendChild(newWidget);
    }
  }

  // ── Tab builders ──

  /** CRediT matrix — TRANSPOSED: authors as rows, roles as columns */
  function buildMatrixTab(sorted) {
    const centering = el('div', { style: { display: 'flex', justifyContent: 'center' } });
    const outer = el('div', { style: { display: 'inline-flex', flexDirection: 'row', alignItems: 'center' } });
    centering.appendChild(outer);
    const wrap = el('div', { className: 'ae-matrix-wrap', style: { overflowX: 'auto' } });
    outer.appendChild(wrap);
    const table = el('table', { className: 'ae-matrix', style: { width: 'auto', margin: '0' } });

    // Header row: [sticky corner | role1 | role2 | ...]
    const thead = el('thead');
    const headerRow = el('tr');
    headerRow.appendChild(el('th', { className: 'ae-matrix-corner-cell' }));
    for (const role of ALL_CREDIT_ROLES) {
      const th = el('th', { className: 'ae-matrix-role-col-th' });
      const inner = el('div', { className: 'ae-matrix-role-col-header' });
      inner.appendChild(el('span', { className: 'ae-matrix-role-col-label' }, role));
      th.appendChild(inner);
      headerRow.appendChild(th);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Author rows
    const tbody = el('tbody');
    for (let ai = 0; ai < sorted.length; ai++) {
      const author = sorted[ai];
      const isDimmed = searchQuery && !matchesSearch(author, searchQuery);
      const row = el('tr');
      if (isDimmed) row.style.opacity = '0.3';

      // Sticky author cell
      const tdAuthor = el('td', { className: 'ae-matrix-author-row-td' });
      const nameEl = el('span', { className: 'ae-matrix-author-row-name' }, author.name);
      attachAuthorPopover(nameEl, author);
      tdAuthor.appendChild(nameEl);
      row.appendChild(tdAuthor);

      // Role cells
      for (const role of ALL_CREDIT_ROLES) {
        const level = findCreditLevel(author, role);
        const td = el('td', { className: 'ae-matrix-cell' });
        if (level) {
          td.appendChild(el('div', {
            className: `ae-dot ae-dot-${level}`,
            title: `${author.name}: ${level}`,
          }));
        }
        row.appendChild(td);
      }

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    // Legend
    const legend = el('div', { className: 'ae-matrix-legend' });
    legend.appendChild(el('span', { className: 'ae-legend-word ae-legend-word-lead' }, 'Lead'));
    legend.appendChild(el('span', { className: 'ae-legend-word ae-legend-word-equal' }, 'Equal'));
    legend.appendChild(el('span', { className: 'ae-legend-word ae-legend-word-supporting' }, 'Supporting'));
    outer.appendChild(legend);

    return centering;
  }

  /** Sorted author list with affiliation superscripts and sort chips */
  function buildAuthorListTab() {
    const activeAuthors = authors;
    const isCreditSort = sortKey.startsWith('credit:');
    const resorted = sortAuthors(activeAuthors, sortKey);
    const wrap = el('div', { className: 'ae-author-list-tab' });

    // Sort bar
    const sortBar = el('div', { className: 'ae-sort-bar' });
    const sortHeader = el('div', { className: 'ae-sort-header' },
      el('span', { className: 'ae-label' }, 'Authors'),
      el('span', { className: 'ae-count' }, String(activeAuthors.length)),
      el('span', { className: 'ae-sep' }, '|'),
      el('span', { className: 'ae-sublabel' }, 'Order by:'),
    );
    sortBar.appendChild(sortHeader);

    const chips = el('div', { className: 'ae-chips' });

    chips.appendChild(el('button', {
      type: 'button',
      className: `ae-chip ${sortKey === 'alpha' ? 'ae-chip-active' : ''}`,
      onClick: () => { sortKey = 'alpha'; rerender(); },
    }, 'A → Z'));

    // CRediT Role dropdown
    const creditWrap = el('div', { className: 'ae-credit-wrap' });
    const creditBtn = el('button', {
      type: 'button',
      className: `ae-chip ${isCreditSort ? 'ae-chip-active' : ''}`,
      onClick: () => { showCreditMenu = !showCreditMenu; rerender(); },
    }, 'CRediT Role ▾');
    creditWrap.appendChild(creditBtn);

    if (showCreditMenu) {
      const menu = el('div', { className: 'ae-credit-menu ae-credit-menu-fixed' });
      menu.appendChild(el('div', { className: 'ae-credit-menu-title' }, 'Sort by specific CRediT role'));
      for (const role of ALL_CREDIT_ROLES) {
        const key = `credit:${role}`;
        const isActive = sortKey === key;
        const item = el('button', {
          className: `ae-credit-item ${isActive ? 'ae-credit-item-active' : ''}`,
          onClick: () => { sortKey = key; showCreditMenu = false; rerender(); },
        },
          el('span', {}, role),
          isActive ? el('span', { className: 'ae-check' }, '✓') : null,
        );
        menu.appendChild(item);
      }
      creditWrap.appendChild(menu);
      requestAnimationFrame(() => {
        const btnRect = creditBtn.getBoundingClientRect();
        menu.style.top = (btnRect.bottom + 4) + 'px';
        menu.style.left = btnRect.left + 'px';
      });
      const backdrop = el('div', { className: 'ae-backdrop', onClick: () => { showCreditMenu = false; rerender(); } });
      creditWrap.appendChild(backdrop);
    }
    chips.appendChild(creditWrap);

    chips.appendChild(el('button', {
      type: 'button',
      className: `ae-chip ${sortKey === 'most-roles' ? 'ae-chip-active' : ''}`,
      onClick: () => { sortKey = 'most-roles'; rerender(); },
    }, 'Most roles'));

    // Author levels toggle switch
    const levelsWrap = el('label', {
      className: 'ae-author-levels-wrap',
      title: 'Group authors into first / (none) / senior based on author_level field',
    });
    const levelsInput = el('input', { type: 'checkbox', style: { display: 'none' } });
    if (useAuthorLevels) levelsInput.checked = true;
    levelsInput.addEventListener('change', () => {
      useAuthorLevels = levelsInput.checked;
      container.dataset.cvUseAuthorLevels = String(useAuthorLevels);
      rerender();
    });
    const track = el('span', { className: `ae-toggle-track${useAuthorLevels ? ' ae-toggle-on' : ''}` });
    track.appendChild(el('span', { className: 'ae-toggle-thumb' }));
    levelsWrap.appendChild(levelsInput);
    levelsWrap.appendChild(track);
    levelsWrap.appendChild(el('span', { className: 'ae-toggle-label' }, 'Author levels'));
    chips.appendChild(levelsWrap);

    sortBar.appendChild(chips);

    let sortDesc = 'Alphabetical by last name';
    if (sortKey === 'most-roles') sortDesc = 'By number of CRediT roles';
    else if (isCreditSort) sortDesc = `By "${sortKey.slice(7)}" — lead → equal → supporting → none`;
    sortBar.appendChild(el('p', { className: 'ae-sort-desc' }, `Sorted: ${sortDesc}`));
    wrap.appendChild(sortBar);

    // Build affiliation index
    const affList = [];
    const affIndexMap = new Map();
    function getAffKey(aff) {
      if (typeof aff === 'string') return aff;
      return aff.id || aff.name || JSON.stringify(aff);
    }
    function getAffLabel(aff) {
      if (typeof aff === 'string') return aff;
      let label = aff.name || aff.id || '';
      if (aff.department) label = `${aff.department}, ${label}`;
      if (aff.city) label += `, ${aff.city}`;
      if (aff.country) label += `, ${aff.country}`;
      return label;
    }

    const authorIndex = new Map();
    resorted.forEach((author, i) => {
      authorIndex.set(author.name, i + 1);
      if (!author.affiliations) return;
      author.affiliations.forEach(aff => {
        const key = getAffKey(aff);
        if (!affIndexMap.has(key)) {
          affIndexMap.set(key, affList.length + 1);
          affList.push(aff);
        }
      });
    });

    // When author levels are on, split into groups and render each group
    const AUTHOR_LEVEL_ORDER = ['first', null, 'senior'];

    function renderAuthorList(authorsToRender) {
      const namesList = el('div', { className: 'ae-names' });

      if (useAuthorLevels) {
        const grpFirst = [], grpMiddle = [], grpSenior = [];
        for (const author of authorsToRender) {
          const lvl = author.author_level ?? null;
          if (lvl === 'first') grpFirst.push(author);
          else if (lvl === 'senior') grpSenior.push(author);
          else grpMiddle.push(author);
        }
        const nonEmptyGroups = [];
        if (grpFirst.length) nonEmptyGroups.push({ key: 'first', authors: grpFirst });
        if (grpMiddle.length) nonEmptyGroups.push({ key: 'middle', authors: grpMiddle });
        if (grpSenior.length) nonEmptyGroups.push({ key: 'senior', authors: grpSenior });

        nonEmptyGroups.forEach((group, groupIndex) => {
          if (groupIndex > 0) {
            namesList.appendChild(el('span', { className: 'ae-level-group-sep' }, ' | '));
          }
          group.authors.forEach((author, gi) => {
            const isLastInGroup = gi === group.authors.length - 1;
            const isLastOverall = groupIndex === nonEmptyGroups.length - 1 && isLastInGroup;
            const isDimmed = searchQuery && !matchesSearch(author, searchQuery);
            const span = el('span', { className: 'ae-name-wrap' });
            if (isDimmed) span.style.opacity = '0.3';
            const nameBtn = el('button', { className: 'ae-name' }, author.name);
            attachAuthorPopover(nameBtn, author);
            span.appendChild(nameBtn);
            if (author.affiliations?.length && affList.length > 0) {
              const indices = author.affiliations.map(aff => affIndexMap.get(getAffKey(aff))).filter(Boolean);
              const sym = (group.key === 'first' && multiFirst) ? '*'
                        : (group.key === 'senior' && multiSenior) ? '§'
                        : '';
              if (indices.length) span.appendChild(el('sup', { className: 'ae-aff-sup' }, indices.join(',') + sym));
              else if (sym) span.appendChild(el('sup', { className: 'ae-aff-sup' }, sym));
            } else {
              const sym = (group.key === 'first' && multiFirst) ? '*'
                        : (group.key === 'senior' && multiSenior) ? '§'
                        : '';
              if (sym) span.appendChild(el('sup', { className: 'ae-aff-sup' }, sym));
            }
            if (isCreditSort) {
              const level = findCreditLevel(author, sortKey.slice(7));
              if (level) span.appendChild(el('span', { className: `ae-level-badge ae-level-${level}` }, level === 'lead' ? 'L' : level === 'equal' ? 'E' : 'S'));
            }
            if (author.corresponding) span.appendChild(el('span', { className: 'ae-corresponding', title: 'Corresponding author' }, '✉'));
            if (!isLastOverall) span.appendChild(el('span', { className: 'ae-comma' }, ', '));
            namesList.appendChild(span);
          });
        });
      } else {
        authorsToRender.forEach((author, i) => {
          const isLast = i === authorsToRender.length - 1;
          const isDimmed = searchQuery && !matchesSearch(author, searchQuery);
          const span = el('span', { className: 'ae-name-wrap' });
          if (isDimmed) span.style.opacity = '0.3';
          const nameBtn = el('button', { className: 'ae-name' }, author.name);
          attachAuthorPopover(nameBtn, author);
          span.appendChild(nameBtn);
          if (author.affiliations?.length && affList.length > 0) {
            const indices = author.affiliations.map(aff => affIndexMap.get(getAffKey(aff))).filter(Boolean);
            if (indices.length) span.appendChild(el('sup', { className: 'ae-aff-sup' }, indices.join(',')));
          }
          if (isCreditSort) {
            const level = findCreditLevel(author, sortKey.slice(7));
            if (level) span.appendChild(el('span', { className: `ae-level-badge ae-level-${level}` }, level === 'lead' ? 'L' : level === 'equal' ? 'E' : 'S'));
          }
          if (author.corresponding) span.appendChild(el('span', { className: 'ae-corresponding', title: 'Corresponding author' }, '✉'));
          if (!isLast) span.appendChild(el('span', { className: 'ae-comma' }, ', '));
          namesList.appendChild(span);
        });
      }
      return namesList;
    }

    // Pre-compute shared authorship flags for legend
    const _firstCount = useAuthorLevels ? resorted.filter(a => a.author_level === 'first').length : 0;
    const _seniorCount = useAuthorLevels ? resorted.filter(a => a.author_level === 'senior').length : 0;
    const multiFirst = _firstCount > 1;
    const multiSenior = _seniorCount > 1;

    // Names with superscript affiliation indices
    const namesList = renderAuthorList(resorted);

    const byline = el('div', { className: 'ae-byline' });
    byline.appendChild(namesList);

    if (affList.length) {
      const affDiv = el('div', { className: 'ae-affiliations ae-aff-numbered' });
      affList.forEach((aff, idx) => {
        const line = el('div', { className: 'ae-aff-line' });
        line.appendChild(el('sup', { className: 'ae-aff-sup' }, String(idx + 1)));
        line.appendChild(document.createTextNode(' ' + getAffLabel(aff)));
        affDiv.appendChild(line);
      });
      byline.appendChild(affDiv);
    }

    if (isCreditSort) {
      const legend = el('span', { className: 'ae-legend' });
      legend.appendChild(el('span', { className: 'ae-legend-dot ae-dot-lead' }));
      legend.appendChild(document.createTextNode('Lead '));
      legend.appendChild(el('span', { className: 'ae-legend-dot ae-dot-equal' }));
      legend.appendChild(document.createTextNode('Equal '));
      legend.appendChild(el('span', { className: 'ae-legend-dot ae-dot-supporting' }));
      legend.appendChild(document.createTextNode('Supporting'));
      byline.appendChild(legend);
    }

    if (useAuthorLevels && (multiFirst || multiSenior)) {
      const lvlLegend = el('div', { className: 'ae-author-level-legend' });
      if (multiFirst) lvlLegend.appendChild(el('span', {}, '* Shared first authorship'));
      if (multiSenior) lvlLegend.appendChild(el('span', {}, '§ Shared senior authorship'));
      byline.appendChild(lvlLegend);
    }

    wrap.appendChild(byline);
    return wrap;
  }

  /** Profiles tab */
  function buildProfilesTab(sorted) {
    const wrap = el('div', { className: 'ae-profiles' });
    for (let ai = 0; ai < sorted.length; ai++) {
      const author = sorted[ai];
      const isDimmed = searchQuery && !matchesSearch(author, searchQuery);
      const color = getColor(author.name);
      const card = el('div', { className: 'ae-profile-card' });
      card.style.setProperty('--i', String(ai));
      if (isDimmed) card.style.opacity = '0.3';

      // Avatar
      const avatar = el('div', {
        className: 'ae-avatar',
        style: { backgroundColor: color },
      }, getInitials(author.name));
      if (author.corresponding) {
        avatar.appendChild(el('span', { className: 'ae-avatar-badge' }, '✉'));
      }
      card.appendChild(avatar);

      // Info column
      const info = el('div', { className: 'ae-profile-info' });

      // Name row: name + career stage + ORCID badge
      const nameRow = el('div', { className: 'ae-profile-name-row' });
      nameRow.appendChild(el('span', { className: 'ae-profile-name' }, author.name));
      if (author.career_stage) {
        nameRow.appendChild(el('span', { className: 'ae-career-stage' }, author.career_stage));
      }
      if (author.orcid) {
        nameRow.appendChild(el('a', {
          href: `https://orcid.org/${author.orcid}`,
          target: '_blank',
          rel: 'noopener noreferrer',
          className: 'ae-orcid-badge',
          title: `ORCID: ${author.orcid}`,
          innerHTML: '<svg viewBox="0 0 24 24" width="16" height="16" fill="#a6ce39" style="vertical-align:middle"><path d="M12 0C5.37 0 0 5.37 0 12s5.37 12 12 12 12-5.37 12-12S18.63 0 12 0zM8.44 6.4a1.1 1.1 0 1 1 0 2.2 1.1 1.1 0 0 1 0-2.2zm-.77 3.6h1.54v7.6H7.67V10zm3.84 0h4.1c3.9 0 5.33 2.8 5.33 3.8 0 2.5-1.97 3.8-5.2 3.8h-4.23V10zm1.54 1.4v5.2h2.4c2.3 0 3.6-1.1 3.6-2.6 0-1.4-1.2-2.6-3.5-2.6h-2.5z"/></svg>',
        }));
      }
      info.appendChild(nameRow);

      // Affiliations line
      if (author.affiliations?.length) {
        const affWrap = el('div', { className: 'ae-profile-aff' });
        const affStrings = author.affiliations.map(a => typeof a === 'string' ? a : (a.name || a));
        affStrings.forEach((aff, i) => {
          if (i > 0) affWrap.appendChild(document.createElement('br'));
          affWrap.appendChild(document.createTextNode(aff));
        });
        info.appendChild(affWrap);
      }

      // Social links (from upstream data, if present)
      if (author.social_links?.length) {
        const links = el('div', { className: 'ae-social-links' });
        for (const link of author.social_links) {
          const icon = { orcid: '🆔', github: '🐙', 'google-scholar': '🎓', website: '🌐', twitter: '𝕏', bluesky: '🦋', linkedin: '💼', email: '✉️' }[link.platform] || '🔗';
          links.appendChild(el('a', {
            href: link.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'ae-social-link',
            title: link.platform,
          }, icon));
        }
        info.appendChild(links);
      }

      card.appendChild(info);

      // Credit role badges
      const creditLevels = author.credit_levels || [];
      if (creditLevels.length) {
        const roles = el('div', { className: 'ae-profile-roles' });
        for (const cr of creditLevels) {
          roles.appendChild(el('span', {
            className: `ae-role-badge ae-role-${cr.level}`,
          }, cr.role.replace('Writing – ', 'W: ').replace('Formal ', 'F. ')));
        }
        card.appendChild(roles);
      }

      // Section contributions
      const sectionContribs = author.section_contributions || [];
      if (sectionContribs.length) {
        const secRow = el('div', { className: 'ae-profile-sections' });
        secRow.appendChild(el('span', { className: 'ae-profile-sections-label' }, 'Sections:'));
        for (const sc of sectionContribs) {
          const title = typeof sc === 'string' ? sc : sc.section;
          if (title) secRow.appendChild(el('span', { className: 'ae-section-badge' }, title));
        }
        card.appendChild(secRow);
      }

      wrap.appendChild(card);
    }
    return wrap;
  }

  /** Sections map tab */
  function buildSectionsTab(sorted) {
    const wrap = el('div', { className: 'ae-sections' });

    const sectionMap = new Map();
    for (const author of sorted) {
      if (!author.section_contributions) continue;
      for (const sc of author.section_contributions) {
        if (!sectionMap.has(sc.section)) sectionMap.set(sc.section, []);
        sectionMap.get(sc.section).push({ author, ...sc });
      }
    }

    const effortRank = { lead: 3, equal: 2, supporting: 1 };
    let sectionIdx = 0;
    for (const [sectionId, contribs] of sectionMap) {
      contribs.sort((a, b) => (effortRank[b.effort] || 0) - (effortRank[a.effort] || 0));

      const section = el('div', { className: 'ae-section-block' });
      section.style.setProperty('--i', String(sectionIdx++));
      section.appendChild(el('div', { className: 'ae-section-id' }, sectionId));

      const contributors = el('div', { className: 'ae-section-contributors' });
      for (const c of contribs) {
        const color = getColor(c.author.name);
        const isDimmed = searchQuery && !matchesSearch(c.author, searchQuery);
        const chip = el('div', { className: 'ae-section-chip' });
        if (isDimmed) chip.style.opacity = '0.3';
        chip.appendChild(el('div', {
          className: 'ae-section-avatar',
          style: { backgroundColor: color },
        }, getInitials(c.author.name)));
        const info = el('div', { className: 'ae-section-chip-info' });
        const chipName = el('span', { className: 'ae-section-chip-name' }, c.author.name);
        attachAuthorPopover(chipName, c.author);
        info.appendChild(chipName);
        if (c.effort) {
          info.appendChild(el('span', { className: `ae-effort ae-effort-${c.effort}` }, c.effort));
        }
        if (c.description) {
          info.appendChild(el('p', { className: 'ae-section-chip-desc' }, c.description));
        }
        chip.appendChild(info);
        contributors.appendChild(chip);
      }
      section.appendChild(contributors);
      wrap.appendChild(section);
    }

    if (sectionMap.size === 0) {
      wrap.appendChild(el('p', { className: 'ae-empty' }, 'No section contribution data available.'));
    }

    return wrap;
  }

  // ── Build full widget ──
  function buildWidget() {
    const sorted = sortAuthors(authors, sortKey);

    const container2 = el('div', { className: `ae-widget ${isDark ? 'ae-dark' : ''}` });

    // Tabs: matrix, sections, authors, profiles, explore (no timeline)
    const panel = el('div', { className: 'ae-panel' });
    const tabs = el('div', { className: 'ae-tabs', role: 'tablist', 'aria-label': 'Authorship views' });
    const tabDefs = [
      { id: 'explore',  label: 'Explore' },
      { id: 'matrix',   label: 'CRediT' },
      { id: 'authors',  label: 'Sorted List' },
      { id: 'profiles', label: 'Profiles' },
      { id: 'sections', label: 'Sections' },
    ];
    for (let ti = 0; ti < tabDefs.length; ti++) {
      const t = tabDefs[ti];
      const isActive = activeTab === t.id;
      const tabBtn = el('button', {
        className: `ae-tab ${isActive ? 'ae-tab-active' : ''}`,
        role: 'tab',
        'aria-selected': String(isActive),
        tabindex: isActive ? '0' : '-1',
        onClick: () => { activeTab = t.id; container.dataset.cvTab = t.id; rerender(); },
      }, t.label);
      tabBtn.addEventListener('keydown', (e) => {
        let next = -1;
        if (e.key === 'ArrowRight') next = (ti + 1) % tabDefs.length;
        else if (e.key === 'ArrowLeft') next = (ti - 1 + tabDefs.length) % tabDefs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabDefs.length - 1;
        if (next >= 0) {
          e.preventDefault();
          activeTab = tabDefs[next].id;
          rerender();
          requestAnimationFrame(() => {
            const newTab = container.querySelector('.ae-tab-active');
            if (newTab) newTab.focus();
          });
        }
      });
      tabs.appendChild(tabBtn);
    }
    panel.appendChild(tabs);

    // Search bar
    const searchBar = el('div', { className: 'ae-search-bar' });
    const searchInput = el('input', {
      className: 'ae-search-input',
      type: 'text',
      placeholder: 'Filter by name, institution, or role…',
      'aria-label': 'Filter contributors',
    });
    searchInput.value = searchQuery;
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      rerender();
      requestAnimationFrame(() => {
        const inp = container.querySelector('.ae-search-input');
        if (inp) { inp.focus(); inp.selectionStart = inp.selectionEnd = inp.value.length; }
      });
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { searchQuery = ''; rerender(); }
    });
    searchBar.appendChild(el('span', { className: 'ae-search-icon', 'aria-hidden': 'true' }, '🔍'));
    searchBar.appendChild(searchInput);
    if (searchQuery) {
      searchBar.appendChild(el('button', {
        className: 'ae-search-clear',
        onClick: () => { searchQuery = ''; rerender(); },
        'aria-label': 'Clear search',
        title: 'Clear',
      }, '×'));
    }
    panel.appendChild(searchBar);

    // Tab content
    const content = el('div', { className: 'ae-tab-content', role: 'tabpanel' });
    if (sorted.length === 0) {
      content.appendChild(el('p', { className: 'ae-empty' }, 'No contributor data available.'));
    } else if (activeTab === 'matrix') {
      content.appendChild(buildMatrixTab(sorted));
    } else if (activeTab === 'sections') {
      content.appendChild(buildSectionsTab(sorted));
    } else if (activeTab === 'authors') {
      content.appendChild(buildAuthorListTab());
    } else if (activeTab === 'profiles') {
      content.appendChild(buildProfilesTab(sorted));
    } else if (activeTab === 'explore') {
      // createExploreView appends directly into content and returns a cleanup fn
      if (!exploreZoomState) exploreZoomState = {};
      exploreCleanup = createExploreView(content, sorted, exploreZoomState);
    }
    panel.appendChild(content);
    container2.appendChild(panel);

    return container2;
  }

  // Watch dark mode changes
  const darkObserver = new MutationObserver(() => {
    const wasDark = isDark;
    isDark = detectDarkMode();
    if (wasDark !== isDark) rerender();
  });
  darkObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

  // Store cleanup on container
  container._aeCleanup = () => {
    darkObserver.disconnect();
    hidePopover();
  };

  rerender();
}

/**
 * header-template.js — Single source for the shared app header / nav.
 *
 * Every standard page used to hand-copy an identical ~35-line <header> block,
 * so adding a nav item meant editing ~16 files. Instead each page now contains
 * a single `<!--APP_HEADER-->` placeholder; the Vite plugin in vite.config.js
 * calls renderHeader() at build (and dev) time to inject the markup, varying
 * only the brand subtitle and which link/dropdown is marked active.
 *
 * names.html is intentionally NOT listed here — it uses a reduced custom nav.
 *
 * @module
 */

const TOP_LINKS = [
  ['/search', 'Search'],
  ['/view', 'View'],
];

const PLATFORMS = [
  ['/smartspim', 'SmartSPIM'],
  ['/exaspim', 'ExaSPIM'],
  ['/fiber_photometry', 'Fiber Photometry'],
  ['/vr_foraging', 'VR Foraging'],
  ['/dynamic_foraging', 'Dynamic Foraging'],
  ['/dynamic_routing', 'Dynamic Routing'],
  ['/slap2', 'SLAP2'],
];

const DASHBOARDS = [
  ['/sessions', 'Behavior sessions'],
  ['/quality_control', 'Quality Control'],
  ['/contributions', 'Contributions'],
];

/**
 * Per-page header config, keyed by HTML filename.
 * `active` is the nav href for the current page (null for utility pages that
 * are not linked in the nav, e.g. migrate / upgrade / record).
 */
export const PAGES = {
  'search.html':           { sub: 'search',                    active: '/search' },
  'view.html':             { sub: 'asset viewer',              active: '/view' },
  'smartspim.html':        { sub: 'smartspim platform',        active: '/smartspim' },
  'exaspim.html':          { sub: 'exaspim platform',          active: '/exaspim' },
  'fiber_photometry.html': { sub: 'fiber photometry platform', active: '/fiber_photometry' },
  'vr_foraging.html':      { sub: 'vr foraging platform',      active: '/vr_foraging' },
  'dynamic_foraging.html': { sub: 'dynamic foraging platform', active: '/dynamic_foraging' },
  'dynamic_routing.html':  { sub: 'dynamic routing platform',  active: '/dynamic_routing' },
  'slap2.html':            { sub: 'slap2 platform',            active: '/slap2' },
  'sessions.html':         { sub: 'behavior sessions',         active: '/sessions' },
  'quality_control.html':  { sub: 'quality control',           active: '/quality_control' },
  'contributions.html':    { sub: 'contributions',             active: '/contributions' },
  'migrate.html':          { sub: 'metadata migration',        active: null },
  'migrate/submit.html':   { sub: 'submit metadata migration', active: null },
  'migrate/review.html':   { sub: 'review pending migrations', active: null },
  'upgrade.html':          { sub: 'metadata upgrade',          active: null },
  'record.html':           { sub: 'metadata record',           active: null },
  'v2.html':               { sub: 'v2 acquisition heatmap',     active: null },
};

function navLink(href, label, active, indent) {
  const cur = href === active ? ' aria-current="page"' : '';
  return `${indent}<a href="${href}"${cur}>${label}</a>`;
}

function dropdown(label, items, active) {
  const isActive = items.some(([href]) => href === active);
  const btnCls = isActive ? 'app-nav-dropdown-btn active' : 'app-nav-dropdown-btn';
  const links = items.map(([href, text]) => navLink(href, text, active, '            ')).join('\n');
  return [
    '        <div class="app-nav-dropdown">',
    `          <button class="${btnCls}">${label} &#x25BE;</button>`,
    '          <div class="app-nav-dropdown-menu">',
    links,
    '          </div>',
    '        </div>',
  ].join('\n');
}

/**
 * Render the full <header> block for a page.
 *
 * @param {{ sub: string, active: string|null }} page
 * @returns {string} HTML for the header (no leading indent on the first line;
 *   the `<!--APP_HEADER-->` placeholder supplies it).
 */
export function renderHeader({ sub, active }) {
  return [
    '<header class="app-header">',
    '      <a href="/search" class="app-header-brand">',
    '        <img src="/images/logo.svg" class="app-logo" alt="Allen Institute" width="26" height="32">',
    '        <div class="app-brand-text">',
    '          <span class="app-brand-top">allen institute / <span class="app-brand-dept">neural dynamics /</span></span>',
    `          <span class="app-brand-sub">${sub}</span>`,
    '        </div>',
    '      </a>',
    '      <nav class="app-nav" aria-label="Main navigation">',
    ...TOP_LINKS.map(([href, label]) => navLink(href, label, active, '        ')),
    dropdown('Platforms', PLATFORMS, active),
    dropdown('Dashboards', DASHBOARDS, active),
    '        <button id="theme-toggle" class="theme-toggle-btn" aria-label="Toggle dark/light mode"></button>',
    '      </nav>',
    '    </header>',
  ].join('\n');
}

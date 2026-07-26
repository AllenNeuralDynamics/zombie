/**
 * header-template.js — Single source for the shared app header / nav.
 *
 * Every standard page used to hand-copy an identical ~35-line <header> block,
 * so adding a nav item meant editing ~16 files. Instead each page now contains
 * a single `<!--APP_HEADER-->` placeholder; the Vite plugin in vite.config.js
 * calls renderHeader() at build (and dev) time to inject the markup, varying
 * only the brand subtitle and which link/dropdown is marked active.
 *
 * Nav structure and per-page header config both come from the route manifest
 * (`./routes.js`) — this module only contains rendering logic.
 *
 * names.html is intentionally NOT in `PAGES` — it uses a reduced custom nav
 * (see its `customHeader` entry in routes.js).
 *
 * @module
 */

import { PAGES, TOP_LINKS, PLATFORMS, DASHBOARDS } from './routes.js';

export { PAGES };

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
 * @param {{ sub: string, active?: string|null }} page
 * @returns {string} HTML for the header (no leading indent on the first line;
 *   the `<!--APP_HEADER-->` placeholder supplies it).
 */
export function renderHeader({ sub, active = null }) {
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

/**
 * Tiny synchronous initializer that applies a saved theme before first paint
 * (avoids a flash of the wrong theme). Injected via the `<!--THEME_INIT-->`
 * placeholder so its one implementation lives here instead of being
 * hand-copied into every page's <head>. The actual toggle-button wiring lives
 * in `web/src/lib/theme.js`, loaded as a module script by each page that has
 * a `#theme-toggle` button.
 */
export function renderThemeInit() {
  return "<script>(function(){var t=localStorage.getItem('theme');if(t)document.documentElement.setAttribute('data-theme',t);}());</script>";
}

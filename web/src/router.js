/**
 * router.js — Lightweight client-side router for ZOMBIE.
 *
 * Matches window.location.pathname to a map of { '/path': renderFunction }.
 * Unrecognised paths fall back to '/'.
 *
 * Pure helpers (matchRoute, buildNavLinks) are exported for unit testing.
 * Side-effectful APIs (initRouter, navigate) integrate with the DOM.
 */

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Return the routes-map key that matches `pathname`, falling back to '/'.
 *
 * @param {string} pathname - e.g. window.location.pathname
 * @param {Record<string, unknown>} routes
 * @returns {string}
 */
export function matchRoute(pathname, routes) {
  if (Object.prototype.hasOwnProperty.call(routes, pathname)) return pathname;
  return '/';
}

/**
 * Build the href for a nav item, preserving the current search string when
 * navigating to the same path and stripping it when navigating elsewhere.
 *
 * (Kept simple for Phase 1 — URL params are only relevant on '/'.)
 *
 * @param {string} path - Target pathname e.g. '/assets'
 * @param {string} [currentSearch=''] - window.location.search
 * @returns {string}
 */
export function buildNavHref(path, currentSearch = '') {
  if (path === '/') return '/' + currentSearch;
  return path;
}

// ---------------------------------------------------------------------------
// Router state
// ---------------------------------------------------------------------------

/** Active routes map, set by initRouter(). */
let _routes = {};

// ---------------------------------------------------------------------------
// Side-effectful APIs
// ---------------------------------------------------------------------------

/**
 * Navigate to `path`, push a history entry, and render the matched route.
 *
 * @param {string} path - Target pathname e.g. '/assets'
 */
export function navigate(path) {
  window.history.pushState(null, '', path);
  _render();
}

/**
 * Render the route that matches the current window.location.pathname.
 * Exposed so app.js can trigger a re-render without full init.
 */
export function renderCurrentRoute() {
  _render();
}

function _render() {
  const key = matchRoute(window.location.pathname, _routes);
  _routes[key]();
  _updateActiveNav(key);
}

/**
 * Mark the matching nav link as active.
 *
 * @param {string} activeKey
 */
function _updateActiveNav(activeKey) {
  document.querySelectorAll('.app-nav a[data-path]').forEach((link) => {
    const isActive = link.dataset.path === activeKey;
    link.classList.toggle('active', isActive);
    link.setAttribute('aria-current', isActive ? 'page' : '');
  });
}

/**
 * Initialise the router.
 *
 * - Stores the routes map.
 * - Binds the `popstate` listener for browser back/forward.
 * - Delegates nav-link clicks so we get pushState navigation instead of full reloads.
 * - Renders the current route immediately.
 *
 * @param {Record<string, () => void>} routes - Map of pathname → render function.
 */
export function initRouter(routes) {
  _routes = routes;
  window.addEventListener('popstate', _render);

  // Intercept clicks on nav links that carry data-path attributes.
  document.querySelector('.app-nav')?.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-path]');
    if (!link) return;
    e.preventDefault();
    navigate(link.dataset.path);
  });

  _render();
}

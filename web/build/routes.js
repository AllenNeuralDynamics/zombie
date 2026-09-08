/**
 * routes.js — Single source of truth for page routing metadata.
 *
 * Every page the site serves is listed here exactly once. This manifest
 * drives:
 *   - `vite.config.js` `rollupOptions.input` (build targets)
 *   - `header-template.js` nav links/dropdowns and per-page header config
 *
 * Nginx resolves ordinary extensionless routes generically (try the literal
 * path, then its `.html` form — see `deploy/nginx.conf`), so as long as a
 * page's `route` matches its `html` path (minus the `.html` extension) no
 * Nginx changes are needed to add a page. Routes whose public name
 * intentionally differs from the HTML filename, proxy endpoints, and legacy
 * redirects remain explicit Nginx concerns.
 *
 * ## Release channels
 *
 * The portal ships on two channels: `dev` builds from the `dev` branch, and
 * production builds from `main` on a release cycle. `stability` decides which
 * channel a page appears on — see {@link selectRoutes}. Because nginx has no
 * SPA fallback, a page left out of the build simply 404s in production; there
 * is nothing else to configure.
 *
 * Fields:
 *   route        Canonical clean URL path served by Nginx (e.g. '/search').
 *   html         HTML source path, relative to the `web/` root.
 *   inputKey     Unique key for `rollupOptions.input`.
 *   header       `{ sub, active }` passed to `renderHeader()` for pages that
 *                use the shared `<!--APP_HEADER-->` placeholder. `null` for
 *                pages with no standard header (redirects, standalone tools)
 *                or a hand-authored reduced header (see `customHeader`).
 *   customHeader Page keeps its own hand-authored header markup instead of
 *                the shared placeholder (e.g. a deliberately reduced nav).
 *                Such pages still load the shared theme-toggle module.
 *   nav          `{ group, label }` if the page is linked from the shared
 *                nav (`group` is 'top', 'platforms', or 'dashboards'), else
 *                `null`. Order in this array is the display order.
 *   stability    'stable' (default) — ships on every channel — or
 *                'experimental', which builds and links only on the dev
 *                channel. Mark a page experimental while its data source,
 *                URL contract or UI is still expected to change under users.
 */

/** Legal values for a route's `stability` field. */
export const STABILITY_LEVELS = ['stable', 'experimental'];

function page({
  route, html, inputKey, header = null, customHeader = false, nav = null,
  stability = 'stable',
}) {
  if (!STABILITY_LEVELS.includes(stability)) {
    throw new Error(`routes.js: unknown stability "${stability}" for ${html}`);
  }
  return { route, html, inputKey, header, customHeader, nav, stability };
}

export const ROUTES = [
  page({ route: '/', html: 'index.html', inputKey: 'main' }),

  page({
    route: '/search', html: 'search.html', inputKey: 'search',
    header: { sub: 'search' }, nav: { group: 'top', label: 'Search' },
  }),
  page({
    route: '/view', html: 'view.html', inputKey: 'view',
    header: { sub: 'asset viewer' }, nav: { group: 'top', label: 'View' },
  }),

  page({
    route: '/smartspim', html: 'smartspim.html', inputKey: 'smartspim',
    header: { sub: 'smartspim platform' }, nav: { group: 'platforms', label: 'SmartSPIM' },
  }),
  page({
    route: '/exaspim', html: 'exaspim.html', inputKey: 'exaspim',
    header: { sub: 'exaspim platform' }, nav: { group: 'platforms', label: 'ExaSPIM' },
  }),
  page({
    route: '/fiber_photometry', html: 'fiber_photometry.html', inputKey: 'fiber_photometry',
    header: { sub: 'fiber photometry platform' }, nav: { group: 'platforms', label: 'Fiber Photometry' },
  }),
  page({
    route: '/vr_foraging', html: 'vr_foraging.html', inputKey: 'vr_foraging',
    header: { sub: 'vr foraging platform' }, nav: { group: 'platforms', label: 'VR Foraging' },
  }),
  page({
    route: '/dynamic_foraging', html: 'dynamic_foraging.html', inputKey: 'dynamic_foraging',
    header: { sub: 'dynamic foraging platform' }, nav: { group: 'platforms', label: 'Dynamic Foraging' },
  }),
  page({
    route: '/dynamic_routing', html: 'dynamic_routing.html', inputKey: 'dynamic_routing',
    header: { sub: 'dynamic routing platform' }, nav: { group: 'platforms', label: 'Dynamic Routing' },
  }),
  page({
    route: '/slap2', html: 'slap2.html', inputKey: 'slap2',
    header: { sub: 'slap2 platform' }, nav: { group: 'platforms', label: 'SLAP2' },
  }),

  page({
    route: '/sessions', html: 'sessions.html', inputKey: 'sessions',
    header: { sub: 'behavior sessions' }, nav: { group: 'dashboards', label: 'Behavior sessions' },
  }),
  page({
    route: '/quality_control', html: 'quality_control.html', inputKey: 'quality_control',
    header: { sub: 'quality control' }, nav: { group: 'dashboards', label: 'Quality Control' },
  }),
  page({ route: '/auth/callback', html: 'auth/callback.html', inputKey: 'auth_callback' }),
  page({
    route: '/contributions', html: 'contributions.html', inputKey: 'contributions',
    header: { sub: 'contributions' }, nav: { group: 'dashboards', label: 'Contributions' },
  }),

  // ---- Experimental dashboards: dev channel only ----
  page({
    route: '/analysis-framework', html: 'analysis-framework.html', inputKey: 'analysis_framework',
    header: { sub: 'analysis framework' }, nav: { group: 'dashboards', label: 'Analysis Framework' },
    stability: 'experimental',
  }),
  page({
    route: '/size', html: 'size.html', inputKey: 'size',
    header: { sub: 'storage sizes' }, nav: { group: 'dashboards', label: 'Storage Sizes' },
    stability: 'experimental',
  }),
  page({
    route: '/swdb', html: 'swdb.html', inputKey: 'swdb',
    header: { sub: 'SWDB data sets' }, nav: { group: 'dashboards', label: 'SWDB' },
    stability: 'experimental',
  }),
  page({
    route: '/timeline', html: 'timeline.html', inputKey: 'timeline',
    header: { sub: 'asset timeline' }, nav: { group: 'dashboards', label: 'Time to portal' },
    stability: 'experimental',
  }),

  // ---- SWDB sub-page (linked from the cards, not the nav; highlight the
  // Dashboards ▸ SWDB entry via active: '/swdb') ----
  page({
    route: '/swdb/set', html: 'swdb/set.html', inputKey: 'swdb_set',
    header: { sub: 'SWDB set', active: '/swdb' },
    stability: 'experimental',
  }),

  // ---- Contributions sub-pages (not directly nav-linked; highlight the
  // Dashboards ▸ Contributions entry via active: '/contributions') ----
  page({
    route: '/contributions/view', html: 'contributions/view.html', inputKey: 'contributions_view',
    header: { sub: 'contributions', active: '/contributions' },
  }),
  page({
    route: '/contributions/edit', html: 'contributions/edit.html', inputKey: 'contributions_edit',
    header: { sub: 'contributions — edit', active: '/contributions' },
  }),
  page({
    route: '/contributions/add', html: 'contributions/add.html', inputKey: 'contributions_add',
    header: { sub: 'contributions — add', active: '/contributions' },
  }),
  page({
    route: '/contributions/demo', html: 'contributions/demo.html', inputKey: 'contributions_demo',
    header: { sub: 'contributions — demo', active: '/contributions' },
  }),

  // ---- Hidden utility pages (built + routed, but not linked in nav) ----
  page({
    route: '/names', html: 'names.html', inputKey: 'names',
    customHeader: true,
  }),
  page({ route: '/record', html: 'record.html', inputKey: 'record', header: { sub: 'metadata record' } }),
  page({ route: '/star', html: 'star.html', inputKey: 'star', header: { sub: 'STAR methods' } }),
  page({ route: '/upgrade', html: 'upgrade.html', inputKey: 'upgrade', header: { sub: 'metadata upgrade' } }),
  page({ route: '/v2', html: 'v2.html', inputKey: 'v2', header: { sub: 'v2 acquisition heatmap' } }),
  page({ route: '/migrate', html: 'migrate.html', inputKey: 'migrate' }),
  page({
    route: '/migrate/submit', html: 'migrate/submit.html', inputKey: 'migrate_submit',
    header: { sub: 'submit metadata migration' },
  }),
  page({
    route: '/migrate/review', html: 'migrate/review.html', inputKey: 'migrate_review',
    header: { sub: 'review metadata proposals' },
  }),
  page({
    route: '/coordinate-system-builder', html: 'coordinate-system-builder.html',
    inputKey: 'coordinate_system_builder',
  }),
  page({ route: '/tables', html: 'tables.html', inputKey: 'tables' }),
];

function assertUnique(field) {
  const seen = new Map();
  for (const r of ROUTES) {
    const key = r[field];
    if (seen.has(key)) {
      throw new Error(`routes.js: duplicate ${field} "${key}" (pages: ${seen.get(key)}, ${r.html})`);
    }
    seen.set(key, r.html);
  }
}

assertUnique('route');
assertUnique('html');
assertUnique('inputKey');

/**
 * The routes a given release channel ships.
 *
 * @param {{ includeExperimental?: boolean }} [options]
 * @returns {typeof ROUTES}
 */
export function selectRoutes({ includeExperimental = false } = {}) {
  return includeExperimental ? ROUTES : ROUTES.filter((r) => r.stability === 'stable');
}

/**
 * Per-page header config, keyed by HTML source path (relative to `web/`),
 * for every route that uses the shared `<!--APP_HEADER-->` placeholder.
 *
 * Covers every route regardless of channel — excluded pages are never asked
 * for, because Vite only transforms the HTML files it was given as inputs.
 */
export const PAGES = Object.fromEntries(
  ROUTES.filter((r) => r.header).map((r) => [r.html, r.header]),
);

/**
 * Nav link groups for a channel's route list, in manifest order.
 *
 * @param {typeof ROUTES} [routes] Defaults to every route (dev channel).
 * @returns {{ top: [string, string][], platforms: ..., dashboards: ... }}
 */
export function navGroups(routes = ROUTES) {
  const group = (name) =>
    routes.filter((r) => r.nav?.group === name).map((r) => [r.route, r.nav.label]);
  return { top: group('top'), platforms: group('platforms'), dashboards: group('dashboards') };
}

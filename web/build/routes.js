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
 */

function page({ route, html, inputKey, header = null, customHeader = false, nav = null }) {
  return { route, html, inputKey, header, customHeader, nav };
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
  page({
    route: '/analysis-framework', html: 'analysis-framework.html', inputKey: 'analysis_framework',
    header: { sub: 'analysis framework' }, nav: { group: 'dashboards', label: 'Analysis Framework' },
  }),
  page({
    route: '/size', html: 'size.html', inputKey: 'size',
    header: { sub: 'storage sizes' }, nav: { group: 'dashboards', label: 'Storage Sizes' },
  }),
  page({
    route: '/swdb', html: 'swdb.html', inputKey: 'swdb',
    header: { sub: 'SWDB data sets' }, nav: { group: 'dashboards', label: 'SWDB' },
  }),
  page({
    route: '/timeline', html: 'timeline.html', inputKey: 'timeline',
    header: { sub: 'asset timeline' }, nav: { group: 'dashboards', label: 'Time to portal' },
  }),

  // ---- SWDB sub-page (linked from the cards, not the nav; highlight the
  // Dashboards ▸ SWDB entry via active: '/swdb') ----
  page({
    route: '/swdb/set', html: 'swdb/set.html', inputKey: 'swdb_set',
    header: { sub: 'SWDB set', active: '/swdb' },
  }),
  page({
    route: '/swdb/verification-graph', html: 'swdb/verification-graph.html',
    inputKey: 'swdb_verification_graph',
    header: { sub: 'SWDB verification graph', active: '/swdb' },
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

  // ---- Orphan/dev pages: not linked anywhere, built and routed generically
  // for documentation/consistency, but with no standard header ----
  page({ route: '/explore', html: 'explore.html', inputKey: 'explore', header: { sub: 'explorer' } }),
  page({ route: '/tables', html: 'tables.html', inputKey: 'tables' }),
  page({ route: '/probe-transform-debug', html: 'probe-transform-debug.html', inputKey: 'probe_transform_debug' }),
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
 * Per-page header config, keyed by HTML source path (relative to `web/`),
 * for every route that uses the shared `<!--APP_HEADER-->` placeholder.
 */
export const PAGES = Object.fromEntries(
  ROUTES.filter((r) => r.header).map((r) => [r.html, r.header]),
);

function navGroup(name) {
  return ROUTES.filter((r) => r.nav?.group === name).map((r) => [r.route, r.nav.label]);
}

export const TOP_LINKS = navGroup('top');
export const PLATFORMS = navGroup('platforms');
export const DASHBOARDS = navGroup('dashboards');

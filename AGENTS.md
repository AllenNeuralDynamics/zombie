# Zombie — Agent Context

## What This Is

A data explorer for AIND (Allen Institute for Neural Dynamics) data assets. A
**multi-page app** — each page is its own Vite entry + HTML file, not a single
SPA. Vite + plain ES modules, no TypeScript.

**Data engine:** DuckDB-WASM runs **in the browser** (via `@uwdata/vgplot` /
`mosaic-core`, `wasmConnector`) and reads public S3 Parquet directly over HTTPS
— no server-side database. A small Python proxy (`web/docdb_proxy.py`, port
3001) handles the few services that must run server-side (DocDB, S3 listing,
MySQL log server). In production nginx serves the static bundle and forwards
proxy routes, all on port 8000.

**UI framework policy:**
- **Simple pages** (one selector → one query → render): vanilla JS + DOM.
- **Complex stateful pages** (e.g. contributions): **Preact + htm +
  `preact/hooks`** — `import { html } from 'htm/preact'` and `useState`/
  `useEffect` from `preact/hooks`; no build changes.
- **React** is used only for `@xyflow/react` graph views; the React Vite plugin
  is scoped to `.jsx/.tsx` so it never touches the Preact `.js` code.
- Also present: `three` (3D viz), `zarrita` (Zarr/OME), `papaparse`.

Reach for Preact when a page has more than ~3 interdependent state variables or
re-renders cause visible DOM flicker.

**UI copy and descriptions:**
- Keep interface text purposeful and concise. Do not add boilerplate captions,
  helper text, tooltips, `title` attributes, or descriptions to every element
  just because it was created.

## How Data Works

`web/src/lib/bootstrap.js:bootstrap(createView, opts)` is the standard page
entry. It:
1. Fetches the metadata registry over HTTPS (no DuckDB needed), while the
   DuckDB-WASM engine downloads in parallel.
2. Wires up the Mosaic coordinator with `wasmConnector`.
3. Registers the **eager tables** (default `['asset_basics']`) as DuckDB
   tables, then mounts the view into `#app`.

**Metadata resolution** (`lib/metadata.js`): fetch `cache_versions.json` from
S3 (`allen-data-views` bucket, `data-asset-cache/` prefix), pick the latest
version, then load the **distributed registry** — each table's definition lives
at `<version>/cache_registry/<table>.json` (folder listed via S3
ListObjectsV2). Entries ("acorns"/"tables") carry `name`, `location`, `type`
(`metadata` | `asset`), and `columns`.

Each acorn registers via `CREATE OR REPLACE TABLE … AS SELECT … FROM
read_parquet(<https url>)`. Query through `coordinator.query(sql)` (returns
Apache Arrow); convert to plain rows with `arrowTableToRows()` from
`lib/arrow.js`.

**Errors:** required tables that fail throw `RequiredTablesError` and block the
page with an error box; optional tables fail into a dismissible warning.
Failures are categorized and error text is sanitized (`sanitizeErrorMessage`)
so raw URLs/tokens are never shown.

**The key table is `asset_basics`** (always loaded). Source of truth for its
columns is its registry JSON on S3 — check it before assuming a column exists.

## Routing & Page Shell — One Source of Truth

`web/build/routes.js` (the `ROUTES` manifest) is the single source of truth for
every page. Each `page({...})` entry drives, with **no other files to edit**:
- `vite.config.js` `rollupOptions.input` (build targets),
- the shared nav (`build/header-template.js` reads `nav`/`header` fields),
- nginx routing (generic resolution — see below).

The shared header and pre-paint theme script are **injected at build/dev time**
by the Vite plugin in `vite.config.js`, replacing `<!--APP_HEADER-->` and
`<!--THEME_INIT-->` placeholders — the markup is not hand-copied into pages.

nginx (`deploy/nginx.conf`) resolves ordinary routes generically: `/foo` →
`foo.html`, else 404 (no SPA fallback). Explicit nginx blocks exist **only**
for proxy routes, legacy redirects (`/subject`, `/project` → `/view`), and `/`.

## Adding a New Page — Checklist

1. `web/src/<page>/view.js` — export a view factory returning the root element.
2. `web/<page>-entry.js` — call `bootstrap((coord, metadata) => create…View(coord))`.
3. `web/<page>.html` — copy an existing page; keep `<!--THEME_INIT-->` in
   `<head>` and the `<!--APP_HEADER-->` placeholder; point `<script>` at the entry.
4. **Add one entry to `web/build/routes.js`** (`route`, `html`, `inputKey`,
   optional `header`/`nav`). This is the only wiring step — build input, nav,
   and nginx routing all derive from it. No nginx edit needed if the route
   matches the HTML filename.
5. Add styles as a new `web/styles/partials/NN-*.css` and `@import` it in
   `web/styles/app.css`.

## File Map — Read These First

| File | Why |
|------|-----|
| `web/build/routes.js` | Route/nav manifest — source of truth for all pages |
| `web/build/header-template.js` | `renderHeader`, `renderThemeInit` (shared shell) |
| `web/src/constants.js` | `VERSIONS_URL`, `S3_BUCKET`, API bases, colours |
| `web/src/lib/bootstrap.js` | Standard page entry (DuckDB + metadata + mount) |
| `web/src/lib/metadata.js` | Registry fetch/register, table SQL, error handling |
| `web/src/lib/registry.js` | Lazy table loading: `setMetadata`, `ensureTable`, `getAcorn` |
| `web/src/lib/arrow.js` | `arrowTableToRows` (Arrow → plain JS rows) |
| `web/src/lib/assets-table.js` | `buildAssetsTable` (grouped raw/derived assets) |
| `web/src/lib/docdb.js` | Direct-from-browser DocDB queries |
| `web/src/lib/utils.js` | `formatDate/Datetime`, `escHtml`, `sortRows`, `downloadCsv` |
| `web/src/subject/view.js` | Reference full page (selector → query → DOM) |
| `web/src/swdb/` | SWDB curated-set dashboard — isolated, see below |
| `web/docdb_proxy.py` | Server-side proxy (:3001): DocDB, S3 listing, log server |
| `deploy/nginx.conf`, `deploy/supervisord.conf` | Container serving / process mgmt |
| `web/styles/app.css` | `@import`s numbered partials in `styles/partials/` |

## Patterns

**Dev server:** `cd web && npm start` runs the docdb proxy + Vite together;
`npm run dev` is Vite only (proxy features disabled).

**URL param sync:**
```js
const val = new URLSearchParams(window.location.search).get('key') ?? '';
```

**DuckDB query → rows:**
```js
const result = await coordinator.query(`SELECT … FROM asset_basics WHERE …`);
const rows = arrowTableToRows(result); // from lib/arrow.js
```

**Abort on re-render:** Use `AbortController`; check `signal?.aborted` after
every `await`. See `subject/view.js`.

## SWDB Dashboard (`/swdb`, `/swdb/set`)

A deliberately **isolated** dashboard for small curated sets of *merged NWB*
assets (behavior + DLC eye tracking + RF mapping + optotagging + units in one
file). All of its code lives under `web/src/swdb/` — keep it there; only reuse
flows *inward*, nothing else imports from `swdb/`.

Two things make it different from every other page:

- **Its source assets are true HDF5** `.nwb` (~3.7 GB each), not `.nwb.zarr`, so
  they are unreadable in-browser. The `swdb` job in **biodata-cache** flattens
  them into six `platform_swdb_*` parquet tables. `swdb/data.js` is the only
  place that knows those URLs.
- **It does not use eager tables.** Both entries call
  `bootstrap(view, { requiredTables: [] })` — bootstrap is used purely to bring up
  DuckDB and resolve the cache version. Every read targets one explicit
  partition URL (`…/platform_swdb_trials/asset_name=<asset>/data.pqt`), which
  sidesteps DuckDB-WASM's inability to glob virtual-hosted HTTPS URLs and lets
  parquet column pruning keep the wide tables cheap.

The behavior viewer is **not** a fork: `swdb/dr-session.js` adapts the cached
tables into the exact data shape `dynamic_routing/`'s `DrAnimation` and
`createEventPlot` already consume, so the animation, event plot and
`playback-harness` transport are reused as-is. The one upgrade is that these
NWBs carry a real lick stream, so `responses` holds actual licks rather than the
one-per-responding-trial proxy the DR parquet cache is limited to.

Times in the cache are in the NWB session clock (t=0 = `session_start_time`);
the adapter shifts to "first trial at zero" on read.

## Plotting

**Never hand-roll SVG for charts.** Pick the tool by data source:
- **Static / pre-aggregated (plain JS array):** `@observablehq/plot` directly —
  vgplot's array wrappers break on columnar mismatch.
- **Live DuckDB with cross-filtering:** `@uwdata/vgplot` + `from(table, {
  filterBy })` — see `web/src/explorer/time-view.js`.

```js
import * as Plot from '@observablehq/plot';
const el = Plot.plot({
  color: { scheme: 'tableau10', legend: true },
  style: { background: 'transparent', fontFamily: 'inherit' },
  marks: [Plot.barY(rows, { x: 'week', y: 'n', fill: 'modality' })],
});
```

## Tests

`cd web && npm test` — Vitest. Default `node` environment (pure-function unit
tests); DOM tests use `happy-dom` and mock `coordinator.query`. Don't break them.
`npm run lint` runs ESLint over `src`.

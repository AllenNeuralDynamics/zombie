# Zombie — Agent Context

## What This Is

A data explorer for AIND (Allen Institute for Neural Dynamics) data assets. Browser SPA backed by a local DuckDB server that queries Parquet files from S3.

**Stack:** Vite + plain ES modules. DuckDB via WebSocket (`@uwdata/vgplot` / `mosaic-core`). Data from S3 Parquet read server-side. No TypeScript.

**UI framework policy:**
- **Most pages** (assets, subjects, projects, dashboards): vanilla JS + direct DOM manipulation is fine. These pages are simple: one selector → one query → render a table. No framework needed.
- **Complex stateful pages** (contributions): use **Preact + htm + `@preact/signals`**. The `htm` tagged-template syntax works in plain `.js` files with no build changes — just `import { html } from 'htm/preact'`. Preact is 3 KB and Vite handles it without extra config.

**When to reach for Preact:** if a page has more than ~3 interdependent state variables, or re-renders in response to user input cause visible DOM flicker, switch to Preact. It gives you stable DOM + VDOM diffing for free.

## How Data Works

1. At startup, `web/src/lib/metadata.js:fetchAndRegisterMetadata()` fetches `squirrel.json` from S3. This lists all available datasets ("acorns") with their S3 locations and column definitions.
2. Each acorn is registered as a DuckDB table via `CREATE OR REPLACE TABLE … AS SELECT … FROM read_parquet(…)`.
3. Pages query those tables through `coordinator.query(sql)` which returns Apache Arrow results. Use `arrowTableToRows(result)` from `web/src/lib/assets-table.js` to convert to plain JS objects.

**The key table is `asset_basics`** (always loaded). Columns: `name`, `subject_id`, `project_name`, `modalities`, `data_level`, `acquisition_start_time`, `acquisition_end_time`, `acquisition_type`, `code_ocean`, `location`, `genotype`, `age`, `experimenters`, `instrument_id`, `process_date`. Source of truth is `squirrel.json` on S3 — always check it before assuming a column doesn't exist.

## File Map — Read These First

| File | Why |
|------|-----|
| `web/src/constants.js` | `SQUIRREL_URL`, `SERVER_WS_URL`, colour tokens |
| `web/src/lib/metadata.js` | `fetchAndRegisterMetadata`, `fetchAllSubjectIds`, `arrowTableToRows` pattern |
| `web/src/lib/assets-table.js` | Shared: `buildAssetsTable`, `fetchAssetsWithSources`, `arrowTableToRows` |
| `web/src/lib/utils.js` | `formatDate`, `formatDatetime`, `escHtml`, `sortRows` |
| `web/src/assets/view.js` | Link builders: `buildS3ConsoleUrl`, `buildQcLink`, `buildMetadataLink`, `buildCoLink` |
| `web/src/subject/view.js` | Reference implementation of a full page (selector → DuckDB query → DOM) |
| `web/styles/app.css` | All CSS. CSS variables for theming. Append new sections at the end. |

## Adding a New Page — Checklist

1. Create `web/src/<page>/view.js` — export `create<Page>View({ coordinator })`.
2. Create `web/src/<page>-entry.js` — init DuckDB with `fetchAndRegisterMetadata`, call `createPageView`, append to `#app`.
3. Create `web/<page>.html` — copy any existing HTML file; update `<title>`, brand sub-text, `aria-current="page"` on the nav link, and the `<script>` src.
4. Add `<a href="/<page>">` to **every** `*.html` nav in the correct position: Assets | Subjects | Projects | Contributions | Dashboards▾.
5. Add the entry to `web/vite.config.js` `rollupOptions.input`.
6. Add CSS at the end of `web/styles/app.css`.
7. **⚠️ Add the route to `deploy/nginx.conf`** — add `location = /<page> { try_files /<page>.html =404; }` and update the routes comment at the top. This is required for Docker deployment.

**Nav order (canonical):** Assets → Subjects → Projects → Contributions → Dashboards (dropdown: Behavior sessions, SmartSPIM, Quality Control)

## Patterns

**URL param sync:**
```js
const val = new URLSearchParams(window.location.search).get('key') ?? '';
history.replaceState({}, '', new URL(window.location.href));
```

**DuckDB query → rows:**
```js
const result = await coordinator.query(`SELECT … FROM asset_basics WHERE …`);
const rows = arrowTableToRows(result); // from lib/assets-table.js
```

**Abort on re-render:** Use `AbortController`; check `signal?.aborted` after every `await`. See `subject/view.js:_loadSubject`.

**Assets table (grouped raw/derived):** Use `buildAssetsTable(assets, sourceMap)` and `fetchAssetsWithSources(coordinator, whereClause)` from `lib/assets-table.js`.

## Plotting

**Never hand-roll SVG for charts.** Use the right tool based on the data source:

- **Static/pre-aggregated data (plain JS array):** Use `@observablehq/plot` directly — vgplot's `barY`/`plot` wrappers break with array data (columnar format mismatch).
- **Live DuckDB queries with cross-filtering:** Use `@uwdata/vgplot` + `from('table', { filterBy })` — see `web/src/explorer/time-view.js`.

```js
// Static data → Observable Plot directly
import * as Plot from '@observablehq/plot';
const el = Plot.plot({
  width: 700, height: 200,
  color: { scheme: 'tableau10', legend: true },
  style: { background: 'transparent', fontFamily: 'inherit' },
  marks: [Plot.barY(rows, { x: 'week', y: 'n', fill: 'modality' })],
});

// Live DuckDB → vgplot
import { plot, barY, from, colorScheme, colorLegend, style } from '@uwdata/vgplot';
const el = plot(barY(from('table', { filterBy: sel }), { x: 'col', y: count() }), ...);
```

## Tests

`cd web && npm test` — Vitest, node environment. Pure-function unit tests only; DOM tests mock `coordinator.query`. Don't break them.

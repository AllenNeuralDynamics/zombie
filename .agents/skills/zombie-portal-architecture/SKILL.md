---
name: zombie-portal-architecture
description: Maintain the Zombie multi-page Vite portal, its shared shell, bootstrap lifecycle, routing manifest, and query conventions.
---

# Zombie portal architecture

Zombie is a multi-page Vite application: every page has its own HTML entry and ES-module entrypoint. It is not an SPA. The authoritative page manifest is `web/build/routes.js`. Add or change a page there; the manifest drives Vite inputs, the generated header/navigation, and ordinary nginx resolution. Keep `<!--THEME_INIT-->` in the HTML head, `<!--APP_HEADER-->` in the body, and let the Vite plugin inject both. Ordinary routes resolve `/foo` to `foo.html`; do not add SPA fallbacks or hand-copy the shared header.

Use `web/src/lib/bootstrap.js` for normal pages. It loads metadata and DuckDB-WASM in parallel, registers eager tables, mounts the view, and distinguishes required-table failures from optional-table warnings. Set `requiredTables: []` only for pages such as SWDB that explicitly read their own parquet partitions. Do not bypass the registry to invent table schemas: resolve the current distributed registry through `web/src/lib/metadata.js`.

Use `ensureTable()` from `web/src/lib/registry.js` for lazy tables and `queryRows()`/`arrowTableToRows()` from `web/src/lib/arrow.js` for DuckDB results. Use the existing S3 URL helpers in `metadata.js`; do not construct cache URLs ad hoc. For live DuckDB cross-filtering use `@uwdata/vgplot`; for static arrays use `@observablehq/plot`, never hand-built SVG charts.

The dev workflow is `cd web && npm start` when proxy features are needed, or `npm run dev` for Vite alone. Page tests live under `web/src/__tests__`; pure tests use Vitest's default node environment and DOM tests opt into `happy-dom` with `@vitest-environment happy-dom`. Mock coordinator queries instead of starting DuckDB.

# MOSAIC.md — Conversion Plan

Step-by-step plan for converting the ZOMBIE main data explorer from Panel/Python to Mosaic/duckdb-server.

## Prerequisites

Before starting conversion work:

1. **Define the metadata JSON schema.** zombie-squirrel must publish a JSON file to a known S3 URL containing: project names, per-project asset lists (name, subject_id, modalities, start/end times), and per-project data type definitions (column names, S3 parquet path patterns). This replaces all runtime calls to `zombie-squirrel` and `asset_basics()`. Document the schema and get a sample file committed to `data/` for development.

2. ~~**Ensure S3 parquet files are accessible from the browser.**~~ **Resolved: using `duckdb-server` backend.** The Python duckdb-server runs DuckDB with native `s3://` support and uses the standard AWS credential chain (`AWS_PROFILE`). No CORS headers, presigned URLs, or public bucket access required.

---

## Phase 1: Scaffold the Mosaic App ✅ COMPLETE

**Goal:** Minimal working app shell that initializes DuckDB-WASM, fetches metadata, and renders a placeholder.

### Steps

1. ✅ **Created `web/package.json`** — `@uwdata/vgplot`, Vite 6, Vitest 2, `@vitest/coverage-v8`

2. ✅ **Created `web/index.html`** — minimal HTML shell with `<div id="app">` mount point and CSS link.

3. ✅ **Created `web/src/app.js`**:
   - Initializes coordinator with `socketConnector()` pointing to the local duckdb-server (`ws://localhost:3000`).
   - Calls `fetchAndRegisterMetadata()` (from `metadata.js`) to fetch `squirrel.json` and register all metadata-type acorns as DuckDB tables.
   - Logs registered acorn names to console.
   - Renders a Phase-1 placeholder listing all acorns.

4. ✅ **Created `web/src/constants.js`** — `SQUIRREL_URL`, `SERVER_WS_URL`, `S3_REGION`, `AIND_COLORS`, URL param keys, default dimensions.

5. ✅ **Created `web/styles/app.css`** — AIND dark blue background + SVG pattern; card styles matching `OUTER_STYLE` from `layout.py`.

6. ✅ **Created `web/src/metadata.js`** — pure helpers (`parseSquirrelJson`, `s3PathToHttps`, `buildParquetArg`, `getMetadataAcorns`, `getAssetAcorns`, `getAcornByName`) plus DB functions (`fetchAndRegisterMetadata`, `registerAcornTable`, `dropAcornTable`).

7. ✅ **Created `web/src/__tests__/constants.test.js`** and **`web/src/__tests__/metadata.test.js`** — 32 Vitest unit tests covering all pure functions; all passing.

8. ✅ **Created `web/vite.config.js`** — test environment config. (DuckDB-WASM exclusion removed since we now use the server.)

9. ✅ **Copied `aind-pattern.svg`** → `web/public/images/` (Vite static asset).

10. ✅ **Updated `.github/workflows/test_and_lint.yml`** — added `js-ci` job (Node 20, `npm ci`, `npm test`, `npm run build`) alongside existing `python-ci` job.

**Switch to duckdb-server (post Phase 1):** S3 bucket requires AWS credentials — `wasmConnector` dropped in favour of `socketConnector` + `duckdb-server` Python package installed via `pyproject.toml`. AWS credentials resolved via `AWS_PROFILE` in the server process. Bundle size dropped from 297 kB to 103 kB (DuckDB-WASM no longer bundled).

**Verification:** `npm test` → 54/54 pass. `npm run build` → clean 103 kB bundle.

---

## Phase 2: Settings Bar — Project & Data Type Selection ✅ COMPLETE

**Goal:** User can select a project and enable data types. Changing the project populates data type options.

### Steps

1. ✅ **Created `web/src/settings.js`**:
   - Pure URL helpers (`getInitialProjectFromUrl`, `getInitialDataTypesFromUrl`, `buildSettingsUrl`) — exported and unit-tested.
   - `initSettings(coord, metadata)` — creates a `$project` Param bound to a Mosaic `menu` widget (queries `unique_project_names` table). Returns `{ $project, getEnabledTypes, settingsEl }`.
   - Checkbox toggles for each asset-type acorn: checking registers the DuckDB table via `registerAcornTable`; unchecking drops it via `dropAcornTable`. Checkboxes are disabled while async table registration is in flight.
   - Both project selection and enabled data types are synced to URL query params via `history.replaceState` on every change. Initial state is restored from URL on load.

2. ✅ **Wired into `web/src/app.js`**: after metadata fetch, `initSettings()` is called and its `settingsEl` is appended to `#settings-bar`. `$project` changes are logged (Phase 3 will consume them for TimeView).

3. ✅ **Added CSS** in `web/styles/app.css`: styles for `.settings-content`, `.project-menu`, `.data-type-toggles`, `.toggles-label`, `.data-type-label`.

4. ✅ **Created `web/src/__tests__/settings.test.js`** — 20 unit tests covering all three pure URL helpers, including round-trip tests. All passing (`npm test` → 52/52).

**Verification:** `npm test` → 54/54 pass. `npm run build` → clean 103 kB bundle.

---

## Phase 3: TimeView — Session Timeline with Brush Selection ✅ COMPLETE

**Goal:** Horizontal rectangles showing sessions on a time axis. Dragging selects a time range that will filter DataViews.

### Steps

1. ✅ **Created `web/src/time-view.js`**:
   - Exported column-name constants (`TIME_TABLE`, `TIME_COL_START`, `TIME_COL_END`, `TIME_COL_SUBJECT`, `TIME_COL_PROJECT`) and pure helpers (`buildRectMarkOptions`, `buildProjectClause`) for unit testing.
   - `createTimeView($project)` factory:
     - Creates `$timeSelection = Selection.crossfilter()` — returned to callers so DataViews can subscribe.
     - Creates `$projectFilter = Selection.intersect()` driven by the `$project` Param; uses `eq(col, literal(value))` predicate so the TimeView always shows sessions for the selected project.
     - Builds a `plot()` with `rect` marks sourced from `asset_basics` (filtered by `$projectFilter`), `x1: acquisition_start_time`, `x2: acquisition_end_time`, `y: subject_id`.
     - Attaches `intervalX({ as: $timeSelection })` interactor.
     - Returns `{ $timeSelection, el }` where `el` is a `.card.time-view` container ready to mount.

2. ✅ **Created `web/src/__tests__/time-view.test.js`** — 18 unit tests covering all pure helpers and constants. All passing.

3. ✅ **Wired into `web/src/app.js`**: `createTimeView($project)` called after settings init; `el` appended to `#app`; `$timeSelection` stored for Phase 4 DataViews. Removed Phase 2 placeholder renderer.

4. ✅ **Added CSS** in `web/styles/app.css`: `.time-view`, `.view-header`, `.placeholder-note`.

**Verification:** `npm test` → 72/72 pass. `npm run build` → clean bundle.

---

## Phase 4: DataView — Interactive Scatter Plot ✅ COMPLETE

**Goal:** A single configurable scatter plot that queries a data type table and is filtered by the TimeView selection.

### Steps

1. ✅ **Created `web/src/data-view.js`**:
   - Pure helpers exported: `getInitialColumns(columns)`, `buildDotMarkOptions($xCol, $yCol, $byCol, fillColor)`.
   - `createDataView(id, $timeSelection, metadata)` factory:
     - **Settings panel** (left side): native `<select>` dropdowns for data type, x-column, y-column, and color-by column. Column options are populated from the metadata JSON (`acorn.columns`) — no extra DB queries needed.
     - **Plot** (right side): `plot()` with `dot` mark, `from(<dataType>, { filterBy: $timeSelection })`, encodings `x: $xCol`, `y: $yCol`, `fill: $byCol` (static colour when unset).
     - `$xCol` and `$yCol` are `Param` instances — Mosaic re-queries automatically when they change.
     - Color-by and data type changes trigger a full plot rebuild (new `from()` binding required).
   - Returns `{ el }` — a `.card.data-view` container ready to mount.

2. ✅ **Dynamic `from()` table switching** handled by destroying and re-creating the plot element inside a stable `plotContainer` div.

3. **Per-view column filtering:** deferred to a later phase; the infrastructure (settings panel) is in place.

4. ✅ **Wired into `web/src/app.js`**: `createDataView('1', $timeSelection, metadata)` rendered in a `.data-views-container` flex wrapper below the TimeView.

5. ✅ **Added CSS** in `web/styles/app.css`: `.data-views-container`, `.data-view`, `.data-view-layout`, `.data-view-settings`, `.dv-select-label`, `.dv-select`, `.data-view-plot`.

6. ✅ **Created `web/src/__tests__/data-view.test.js`** — 10 unit tests for pure helpers. `npm test` → 94/94 pass. `npm run build` → clean bundle.

**Verification:** `npm test` → 94/94 pass. `npm run build` → clean 498 kB bundle.

---

## Phase 5: Multiple DataViews + Add/Remove

**Goal:** User can add and remove DataView instances. All share the global time selection.

### Steps

1. **Add "Add Data View" button** in `app.js` that calls `createDataView(newId, $timeSelection)` and appends the result to the flex container.

2. **Add remove button** to each DataView's settings panel. Clicking removes the DOM element and disconnects its clients from the coordinator (`coordinator().disconnect(client)`).

3. **Minimum one DataView** — disable the remove button if only one remains.

4. **Verify:** Multiple DataViews render independently. Each has its own column/data type settings. All respond to the TimeView brush.

---

## Phase 6: Polish & Parity

**Goal:** Match the look and feel of the current app and add remaining features.

### Steps

1. **Styling:**
   - Port the AIND dark background, card styles with rounded corners and subtle borders (from `OUTER_STYLE` and `INNER_STYLE` in the old code).
   - Style input widgets to match the current theme.
   - Responsive layout with CSS flexbox (vgplot's `hconcat`/`vconcat` helpers).

2. **URL state sync:**
   - Sync `$project`, enabled data types, and potentially DataView configurations to URL query params.
   - On load, restore state from URL.

3. **Hover tooltips:**
   - Configure `tooltip` channel on scatter marks with relevant columns (currently configurable via `hover_cols` in the old DataViewSettings).

4. **Error handling:**
   - Handle S3 access failures gracefully (show message if parquet files are unreachable).
   - Handle empty query results (show "No data" message).

5. **Loading states:**
   - Show spinner/skeleton while DuckDB-WASM initializes and while large queries execute.
   - Mosaic's `queryPending()` / `queryResult()` lifecycle can drive this.

6. **SpaceView placeholder:**
   - Add an empty styled container where SpaceView will eventually go.

---

## Phase 7: Cleanup & Deployment

### Steps

1. **Production build:** Configure Vite (or chosen bundler) for production output — minified JS, hashed assets.

2. **Deployment:** The app is static files (HTML + JS + CSS). Deploy to S3 + CloudFront, or any static hosting.

3. **Remove old Panel code** (or move to `legacy/` branch) once the Mosaic version is validated.

4. **Update `pyproject.toml` / `setup.py`** — remove Panel, HoloViews, hvplot, Bokeh dependencies. Add a `package.json`-based build step if the project needs to be pip-installable (or restructure as a pure JS project).

5. **Update README.md** with new dev instructions (`npm install`, `npm run dev`).

---

## Risks & Open Questions

| Risk | Mitigation |
|---|---|
| S3 CORS / auth | Resolved: using duckdb-server backend. AWS_PROFILE provides credentials server-side. |
| Large parquet files slow | DuckDB supports predicate pushdown on Parquet. Use column projection in queries. vgplot M4 optimization reduces drawn points. |
| Dynamic table switching in vgplot | vgplot marks bind to a table at creation. Changing the table may require re-creating the plot. Accept this if needed — it's fast. |
| Metadata JSON schema changes | Version the schema. App checks version and shows an error if incompatible. |
| Custom brain visualization (SpaceView) | Out of scope for now. When needed, implement as a custom Mosaic client using Canvas/WebGL. |
| Server not running when opening app | App should show a clear "Cannot connect to DuckDB server" error with instructions to run `npm run server`. |

## Conversion Mapping

Quick reference for translating old code concepts:

| Old (Panel/Python) | New (Mosaic/JS) |
|---|---|
| `pn.Param.watch()` / `@param.depends` | `Param` subscriptions, Mosaic coordinator auto-re-query |
| `pn.widgets.MultiChoice` | `mosaic-inputs` `menu` with multi-select |
| `pn.widgets.CheckBoxGroup` | HTML checkboxes bound to Params |
| `hv.Rectangles` | `vgplot` `rect` marks |
| `df.hvplot.scatter()` | `vgplot` `dot` marks with `from(tableName)` |
| `hv.streams.BoundsXY` | `intervalXY` interactor → Selection |
| `load_dataframe_from_s3()` + DuckDB | `read_parquet('s3://...')` via duckdb-server (same DuckDB engine, now runs in the Python server) |
| `@pn.cache` | Mosaic coordinator built-in query cache |
| `pn.state.location.sync()` | `history.replaceState()` / URL search params |
| Module-level singletons (`query_settings`, etc.) | Params and Selections exported from modules |
| `pn.Column` / `pn.Row` / `pn.FlexBox` | `vconcat` / `hconcat` / CSS flexbox |
| `pn.Modal` | HTML `<dialog>` element or CSS modal |
| Panel serve (`panel serve app.py`) | `npm run dev` (Vite :5173) + `npm run server` (duckdb-server :3000) |

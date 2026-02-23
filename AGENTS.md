# AGENTS.md — ZOMBIE Data Explorer (Mosaic Architecture)

## What This App Does

ZOMBIE (Zoomable Observatory for Multi-scale Brain Investigation and Exploration) is an interactive data explorer for neuroscience datasets stored as Parquet files on S3. A user selects a project, chooses data types, configures axis mappings and filters, and the app renders interactive scatter plots and time-series visualizations. Plots support linked brushing: selecting a time range in one view filters data in all other views.

The app has **one entry point** (the main data explorer). Other apps (subject viewer, asset browser, contributions editor) exist in the codebase under `src/zombie/subject_contents/`, `src/zombie/assets_contents/`, and `src/zombie/contributions.py` but are **out of scope** for the Mosaic version.

## Architecture Overview

The app is a **single-page application** backed by a local Python DuckDB server using:

- **[Mosaic](https://idl.uw.edu/mosaic/)** — framework for linking visualizations via a central coordinator + DuckDB
- **[duckdb-server](https://github.com/uwdata/mosaic/tree/main/packages/duckdb-server)** — lightweight Python server that runs a local DuckDB instance; the browser connects via WebSocket. Handles `s3://` paths natively using the AWS credential chain (`AWS_PROFILE`).
- **[vgplot](https://idl.uw.edu/mosaic/vgplot/)** — Mosaic's grammar of interactive graphics (renders SVG via Observable Plot); supports linked selections/brushes across plots
- **[mosaic-inputs](https://idl.uw.edu/mosaic/inputs/)** — data-driven input widgets (menus, search, tables) that participate in Mosaic's selection/param system

The browser sends SQL queries over WebSocket to the local DuckDB server. The server executes them against S3 Parquet files using the active AWS profile and streams results back as Apache Arrow. **No data files are served to the browser.**

### Core Mosaic Concepts Used

| Concept | Role in ZOMBIE |
|---|---|
| **Coordinator** | Central hub. Manages query lifecycle, caching, and optimization. Configured with `socketConnector()` pointing to the local duckdb-server. |
| **Client** | Each plot mark and input widget is a client. Clients declare data needs as SQL queries; the coordinator executes them against DuckDB and returns results. |
| **Selection** | A reactive predicate (SQL `WHERE` clause) shared across clients. When the user brushes a time range in the TimeView, it populates a `Selection.crossfilter()` that filters all DataView plots. |
| **Param** | A reactive scalar value. Used for settings like selected project name, data type, axis column names. When a Param updates, all subscribed clients re-query. |
| **vgplot marks** | `dot`, `rectY`, `areaY`, `line`, `rect`, `text`, etc. Each mark is a Mosaic client that builds its own SQL query from its encoding channels. |
| **Interactors** | `intervalX`, `intervalXY`, `toggle`, `panZoom`, `highlight` — attached to plots to populate Selections from user gestures. |

## Data Model

### Metadata File

A single JSON file at a **known S3 URL** describes all available datasets ("acorns"). This file is published by `zombie-squirrel` (an external tool) and replaces direct use of `zombie-squirrel` as a Python library.

**URL:** `s3://aind-scratch-data/application-caches/squirrel.json`

```jsonc
{
  "acorns": [
    {
      "name": "unique_project_names",           // human-readable identifier
      "location": "s3://aind-scratch-data/application-caches/zs_unique_project_names.pqt",
      "partitioned": false,                      // single file
      "partition_key": null,
      "type": "metadata",                        // "metadata" = global lookup tables
      "columns": ["project_name"]
    },
    {
      "name": "asset_basics",
      "location": "s3://aind-scratch-data/application-caches/zs_asset_basics.pqt",
      "partitioned": false,
      "partition_key": null,
      "type": "metadata",
      "columns": [
        "_id", "_last_modified", "modalities", "project_name", "data_level",
        "subject_id", "acquisition_start_time", "acquisition_end_time",
        "code_ocean", "process_date", "genotype", "location", "name"
      ]
    },
    {
      "name": "quality_control",
      "location": "s3://aind-scratch-data/application-caches/zs_qc/",
      "partitioned": true,                       // directory of parquet files
      "partition_key": "subject_id",             // partitioned by this column
      "type": "asset",                           // "asset" = per-asset data tables
      "columns": [
        "name", "stage", "object_type", "modality", "value",
        "tags", "status", "status_history", "asset_name"
      ]
    }
    // ...more acorns (unique_subject_ids, source_data, raw_to_derived, etc.)
  ]
}
```

Each acorn entry describes one dataset:

| Field | Meaning |
|---|---|
| `name` | Identifier used to reference this dataset (e.g. `"asset_basics"`, `"quality_control"`). |
| `location` | S3 path — either a single `.pqt` file or a directory (trailing `/`) of partitioned parquet files. |
| `partitioned` | If `true`, `location` is a directory containing multiple parquet files partitioned by `partition_key`. |
| `partition_key` | Column used for partitioning (e.g. `"subject_id"`). `null` if not partitioned. |
| `type` | `"metadata"` for global lookup tables, `"asset"` for per-asset data. |
| `columns` | Array of column names present in the parquet file(s). |

**Acorn types:**
- **`metadata`** acorns (`asset_basics`, `unique_project_names`, `unique_subject_ids`, `source_data`, `raw_to_derived`) — global lookup/reference tables. `asset_basics` is the most important: it contains one row per data asset with project, subject, modality, and time range.
- **`asset`** acorns (`quality_control`, and more to come) — actual data tables the user visualizes. These are typically partitioned by `subject_id` for efficient querying.

### Data Files

All data lives as **Parquet files on S3**. The duckdb-server reads them server-side using `read_parquet('s3://...')` with DuckDB's built-in httpfs extension. AWS credentials are resolved automatically from the active `AWS_PROFILE`. The metadata JSON provides the S3 locations; the app registers them as DuckDB tables via `CREATE OR REPLACE TABLE ... AS SELECT * FROM read_parquet(...)` commands sent to the server.

## Application Structure

```
┌─────────────────────────────────────────────────────────────┐
│  App Shell (HTML + JS)                                      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Settings Bar                                        │    │
│  │  • Project selector (menu input → Param)             │    │
│  │  • Data type checkboxes (→ Param)                    │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  TimeView                                            │    │
│  │  • hv.rect marks showing session time ranges         │    │
│  │  • intervalX interactor → time Selection             │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  DataView 1       │  │  DataView 2       │  (+ Add)      │
│  │  • Settings panel │  │  • Settings panel │               │
│  │  • vgplot scatter │  │  • vgplot scatter │               │
│  │  • filterBy: time │  │  • filterBy: time │               │
│  │    Selection      │  │    Selection      │               │
│  └──────────────────┘  └──────────────────┘                 │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  SpaceView (future)                                  │    │
│  │  • Spatial visualization placeholder                 │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Components

#### 1. Settings Bar

**Purpose:** Global query configuration — which project and data types to explore.

**Mosaic implementation:**
- A `menu` input bound to a `Param` (`$project`) listing project names queried from the `unique_project_names` DuckDB table (registered at startup from the metadata JSON).
- When `$project` changes, the app filters `asset_basics` by `project_name` to get sessions and available assets for the selected project.
- Checkbox or toggle inputs for selecting which data types (the `"asset"`-type acorns, e.g. `quality_control`) to enable, bound to Params.
- URL state sync: `$project` and enabled data types should be reflected in URL query params for shareability.

#### 2. TimeView

**Purpose:** Show all sessions as horizontal rectangles on a timeline axis. The user drags to select a time range, which cross-filters all DataViews.

**Mosaic implementation:**
- A `plot()` with `rect` marks. Each rectangle spans `[acquisition_start_time, acquisition_end_time]` on the x-axis and an arbitrary row index on y.
- Data source: the `asset_basics` DuckDB table, filtered by `project_name = $project`.
- An `intervalX` interactor bound to a `Selection.crossfilter()` (`$timeSelection`).
- The selection emits a predicate like `ts BETWEEN <start> AND <end>`.
- All DataView plots declare `filterBy: $timeSelection` so they auto-filter when the brush updates.

#### 3. DataView (one or more)

**Purpose:** An interactive scatter plot of queried data, with its own local settings for axis mapping, color, and column-level filtering.

**Mosaic implementation:**
- Each DataView is a `plot()` with a `dot` (scatter) mark sourcing from a DuckDB table.
- Encoding channels `x`, `y`, and optionally `fill`/`stroke` (color-by) are driven by Params bound to dropdown inputs (column selectors).
- The plot declares `filterBy: $timeSelection` to participate in the global time cross-filter.
- Additional per-view filtering: a `menu` input for choosing a filter column and a multi-select for filter values, wired to a local Selection or as SQL `WHERE` clauses in the mark's `from()`.
- The user can add/remove DataView instances dynamically. Each instance has independent column/filter settings but shares the global `$timeSelection`.
- Plot dimensions, title, and axis labels are configurable via UI controls bound to Params.

**Column selection workflow:**
1. User picks a data type → app looks up columns from the metadata JSON.
2. Column names populate dropdown Params for x, y, color-by, filter column.
3. Changing a column Param triggers a re-query (Mosaic handles this automatically).

#### 4. SpaceView (future / placeholder)

Intended for spatial visualization (brain coordinates, probe locations). Not yet implemented. Will likely use custom Mosaic clients or `geo` marks when ready.

## Data Loading Flow

```
1. App starts
   → fetch squirrel.json from s3://aind-scratch-data/application-caches/squirrel.json
   → parse acorns array
   → register metadata acorns as DuckDB tables:
       CREATE TABLE asset_basics AS SELECT * FROM read_parquet('s3://...zs_asset_basics.pqt')
       CREATE TABLE unique_project_names AS SELECT * FROM read_parquet('s3://...zs_unique_project_names.pqt')
   → populate $project Param options from unique_project_names table

2. User selects a project ($project Param updates)
   → filter asset_basics WHERE project_name = $project
   → this gives session list (acquisition times, subject IDs, asset names) for TimeView
   → populate data type selector with available "asset"-type acorns

3. User enables a data type (e.g. "quality_control")
   → register its parquet data as a DuckDB table:
       - If not partitioned: CREATE TABLE quality_control AS SELECT * FROM read_parquet('s3://...file.pqt')
       - If partitioned: CREATE TABLE quality_control AS SELECT * FROM read_parquet('s3://...dir/*.pqt', hive_partitioning=true)
   → optionally filter to relevant subject_ids for the selected project
   → DataView column selectors can now reference quality_control columns

4. User configures a DataView (x=ts, y=value, color=modality)
   → Mosaic coordinator builds SQL: SELECT ts, value, modality FROM quality_control WHERE <timeSelection predicate>
   → DuckDB server executes, returns Arrow
   → vgplot renders scatter plot

5. User brushes time range in TimeView
   → $timeSelection updates with predicate: ts BETWEEN <start> AND <end>
   → coordinator re-queries all DataViews with new WHERE clause
   → plots update
```

## Key Technical Details

- **S3 access via duckdb-server:** The server-side DuckDB uses `PROVIDER CREDENTIAL_CHAIN` in a DuckDB `SECRET` to load AWS credentials from the standard chain (env vars, `~/.aws/config`, IAM roles). `AWS_PROFILE` is respected automatically. No CORS or presigned URLs are needed — all Parquet I/O happens server-side.
- **Table registration:** When a data type is enabled, its Parquet files are registered as a DuckDB table using the `s3://` `location` from its acorn entry. For non-partitioned acorns: `read_parquet('s3://...file.pqt')`. For partitioned acorns: `read_parquet('s3://...dir/*.pqt', hive_partitioning=true, union_by_name=true)`.
- **Cross-filtering:** Uses `Selection.crossfilter()` so that the TimeView brush filters DataViews but does not filter itself.
- **Dynamic DataViews:** The app must support adding/removing DataView instances at runtime. Each new DataView creates new vgplot mark clients that subscribe to the shared `$timeSelection`.
- **Caching:** The Mosaic coordinator caches query results automatically. Identical queries (same table + filters + columns) return cached Arrow buffers.
- **Per-pixel optimization:** For time-series marks (`areaY`, `lineY`), vgplot applies M4 optimization to reduce drawn points to ~1 per pixel.
- **Dev workflow:** Two processes run concurrently: `npm run dev` (Vite on :5173) and `npm run server` (duckdb-server on :3000, WebSocket + HTTP REST).

## File Layout (Target)

```
web/
├── index.html              # Entry point, loads JS bundle
├── src/
│   ├── app.js              # Initialize coordinator + socketConnector, fetch metadata, render shell
│   ├── metadata.js         # Fetch + parse the S3 metadata JSON, register DuckDB tables
│   ├── settings.js         # Project selector, data type toggles, URL sync
│   ├── time-view.js        # TimeView plot + intervalX interactor
│   ├── data-view.js        # DataView component (plot + settings panel + column selectors)
│   └── constants.js        # S3 metadata URL, server URL, default settings, style config
├── styles/
│   └── app.css             # Layout and styling
├── package.json            # @uwdata/vgplot; scripts: dev, server, build, test
└── vite.config.js

# Server (Python) — installed into the project venv via pyproject.toml
# Start with: npm run server  (runs .venv/bin/duckdb-server on ws://localhost:3000)
# The server inherits AWS_PROFILE from the shell environment.
```

## Existing Code Reference

The old Panel/Python implementation lives in `src/zombie/`. Key files for understanding existing behavior:

| Old file | What it does | Mosaic equivalent |
|---|---|---|
| `app_contents/main_view.py` | Top-level layout, wires TimeView↔DataView | `app.js` — coordinator setup + layout |
| `app_contents/time_view.py` | Session timeline, box-select → selection | `time-view.js` — `rect` marks + `intervalX` |
| `app_contents/data_view.py` | Scatter plot + settings, filters by time | `data-view.js` — `dot` marks + `filterBy` |
| `app_contents/data_view_settings.py` | Column pickers, filter config | `data-view.js` settings panel (Params + inputs) |
| `app_contents/data_view_utils.py` | S3 path resolution, DuckDB queries, `load_dataframe_from_s3()` | `metadata.js` — table registration |
| `settings/query_settings.py` | Project name multi-select, asset/subject filtering | `settings.js` — `$project` Param + menu |
| `settings/loader_settings.py` | Session times, data type checkboxes | `settings.js` — data type Params |
| `settings/settings_view.py` | Modal wrapping query + loader settings | Part of `settings.js` or modal HTML |
| `layout.py` | CSS background styling | `styles/app.css` |

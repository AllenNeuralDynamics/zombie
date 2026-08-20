---
name: zombie-search-and-assets
description: Extend Zombie search, asset tables, client-side filtering, metadata-viz query translation, and asset lineage links.
---

# Zombie search and assets

The `/search` page (`web/src/assets/view.js`) registers `asset_basics` once, loads its rows, and performs sorting, filtering, and pagination in the browser. Keep URL state in `sort`, `dir`, `page`, `cols`, and `f_<column>` parameters; persist visible columns only through the existing `assets_cols` cookie. Select controls are appropriate only when a column has at most `SELECT_THRESHOLD` (40) unique values. The page size is 100. Treat the current `asset_basics` registry fragment as the schema source of truth.

Use `buildAssetsTable()` and `fetchAssetsWithSources()` from `web/src/lib/assets-table.js`. The latter lazily loads `source_data` and joins it to `asset_basics`; do not duplicate that join. `source_data.source_data` is a comma-and-space-separated list of source asset names. `buildAssetsTable()` groups a raw asset with derived children only when the source is present in the result and leaves orphan derived assets visible. Preserve its 100-row pagination and existing link helpers when changing columns.

The query builder maps UI filters to Mongo paths: project → `data_description.project_name`, subject → `subject.subject_id`, modalities → `data_description.modalities.abbreviation`, data level → `data_description.data_level`, acquisition type → `acquisition.acquisition_type`, and date filters → `acquisition.acquisition_start_time`. It POSTs names-only filters to `/metadata-viz/retrieve-records` in production (the dev base is the metadata portal host), then filters the local asset rows by returned `asset_names`. Natural-language query upgrades use `/metadata-viz/upgrade-query`.

When adding asset links, preserve the distinction between raw and processed records: processed S3, Code Ocean, QC, and metadata links target the processed asset when one exists, otherwise the raw asset. Test the pure filter/query-builder logic in node and use `happy-dom` only for DOM rendering tests; mock fetch and coordinator responses.

---
name: zombie-operations-and-swdb
description: Maintain Zombie operational dashboards, time models, session log joins, storage analysis, and the isolated SWDB dashboard.
---

# Zombie operations and SWDB

The sessions page combines `asset_basics` with `/log-server/camstim-completed`; use `pickTableForRange()`, `quarterDateRange()`, `logRowToSession()`, and `mergeLogSessions()`, and preserve URL state. Timeline models acquisition → upload → processing → next 06:00 Pacific release; reuse its existing time helpers and `source_data`. Size uses the resolved storage-lens parquet plus `source_data` and `asset_basics` in a full outer join. Analysis Framework reads public DocDB-v1 analysis collections in chunks of 5000 and lists PNGs through `/s3-list`; keep its fixed project registry. Names is an `asset_basics` lineage graph.

SWDB is intentionally separate from the normal eager-table path. Use `bootstrap(view, {requiredTables: []})`; `web/src/swdb/data.js` owns the table URLs. Sessions are unpartitioned; wide tables use explicit `asset_name=<asset>/data.pqt` partitions. Validate asset names with the existing allowlist, select only needed columns, and decimate in DuckDB before returning traces. The DR adapter converts session-clock times to first-trial-zero and supplies the real lick stream to the reused animation/event-plot/playback components.

Test timezone boundaries, log merging, release-time calculations, and URL state with fixtures. Test SWDB adapters with small partition-shaped fixtures and assert that unsafe names are rejected before any fetch.

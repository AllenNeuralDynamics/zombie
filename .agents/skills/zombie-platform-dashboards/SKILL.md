---
name: zombie-platform-dashboards
description: Build and extend Zombie's shared platform overview pages and their platform-specific cache queries.
---

# Zombie platform dashboards

Start platform pages with `createPlatformOverview()` from `web/src/lib/platform-overview.js`. It owns the common heading, settings, date range, modality, QC, session summary, time-to-QC, and processing-status sections. Add platform-specific content through the existing overview extension points rather than copying shell logic.

Use `ensureTable()` and `queryRows()` for platform cache data. Preserve the current contracts: SmartSPIM and exaSPIM join raw/processed `asset_basics` with `platform_smartspim`/`platform_exaspim`; fiber photometry uses `platform_fib` and pivots long-form asset/fiber/channel rows with `pivotLongFormRows()`; dynamic foraging uses `platform_dynamic_foraging_sessions` plus `behavior_curriculum`; VR filters `acquisition_type='AindVrForaging'`; dynamic routing filters `project_name='Dynamic Routing'`; SLAP2 filters modality `slap2`. Dynamic-foraging session figures are capped at 60 and its operations table is `platform_df_operations`.

For processed rows, route S3, Code Ocean, QC, and metadata links to the processed asset and fall back to the raw asset. Follow the existing lazy-table and optional-table error handling. Tests should mock `coordinator.query()` and assert generated SQL, filters, pivot input, and rendered states; do not require live S3 or DuckDB.

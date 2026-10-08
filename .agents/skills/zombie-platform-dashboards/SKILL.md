---
name: zombie-platform-dashboards
description: Extend Zombie platform overview pages and their platform cache integrations.
---

# Zombie platform dashboards

Build on the shared platform overview instead of copying its shell, settings, or common summaries. Find the current extension points in web/src/lib/platform-overview.js and keep platform-specific queries and presentation in the relevant page module.

Resolve tables through the cache registry and load optional platform data lazily. Before joining tables, inspect their current grain, partitioning, and provenance in biodata-cache and the published registry. A raw acquisition and a processed asset can be different link targets; route storage, processing, QC, and metadata links to the asset represented by the row. Keep missing optional data and query errors visible through the shared page conventions.

When a platform cache schema changes, update its builder and consumer together. Verify the query and rendered states with representative rows rather than relying on live S3.

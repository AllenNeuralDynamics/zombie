---
name: zombie-operations-and-swdb
description: Maintain Zombie operational dashboards, their time and provenance models, and the isolated SWDB dashboard.
---

# Zombie operations and SWDB

Operational dashboards combine cache tables with service or log data. Start with the relevant page's data and time helpers before changing a join or time calculation. Keep acquisition, processing, upload, and release clocks distinct; make timezone conversions explicit. Use provenance keys for asset relationships, and preserve URL state through the page's existing parser. Check current route stability in the route manifest rather than assuming a page's release channel.

SWDB is an isolated adapter under web/src/swdb. Its large source files are flattened by biodata-cache for browser reads. Resolve cache locations in its data module, validate asset identifiers before using them in URLs or SQL, and read explicit partitions because browser DuckDB cannot glob the virtual-hosted S3 paths. Prune columns and reduce wide traces before materializing them. Reuse shared behavior playback components through adapters, without spreading SWDB cache knowledge into other pages.

When changing time or session adapters, verify timezone boundaries and representative asset joins.

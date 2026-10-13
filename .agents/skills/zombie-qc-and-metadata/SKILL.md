---
name: zombie-qc-and-metadata
description: Extend Zombie QC editing, metadata views, and their DocDB, QC Portal, and cache integrations.
---

# Zombie QC and metadata flows

QC, record, and star views read live metadata through DocDB. Use the existing QC data helpers for status history, metric values, grouping, and references; check the current QC schema before changing their interpretation. The authenticated editor sends reviewed changes through the QC Portal API. Signed-out views must show source data without applying private drafts. Scope drafts to the asset and recheck the live record before submission so concurrent changes are visible.

## Adding QC metrics

An add-metrics action should derive eligibility and complete metric definitions from the asset metadata and an authoritative metric source. Build candidates in a focused QC helper, exclude metrics already saved or queued, and keep the action visible but disabled when nothing is eligible. Queue candidates for the editor's normal review and authenticated submission flow through the current QC Portal API contract. Preserve the portal's tag schema: its type grouping requires a type tag, while an evaluation tag serves a different purpose. Choose references for the metric's purpose rather than reusing an unrelated link.

The editor uses the live record to decide what can be added. A cache table, when one is needed, snapshots metrics already present in DocDB for search or analysis after a sync. It does not automatically feed the add action. In the sibling biodata-cache repo, define the table's grain and source fields in a cache helper, register its schema and sync ownership in table_specs.py, ensure the helper is imported for registration, and have the owning job build and publish its registry fragment. Keep any metric-recognition rules coordinated with the editor's builder and the authoritative definitions. Inspect the current QC helpers and cache job before extending either existing metric family or adding a new one.

## Other metadata flows

Reuse shared metadata conversion and upgrade helpers for the upgrade page. Migration and proposal views use the current metadata service and authenticated API client; the server remains authoritative for proposals and permissions. Coordinate contract changes with that service rather than adapting one client to an unverified endpoint.

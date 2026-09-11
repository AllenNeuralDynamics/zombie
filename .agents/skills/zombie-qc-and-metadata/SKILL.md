---
name: zombie-qc-and-metadata
description: Maintain Zombie QC, record, star, metadata-upgrade, and migration flows across DocDB, cache tables, metadata-viz, and QC Portal.
---

# Zombie QC and metadata flows

The `/quality_control?name=` page is a DocDB-v2 reader with optional raw-source lookup; it does not need DuckDB. In `web/src/qc/data.js`, select the latest `status_history` entry as the current status, use `Pending` when absent, and aggregate `Fail > Pending > Pass`. Decode `json:` values, apply the default grouping and modality grouping for multimodal records, and resolve reference metrics through `resolveReference()`. The edit link is the live QC Portal URL `/view?name=...`. `/record` and `/star` remain direct DocDB flows; reuse `star/extract.js` for star payloads.

Keep the Preact QC editor auth-gated; use OIDC `profile` claims for display names, not opaque account IDs. Reuse `qc/editor.js` storage helpers: persist tree/table mode locally (not in the URL), keep its toggle available when signed out, and scope drafts to the asset. Apply drafts only when authenticated; signed-out views show source values and statuses. Clear drafts after successful submission or through settings. Delegate editability to `qc/edit-model.js`: changing populated values or existing statuses requires opt-in, but setting a missing manual status does not; auto-status metrics have no manual status editor. Preserve the existing settings control and layout: tree view scrolls with the document; table view has one vertical scroll owner, `.qc-container`, not `.qc-table-content`.

The `/upgrade` page lazy-loads `metadata_upgrade` and POSTs to the metadata-viz proxy. Reuse the existing metadata field conversion (`session` → `acquisition`, `rig` → `instrument`) and upgrade helpers rather than rewriting payload normalization.

The migration pages use the QC Portal proposals API through `web/src/migrate/lib.js`: list/create at `/metadata/proposals`, fetch/withdraw at `/metadata/proposals/:id`, and POST approve/reject actions. Preserve `credentials: 'include'`, structured `QcError` handling, and approval of the displayed `body_hash`. The server enforces second-actor approval and detects record drift; rebasing creates a new proposal that supersedes the stale one.

Test QC aggregation, grouping, reference extraction, and upgrade normalization as pure functions; mock DocDB and HTTP at the view boundary for page tests.

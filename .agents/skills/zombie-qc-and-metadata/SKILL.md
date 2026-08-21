---
name: zombie-qc-and-metadata
description: Maintain Zombie QC, record, star, metadata-upgrade, and migration flows across DocDB, cache tables, metadata-viz, and QC Portal.
---

# Zombie QC and metadata flows

The `/quality_control?name=` page is a DocDB-v2 reader with optional raw-source lookup; it does not need DuckDB. In `web/src/qc/data.js`, select the latest `status_history` entry as the current status, use `Pending` when absent, and aggregate `Fail > Pending > Pass`. Decode `json:` values, apply the default grouping and modality grouping for multimodal records, and resolve reference metrics through `resolveReference()`. The edit link is the live QC Portal URL `/view?name=...`. `/record` and `/star` remain direct DocDB flows; reuse `star/extract.js` for star payloads.

The `/upgrade` page lazy-loads `metadata_upgrade` and POSTs to the metadata-viz proxy. Reuse the existing metadata field conversion (`session` → `acquisition`, `rig` → `instrument`) and upgrade helpers rather than rewriting payload normalization.

The migration pages in `web/src/migrate/` currently call the deployed QC host's legacy endpoints: `GET /metadata/token?id=...&redirect=...`, `GET /metadata/pending`, and `POST /metadata/v1` or `/metadata/v2?auth-token=...`, with the `qc_auth_token` cookie and DocDB polling. The current `aind-qc-portal/plugin.py` source exposes a different proposal API (`/metadata/login`, `/metadata/proposals`, and approve/reject routes), not those legacy paths. Treat this as a deployment-contract mismatch: verify the target environment and coordinate both repositories before changing either side; never silently rewrite one client to fit the other.

Test QC aggregation, grouping, reference extraction, and upgrade normalization as pure functions; mock DocDB and HTTP at the view boundary for page tests.

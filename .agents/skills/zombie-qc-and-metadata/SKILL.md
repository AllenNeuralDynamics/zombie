---
name: zombie-qc-and-metadata
description: Maintain Zombie QC, record, star, metadata-upgrade, and migration flows across DocDB, cache tables, metadata-viz, and QC Portal.
---

# Zombie QC and metadata flows

The `/quality_control?name=` page is a DocDB-v2 reader with optional raw-source lookup; it does not need DuckDB. In `web/src/qc/data.js`, select the latest `status_history` entry as the current status, use `Pending` when absent, and aggregate `Fail > Pending > Pass`. Decode `json:` values, apply the default grouping and modality grouping for multimodal records, and resolve reference metrics through `resolveReference()`. The edit link is the live QC Portal URL `/view?name=...`. `/record` and `/star` remain direct DocDB flows; reuse `star/extract.js` for star payloads.

The authenticated QC editor follows the portal UI conventions: use Preact for its interdependent state, keep it hidden when unauthenticated, request standard OIDC `profile` claims for the signed-in user's display name, and never show an opaque account ID as the name. Place the shared `/icons/gear.svg` as an icon-only settings button beside the `Edit QC` heading—not in the action group—with an accessible `aria-label` rather than a text `Settings` button. Persist the tree/table layout in local storage under the QC view-mode key; never put that preference in the URL. Empty metrics may edit both value and manual status; populated metrics require the settings opt-in when changing their value or an existing status; auto-status metrics expose value only. In tree view, let the metrics column grow with its content and leave the document as the vertical scroll owner; do not put the tree or `.qc-content` in a nested vertical scroll container. In table view, make the outer `.qc-container` the only vertical scroll owner; do not nest `overflow-y: auto` on `.qc-table-content`. Keep user-facing copy concise and do not add redundant helper text or duplicate review actions.

The `/upgrade` page lazy-loads `metadata_upgrade` and POSTs to the metadata-viz proxy. Reuse the existing metadata field conversion (`session` → `acquisition`, `rig` → `instrument`) and upgrade helpers rather than rewriting payload normalization.

The migration pages in `web/src/migrate/` currently call the deployed QC host's legacy endpoints: `GET /metadata/token?id=...&redirect=...`, `GET /metadata/pending`, and `POST /metadata/v1` or `/metadata/v2?auth-token=...`, with the `qc_auth_token` cookie and DocDB polling. The current `aind-qc-portal/plugin.py` source exposes a different proposal API (`/metadata/login`, `/metadata/proposals`, and approve/reject routes), not those legacy paths. Treat this as a deployment-contract mismatch: verify the target environment and coordinate both repositories before changing either side; never silently rewrite one client to fit the other.

Test QC aggregation, grouping, reference extraction, and upgrade normalization as pure functions; mock DocDB and HTTP at the view boundary for page tests.

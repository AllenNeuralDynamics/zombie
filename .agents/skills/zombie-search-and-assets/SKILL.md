---
name: zombie-search-and-assets
description: Extend Zombie search, asset tables, metadata query translation, and provenance links.
---

# Zombie search and assets

Search reads the current asset_basics schema from the published registry. Inspect the search view for its current URL, sorting, filtering, and pagination behavior before extending it; keep these controls synchronized with browser history. Metadata-viz queries return matching asset identities that the page intersects with loaded asset rows. Keep query translation in its existing helper rather than duplicating field mappings in a new control.

Use the shared assets-table and source-data helpers to relate source and derived assets. Provenance, rather than data level alone, determines lineage. Keep orphaned derived assets visible when their source is absent from a result. When rendering links, use the relevant raw or processed asset for storage, processing, QC, and metadata destinations.

Check the current registry fragment before relying on a column. Verify filter translation and grouped rows with representative data when those behaviors change.

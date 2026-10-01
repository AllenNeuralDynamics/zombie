---
name: zombie-view-and-navigation
description: Maintain Zombie's combined subject/project view, URL state, metadata loading, and asset lineage.
---

# Zombie view and navigation

The combined view owns browser URL/history state and embeds the subject and project views. Let the parent coordinate selection and navigation; embedded children should not render another page shell or independently rewrite history. Inspect the current URL parser for canonical parameters and supported aliases before changing a deep link.

Subject and project details combine DocDB metadata with cache-backed asset presence. Treat the published asset cache as the source for which assets exist, and use metadata provenance to identify source records and derived children. Data level alone does not establish lineage. Reuse shared timeline and assets-table builders so grouping and links agree across pages.

A reload owns its asynchronous work: abort or ignore stale DocDB and cache results after the selection changes. Verify URL restoration, provenance grouping, and stale-request behavior when modifying this flow.

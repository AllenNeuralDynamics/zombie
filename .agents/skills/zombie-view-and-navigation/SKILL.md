---
name: zombie-view-and-navigation
description: Maintain Zombie's combined subject/project view, URL state, metadata loading, and asset lineage.
---

# Zombie view and navigation

The combined view owns browser URL/history state and embeds the subject and project views. Let the parent coordinate selection and navigation; embedded children should not render another page shell or independently rewrite history. Inspect the current URL parser for canonical parameters and supported aliases before changing a deep link.

Subject and project details combine DocDB metadata with cache-backed asset presence. Treat the published asset cache as the source for which assets exist, and use metadata provenance to identify source records and derived children. Data level alone does not establish lineage. Reuse shared timeline and assets-table builders so grouping and links agree across pages.

The timeline bubble strip supports shift+click acquisition ranges and ctrl/cmd+click toggles. Keep selection flowing through the existing `onSelect` callback's `selection` field so URL sync and asset-table navigation agree. `selectLastAcquisitions(n)` applies the persisted recent-session preference from the timeline gear modal (`subject/multi-session-setting.js`); it is off by default and must not override an `?asset=` deep link.

For multiple selected events, `renderMultiEventDetail()` uses `lib/behaviors/multi-session.js` to deduplicate and order sessions and choose a matching provider from `multi-session-providers.js`. Providers supply `matchSession`, optional `enrich`, and `sections[]`. The dynamic-foraging provider shows only behavior plots, reusing `createProbPlot`: one concatenated plot fits the available width by default, and a toggle switches to fixed-width session panels with horizontal scrolling. Offer this layout toggle only when multiple supported behavior sessions are selected. Keep session boundaries intact when concatenating timestamps and release plot listeners when replacing a view.

A reload owns its asynchronous work: abort or ignore stale DocDB and cache results after the selection changes, including enrichment and plot loads for disposed multi-session views. Preserve existing URL parameters for project colors, time windows, and curricula. Verify URL restoration, provenance grouping, selection behavior, and stale-request cleanup when modifying this flow.

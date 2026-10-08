---
name: zombie-portal-architecture
description: Maintain Zombie's multi-page routing, shared shell, bootstrap lifecycle, and cache-query conventions.
---

# Zombie portal architecture

Zombie is a multi-page Vite app. The route manifest in web/build/routes.js is the source of truth for page inputs, navigation, and release-channel selection. Follow AGENTS.md for the current page-entry and shell conventions; do not duplicate shared header markup or add a separate route list.

Use the shared bootstrap for pages that need cache metadata or DuckDB-WASM. It resolves the versioned registry, registers required tables, and distinguishes blocking data failures from optional ones. Choose eager versus lazy tables according to the page's needs. Read current table columns and locations from the registry rather than assuming a schema from another page.

Use the shared registry, Arrow conversion, and plotting helpers for ordinary queries. For a page that reads partitions directly, centralize URL resolution in its data adapter and validate partition keys before building URLs or SQL. Keep build inputs and navigation filtered from the same route selection.

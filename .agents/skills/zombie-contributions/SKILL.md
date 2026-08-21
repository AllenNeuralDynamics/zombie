---
name: zombie-contributions
description: Extend Zombie's Preact contributions pages and preserve their metadata-portal API, payload, and permission contracts.
---

# Zombie contributions

The contributions app is a Preact/htm island, not a React page. Keep its multi-page routes: `/contributions`, `/contributions/view`, `/contributions/add`, `/contributions/edit`, and `/contributions/demo`. The list page fetches projects with GET; view uses `doi`; add accepts `project` (with `doi` and `author` as backwards-compatible inputs); edit first checks access and then loads the record. Preserve `credentials: 'include'` on authenticated requests.

Use the existing API helpers for `projects`, `get`, `post`, `access`, and `author-image`. The server, not the client, is authoritative for access and editability. Preserve the `ProjectContributions` shape: kebab-case credit roles, levels `lead`/`supporting`/`equal`, omitted `None` values, `from_asset` provenance, linked assets and sections, `admin`, and `edit_locked`. Do not infer permissions from UI visibility or treat a locked record as editable.

Use `preact/hooks` for interdependent page state and the existing htm renderer; do not introduce a second component framework or build-plugin change. Test reducers/helpers as pure node tests and test page behavior with mocked fetch responses and the existing DOM environment, including auth failures, locked projects, and legacy URL parameters.

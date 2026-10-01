---
name: zombie-contributions
description: Extend Zombie's contributions views while preserving the contribution service's data and permission contracts.
---

# Zombie contributions

The contributions area is a stateful Preact/htm feature. Find its current pages through the route manifest and its code under web/src/contributions. Reuse its API client and component patterns when adding a page or changing navigation.

The contribution service owns validation, access decisions, and edit locks. Ask the service for access and treat denied or locked records as read-only. Preserve the current API client's credential behavior. Inspect the service schema before changing credit roles, linked assets, provenance, or optional fields; do not derive the payload contract from what the UI happens to display.

Keep URL parsing and API payload conversion in their existing adapters. When changing a contract, coordinate the client and service and verify permission, legacy-link, and payload behavior with representative responses.

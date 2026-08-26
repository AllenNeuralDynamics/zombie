# Zombie QC editing with Entra SPA OAuth

This is the implementation plan for adding authenticated QC editing to Zombie
without adding a Python backend to the Zombie application. Zombie remains a
static Vite application. The QC Portal remains the server-side authority that
validates the request and writes to DocDB.

The implementation is additive and must be safe to run beside the existing
Panel editor and migration/proposal flows. No existing route, cookie, client,
or write path is retired as part of this plan. The new editor is opt-in until
the coexistence and rollback checks below pass.

## Target architecture

```text
data.allenneuraldynamics.org
  Zombie static pages
       │
       │ MSAL.js authorization-code + PKCE
       ▼
  Entra identity token for the existing application
       │ Authorization: Bearer <identity token>
       ▼
qc.allenneuraldynamics.org
  tenant-authenticated QC POST endpoint
       │
       ├─ validate Entra token, tenant, audience, and identity
       ├─ fetch fresh v2 DocDB record
       ├─ reject stale QC edits
       ├─ apply and validate QC changes
       └─ conditionally commit the record server-side
```

The browser never receives or uses a client secret. The Entra client ID,
tenant ID, and API scope are public configuration and may be present in the
frontend bundle. The client secret remains server-side for any existing QC
Portal confidential-client/Panel login and is not a Zombie build variable.

## Existing contracts to preserve

- Zombie’s QC page currently reads the record from DocDB in
  `web/src/qc-entry.js` and renders it through `web/src/qc/view.js`.
- Zombie is a multi-page Vite application. A redirect URI such as
  `/auth/callback` must have a real HTML entry wired through
  `web/build/routes.js`; there is no universal SPA fallback.
- The QC Portal’s Panel submission flow fetches a fresh record, applies edits,
  validates `quality_control`, and calls the v2 DocDB upsert. Its mutation
  semantics are in `aind_qc_portal/view_contents/data.py` and
  `aind_qc_portal/view_contents/data_utils.py`.
- Regular QC metric values are replaced. Curation metric values are appended
  to a list and receive curation history. Status changes append a
  `status_history` entry containing the verified evaluator identity and a
  timestamp. Notes update `quality_control.notes`.
- The existing QC Portal metadata proposal endpoints use a cookie/session
  contract. They should not be assumed to accept a SPA bearer token. Add a
  separate bearer-token QC endpoint first; migrate unrelated proposal flows
  separately.
- The existing Panel editor and its full-record DocDB write path remain live
  during rollout. The new endpoint must not rely on the browser UI to prevent
  stale or cross-writer overwrites.
- `web/src/lib/qc-auth.js`, `QC_PORTAL_BASE`, and the `/metadata/*` contract
  belong to the migration/proposal flow. The MSAL helper and QC edit API client
  must be separate modules and must not replace or reinterpret that contract.

## Implementation steps

1. [Configure Entra and agree on the API contract](QC-OAUTH-STEP-1-ENTRA.md)
2. [Add the restricted bearer-token endpoint to the QC Portal](QC-OAUTH-STEP-2-QC-API.md)
3. [Add MSAL login and QC editing to Zombie](QC-OAUTH-STEP-3-ZOMBIE-SPA.md)
4. [Test, stage, deploy, and operate the flow](QC-OAUTH-STEP-4-TEST-ROLLOUT.md)

## Definition of done

- An anonymous visitor can still view QC data but cannot submit changes.
- An Entra user from the configured tenant can log in from Zombie and receive
  an identity token whose audience is the existing application.
- The QC Portal rejects missing, malformed, expired, wrong-tenant,
  and wrong-audience tokens.
- The browser submits only a narrow change request; it cannot choose the
  evaluator identity or replace arbitrary DocDB fields.
- The server rejects a stale QC hash with a structured `409` response.
- The server performs a write-time conditional/concurrency check that also
  protects against edits made by the existing Panel path; a fetch-then-
  unconditional-upsert implementation is not sufficient. If the legacy Panel
  writer cannot participate in the same guarantee, the new writer remains
  disabled rather than running uncoordinated.
- Successful submissions preserve the Panel app’s QC value, status-history,
  curation-history, notes, schema-validation, and DocDB-upsert behavior.
- The browser uses a precisely specified, cross-language canonical hash with
  shared Python/JavaScript fixtures; it does not assume that native
  `JSON.stringify` matches Python serialization.
- The existing “open in QC Portal” edit path remains available as a fallback,
  including when the new editor is disabled, unsupported for a metric type, or
  cannot reach the API.
- No client secret, access token, authorization code, or sensitive payload is
  committed to Git or logged in plaintext.
- Production and local/staging login work with the exact registered redirect
  URIs.

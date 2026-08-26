# Step 3 — Add MSAL login and QC editing to Zombie

Zombie remains static. This step adds only browser-side authentication and the
QC editing experience; the QC Portal API from Step 2 remains the write owner.

This step must not remove or repurpose the existing migration/proposal auth
helper, `QC_PORTAL_BASE`, `/metadata/*` calls, or the existing Panel edit link.
The new editor is an additive, feature-flagged surface until the rollout gates
in Step 4 pass.

## 3.1 Add MSAL to the frontend

Add `@azure/msal-browser` to `web/package.json` and regenerate the lockfile.
Create a small helper, for example:

```text
web/src/lib/qc-spa-auth.js
```

The helper should own:

- MSAL initialization.
- `handleRedirectPromise()` processing.
- Login redirect to Entra.
  - Silent identity-token acquisition.
- Logout.
- A normalized current-user representation for the UI.

Use authorization code + PKCE through MSAL’s browser APIs. Do not implement
the OAuth protocol manually.

The helper should expose behavior similar to:

```js
getQcAccount()
loginForQc(nextPath)
getQcAccessToken()
logoutQc()
```

`getQcIdentityToken()` should request only the OIDC `openid`, `profile`, and
`email` scopes and return the signed identity token for the immediate API call.
The token should not be placed in a URL or persisted in application localStorage
by custom code.

Keep this MSAL state isolated from the existing QC session-cookie helper used by
the migration pages. Do not change the storage keys, logout behavior, or
redirect behavior of that helper.

## 3.2 Add the callback page correctly

Because Zombie is multi-page, add a real callback entry:

```text
web/auth/callback.html
web/auth-callback-entry.js
```

Register it in `web/build/routes.js` so the build, development server, shared
header, and nginx’s generic HTML resolution all know about `/auth/callback`.

The callback entry should:

1. Initialize MSAL.
2. Call `handleRedirectPromise()`.
3. Handle an OAuth error with a safe user-facing message.
4. Redirect to the validated local path that initiated login.

Do not blindly redirect to a URL supplied by query string. Store or validate
only same-origin paths such as `/quality_control?name=...` to prevent an open
redirect.

If the team chooses to process the callback on `/quality_control` instead,
remove `/auth/callback` from the registered URIs and make that page initialize
MSAL before rendering.

## 3.3 Add the QC API client

Add a focused client module, for example:

```text
web/src/qc/api.js
```

It should:

- Acquire an identity token through the auth helper.
- Send `Authorization: Bearer <token>` to the QC Portal API.
- Parse structured JSON errors.
- Retry once after silent token renewal when the API returns `401`.
- Never retry a `409` automatically; the user must reload/review.
- Treat `403` as an origin/request-policy problem, not a login-scope problem.

Keep the API base URL, SPA client ID, API scope, and redirect URI in public
`VITE_*` configuration. Do not add a secret.

## 3.4 Add an opt-in editor without removing the QC Portal fallback

The current Edit button in `web/src/qc/view.js` opens the QC Portal. Keep an
always-available “Open QC Portal” action with the same URL and behavior. Add
the new in-page editor behind an explicit rollout mode, defaulting to
read-only/legacy-link mode. If the editor is disabled, unsupported for a metric
type, or the API is unavailable, the user must retain a clear path to the
existing Panel editor.

Because Vite `VITE_*` values are build-time settings, do not describe one as a
runtime kill switch. Either make rollback a bundle deployment plus the retained
Portal link, or define and test a separate public runtime configuration file.

The editor should support the same first milestone as the Panel app:

- Current metric value display and editing.
- Status selection: `Pending`, `Pass`, or `Fail`.
- Notes editing.
- Curation metrics using append semantics rather than replacement.
- A review/preview state showing every pending change.
- Submit, cancel, success, and structured error states.

Do not claim full parity for specialized curation viewers unless they are
implemented and tested. Unsupported curation/custom metric shapes should stay
read-only in Zombie and offer the existing QC Portal fallback.

Use Preact/htm for the stateful editor. The editor will have multiple
interdependent states: account, pending changes, preview, submission status,
conflict state, and errors. Keep the existing pure parsing/rendering helpers
where practical.

The editor should be read-only when no account is present and should show a
clear “Log in to edit QC” action. The login action should return the user to
the same `/quality_control?name=...` page.

## 3.5 Build the narrow request payload

When the user submits:

1. Identify the record `_id` from the loaded DocDB record.
2. Compute the canonical SHA-256 hash of the loaded `quality_control` object
   using the exact cross-language algorithm and fixtures frozen in Step 1.
3. Include only changed metric values/statuses and an explicitly changed
   notes field.
4. Do not include evaluator, curator, timestamps, or a complete record.
5. POST to the QC Portal API.

On success, clear pending changes and reload the record. On `409`, discard no
data silently: show that the record changed, preserve or visibly offer the
pending local edits, and require a fresh review before resubmitting.

Do not optimistically rewrite the local record as if the server accepted the
change. A successful UI state requires the post-submit DocDB reload to succeed;
otherwise show the result as uncertain and retain the Portal fallback.

## 3.6 Frontend tests

Add pure/helper tests for:

- Canonical QC hashing matching the QC Portal implementation.
- Cross-language hash fixtures covering Unicode, numbers, nulls, arrays, and
  `json:` values.
- Building payloads for value, status, curation, and notes edits.
- Omitting unchanged fields.
- Safe handling of `401`, `403`, `409`, `422`, and `502` responses.
- Same-origin return-path validation.

Add DOM tests for anonymous read-only mode, authenticated edit mode, preview,
successful submission, and stale-record handling. Keep existing QC aggregation
and grouping tests passing. Add tests for the feature flag in its default-off
state, the retained “Open QC Portal” action, unsupported metric fallback, API
unavailability/read-only degradation, and the unchanged migration/proposal
auth helper behavior.

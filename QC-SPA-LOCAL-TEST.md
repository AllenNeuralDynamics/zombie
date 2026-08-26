# QC SPA local test

The editor is enabled by default in local Vite development and remains
disabled in production unless `VITE_QC_SPA_EDITOR_ENABLED=true`. Set it to
`false` to disable local testing. The existing `Open QC Portal` action remains
available in every mode.

Use public frontend values only:

```text
VITE_QC_SPA_EDITOR_ENABLED=true
VITE_QC_API_BASE=http://localhost:8000
VITE_QC_SPA_CLIENT_ID=a625f758-ee73-4fc0-8a4b-b7467f33d68c
VITE_QC_SPA_TENANT_ID=32669cd6-737f-4b39-8bdd-d6951120d3fc
VITE_QC_AUTH_REDIRECT_URI=http://localhost:5173/auth/callback
```

The new flow uses the existing Entra application directly and requests only
the `openid` sign-in scope. The backend accepts an identity token issued by
this tenant for this client; tenant membership is the only QC authorization
gate. No profile/email permission, custom API scope, or app role is required.
The client secret is server-side only and is not used by the browser.

Run `npm install` after checking out the change, then start Zombie with its
usual development command. The QC Portal must separately be configured with
the matching tenant, client ID, and `http://localhost:5173` API origin; see
its `QC-API-LOCAL-TEST.md`.

The browser computes the expected hash from the loaded raw
`quality_control` object, sends only changed metric fields and explicitly
changed notes, and reloads DocDB after a successful submit. A `409` keeps the
local review visible and requires a fresh review. Specialized/custom metrics
remain read-only and retain the `Open QC Portal` fallback.

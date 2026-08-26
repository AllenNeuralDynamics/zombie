# Step 4 — Test, stage, deploy, and operate the flow

This step turns the implementation into a controlled production rollout.

## 4.1 Local checks

Run the normal Zombie checks:

```bash
cd web
npm test
npm run lint
npm run build
```

Confirm that:

- `/auth/callback` resolves to the callback HTML entry.
- The build contains no secret-like values.
- The default rollout mode still renders the existing read-only QC page and
  “Open QC Portal” edit action without login.
- The new QC editor is disabled by default until explicitly enabled.
- A missing identity token cannot reach the submit request as an authenticated
  request.

Run QC Portal tests in its repository, including the token-validation and
mutation tests from Step 2.

## 4.2 Container checks

Build the Zombie image and verify the existing proxy/static behavior remains
healthy. Also verify the QC Portal deployment separately.

At minimum:

- Docker image builds with `@azure/msal-browser` in the frontend.
- nginx configuration passes `nginx -t`.
- Existing `/metadata-viz`, `/log-server`, `/s3-list`, and page routes still
  work.
- Existing `/metadata/*` migration/proposal login, cookie, CORS, proposal, and
  approval flows still work unchanged.
- The existing QC Portal `/view?name=...` editor remains reachable and can
  still perform its normal writes.
- No new server-side secret is copied into the Zombie image.

## 4.3 Staging login test

Use a test hostname and an Entra redirect URI explicitly registered for that
hostname. Test the complete browser flow:

1. Open `/quality_control?name=<asset>` anonymously.
2. Confirm QC data is visible, the new editor is disabled by default, and the
   existing Portal edit action works.
3. Enable the staging editor rollout mode explicitly.
4. Click login.
5. Complete Entra login.
6. Confirm the callback returns to the original asset page.
7. Confirm the account shown in Zombie matches the verified Entra account.
8. Acquire an Entra identity token for the existing application.
9. Submit a harmless test QC change.
10. Confirm the QC Portal records the verified evaluator identity.
11. Confirm the DocDB record contains the expected history/value change.
12. Confirm the existing “Open QC Portal” fallback remains available before,
    during, and after an editor/API failure.

Test a user who cannot authenticate to the configured tenant; the API must
return `401`, and Zombie must not present that user as an authorized editor.

## 4.4 Concurrency and failure tests

Before production, deliberately exercise:

- Two browser tabs editing the same asset.
- A Zombie API edit racing with an existing Panel edit.
- A DocDB change between load and submit.
- Expired identity token and silent renewal.
- QC schema validation failure.
- DocDB timeout or upstream `5xx`.
- Browser refresh during the OAuth callback.
- Direct cross-origin or malformed API calls.

The important invariants are that stale or invalid requests do not perform an
upsert, and that an accepted new edit cannot be based on a record version that
changed during the write window. The race tests must exercise the actual
conditional/atomic write or shared coordination mechanism selected in Step 2;
mocking only the initial read is insufficient.

## 4.5 Production configuration

Set public frontend values at build/deploy time:

```text
VITE_QC_API_BASE=https://qc.allenneuraldynamics.org
VITE_QC_SPA_CLIENT_ID=<Zombie SPA client ID>
VITE_QC_AUTH_REDIRECT_URI=https://data.allenneuraldynamics.org/auth/callback
```

Do not set `AZURE_CLIENT_SECRET` or any secret-like value as a `VITE_*`
variable. If the QC Portal still needs a confidential-client secret for Panel
login, inject it only into the QC Portal ECS/task environment or secret store.

Document whether the editor flag is build-time or runtime. If it is build-time,
the rollback procedure must deploy a known-good bundle; if it is runtime, test
that an operator can disable the editor while preserving QC viewing and the
existing Portal link.

## 4.6 Monitoring and audit

The QC API should emit structured logs containing:

- Request/correlation ID.
- Verified actor identity.
- Record ID and asset name.
- Number and types of changes.
- Result: applied, rejected, conflict, validation failure, or upstream error.

Never log:

- Authorization headers or access tokens.
- Authorization codes.
- Client secrets.
- Full record bodies unless explicitly approved for a protected debug path.

Set alerts for repeated `401`, `403`, `409`, and `5xx` responses. Rotate the
QC Portal’s confidential secret according to the organization’s normal Entra
secret-rotation process. SPA client IDs and API identifiers are not secrets.

## 4.7 Rollback plan

The first production release should allow a feature flag or deployment
configuration to disable editing while leaving QC viewing available. If the
API is unavailable, Zombie should degrade to read-only mode and display a
clear message rather than retrying writes indefinitely, while retaining the
existing “Open QC Portal” action.

Rollback consists of:

1. Disable the QC editor feature flag or deploy the previous Zombie bundle.
2. Disable or restrict the QC Portal endpoint if necessary.
3. Preserve API logs and DocDB history for investigation.
4. Do not delete or rewrite successful QC changes during rollback.

Production approval is blocked if the conditional-write/concurrency contract,
cross-language hash fixtures, endpoint-specific CORS/auth tests, or legacy
Panel/migration regression checks are incomplete.

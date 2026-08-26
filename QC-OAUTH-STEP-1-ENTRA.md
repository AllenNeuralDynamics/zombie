# Step 1 — Configure Entra and freeze the API contract

Complete this step before changing either application. The goal is to make
the identity and token boundaries unambiguous.

## 1.1 Use the SPA platform for Zombie

In the Entra app registration used by Zombie, configure the **Single-page
application** platform with these exact redirect URIs:

```text
https://data.allenneuraldynamics.org/auth/callback
http://localhost:5173/auth/callback
```

Add the test deployment URI if one exists, for example:

```text
https://data.allenneuraldynamics-test.org/auth/callback
```

The path, scheme, hostname, port, and trailing slash must match the MSAL
configuration exactly. Do not register `/auth/callback/` if the application
uses `/auth/callback`.

The redirect path is only valid once Zombie serves a corresponding callback
page. That page will be added in Step 3 through the route manifest.

## 1.2 Use the existing Entra application

There is no separate QC API registration and no exposed QC API scope for this
first implementation. Add the Zombie SPA redirect URIs to the existing Entra
application. The QC Portal accepts the signed identity token for that same
application and uses tenant membership as the write authorization boundary.

## 1.3 Decide the write authorization rule

Any user who can sign in to the configured tenant application may write QC.
The QC Portal still validates the token issuer, audience, signature, expiry,
and stable identity independently of the Zombie UI; the browser never supplies
the evaluator name.

The bearer endpoint must use its own JWT validation configuration and must not
reuse the Panel session-cookie or metadata-proposal authentication helpers.
Signing-key discovery and rotation must fail closed when a token cannot be
validated.

## 1.4 Record the configuration values

Zombie needs the SPA application ID and other public values at build time:

```text
VITE_QC_API_BASE=https://qc.allenneuraldynamics.org
VITE_QC_SPA_CLIENT_ID=<Zombie SPA application client ID>
VITE_QC_AUTH_REDIRECT_URI=https://data.allenneuraldynamics.org/auth/callback
```

`VITE_QC_SPA_CLIENT_ID` is the `clientId` passed to MSAL and is also the
expected identity-token audience on the QC Portal.

The Entra client secret must not be placed in any `VITE_*` variable or Docker
build argument. Zombie has no use for it in the SPA flow.

The QC Portal may retain its existing confidential-client settings for Panel
login. If a new server-side secret is required there, inject it through the
deployment secret mechanism rather than committing it.

Keep the existing `QC_PORTAL_BASE` and `/metadata/*` configuration unchanged.
Add separate QC API settings rather than changing the migration/proposal
client. The API’s CORS allowlist must be endpoint-specific; adding localhost or
test origins for `/api/qc/submit` must not broaden the existing metadata
proposal endpoints.

Also record the editor rollout mode. It must default to read-only/legacy-link
mode, keep the existing “open in QC Portal” action visible, and support an
immediate disable path. A `VITE_*` value is build-time configuration, not a
runtime kill switch; if an operational toggle without a rebuild is required,
define a separate public runtime configuration mechanism.

Finally, agree on the write-concurrency contract before implementation. A
client-provided expected hash is only a precondition; the QC Portal must use a
write-time conditional update or a QC Portal-owned coordination mechanism that
also accounts for the existing Panel writer. A fetch followed by an
unconditional full-record upsert is not an acceptable safety guarantee.

Choose an explicit coexistence model: (A) both the Panel and bearer paths use
the same atomic/conditional QC write primitive, or (B) the new writer remains
disabled whenever the legacy writer cannot participate in that guarantee. An
API-only in-process lock, a second pre-read, or a browser-side check does not
protect against the existing Panel process or another QC Portal worker.

## 1.5 Freeze the QC hash contract

The browser and server must hash exactly the same bytes. Specify the canonical
JSON algorithm, including recursive key ordering, number handling, Unicode
escaping, rejection of non-finite values, whitespace, and UTF-8 encoding. Use a
language-neutral standard such as RFC 8785/JCS or an explicitly documented
equivalent, and provide shared cross-language fixtures containing representative
QC records, `json:` values, Unicode, nulls, arrays, and numeric values.

Do not use the existing full-record proposal hash as an implicit contract, and
do not assume native JavaScript `JSON.stringify` matches Python serialization.
The API must reject a malformed or unsupported expected hash rather than
silently bypassing the concurrency check.

## 1.6 Confirm local development behavior

The local redirect URI works only if the Vite development server serves or
proxies `/auth/callback`. Confirm whether local development uses port 5173
directly or a Vite proxy to another process. Do not register `localhost` while
testing a server that actually runs on `127.0.0.1`, and do not silently change
the port.

## Deliverables

- Entra redirect URIs approved.
- Existing Entra application and redirect URIs approved.
- Public Zombie build variables recorded in deployment documentation.
- Confirmation that no client secret will enter the Zombie bundle.
- A sample access-token claim set available for QC Portal unit tests, with all
  real tokens and identities redacted.
- Exact token authorization, audit identity, endpoint-specific CORS, rollout
  flag, write-concurrency, and cross-language hash contracts approved.

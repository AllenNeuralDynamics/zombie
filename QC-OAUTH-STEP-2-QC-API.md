# Step 2 — Add the tenant-authenticated QC API to the QC Portal

This is the server-side write boundary. It belongs in `aind-qc-portal`, not in
Zombie. The endpoint must be secure even if somebody bypasses the Zombie UI
and calls it directly.

Add this as a separate Panel/Tornado handler and route. Do not modify the
existing `/metadata/*` handlers, session cookie, proposal store, or Panel
submission callback while adding it. The new handler must not inherit behavior
that turns bearer requests into session-cookie requests.

## 2.1 Add a dedicated endpoint

Add a new endpoint separate from the cookie-based metadata proposal routes:

```text
OPTIONS /api/qc/submit
POST    /api/qc/submit
```

The endpoint should accept:

```json
{
  "record_id": "<DocDB _id>",
  "expected_qc_hash": "<sha256 of canonical quality_control>",
  "changes": [
    {"metric_name": "metric-a", "value": 0.94},
    {"metric_name": "metric-b", "status": "Pass"}
  ],
  "notes": "Replacement notes, optional"
}
```

An omitted `notes` field means “do not change notes.” An explicitly supplied
empty string means “clear notes.” Reject unknown top-level fields unless there
is a deliberate reason to support them.

Do not accept a complete replacement DocDB record from the browser. The server
must own the fresh-record read, mutation, validation, and conditional commit.

## 2.2 Validate the bearer identity token

Require:

```http
Authorization: Bearer <Entra identity token>
Content-Type: application/json
```

Validate the JWT using Entra’s OpenID configuration and signing keys. Check all
of the following:

- Signature and key ID.
- Issuer for the configured tenant.
- Audience equal to the existing Entra application client ID.
- Expiration and not-before timestamps.
- A usable user identity claim, preferring `preferred_username`, `email`, or
  the approved tenant identity claim according to the Entra configuration.

The API intentionally uses tenant membership as its authorization rule for
this first implementation. No custom API scope or app role is required.

Return structured JSON errors:

```text
401 unauthenticated or invalid token
403 origin or request policy failure
400 malformed request
409 stale record or conflicting edit
422 invalid QC data
502 DocDB/upstream failure
```

Do not return raw token contents or validation-library internals in an error.

Use the exact authorization rule approved in Step 1. Validate the token’s
stable subject/object identity separately from its display name, and derive the
server-side evaluator/curator value from that verified identity. Do not let the
browser supply the evaluator name. Cache Entra signing keys with normal
rotation behavior, but fail closed when the issuer, key, or validation metadata
cannot be established. Add the JWT validation dependency explicitly to the QC
Portal environment; do not implement token verification with ad hoc decoding.

## 2.3 Configure CORS and request protections

Allow only the known application origins:

```text
https://data.allenneuraldynamics.org
http://localhost:5173
```

Add an equivalent test origin only when needed. The preflight response must
allow `POST`, `OPTIONS`, `Authorization`, and `Content-Type`. Do not use
`Access-Control-Allow-Origin: *` with authenticated requests.

Implement this allowlist on the new endpoint only. In particular, do not
change `_MetadataApiHandler` or its shared origin predicate to admit localhost,
test hosts, or bearer semantics, because that would alter the existing
cookie-backed migration/proposal surface. CORS is only a browser boundary; the
JWT authorization checks remain mandatory for every POST.

The endpoint should also:

- Require an exact allowed `Origin` on POST.
- Enforce a bounded JSON body size.
- Reject duplicate metric names in one request.
- Reject unknown metric names and unsupported fields.
- Reject empty change lists unless notes are changing.
- Avoid caching responses.
- Log actor, asset ID, change type, result, and correlation ID, but never log
  access tokens, authorization codes, client secrets, or full QC values.

## 2.4 Preserve mutation semantics and encoding

Implement and unit-test the same behavior already used by the Panel app:

1. Fetch the current v2 record by `_id`.
2. Compute the canonical SHA-256 hash of its `quality_control` section using
   the frozen cross-language algorithm from Step 1.
3. Compare it with `expected_qc_hash`; return `409` with a reload message if
   they differ.
4. Find each requested metric by its exact `name` and validate its metric
   shape/type before mutation.
5. For a normal QC metric, replace `metric["value"]` using the same value
   decoding/encoding rules as the Panel path.
6. For a curation metric, reuse the existing curation mutation semantics:
   append the JSON-serialized value to the existing list and append the
   matching curation-history entry. Do not replace or double-encode existing
   `json:` values.
7. For a status change, accept only the supported `Pending`, `Pass`, and
   `Fail` values and append a status-history entry containing the
   server-verified identity and timestamp in the agreed existing format.
8. Apply notes when the `notes` field is present, including an explicit empty
   string to clear notes.
9. Validate `record["quality_control"]` with the same `QualityControl` model
   and compatible schema versions used by the Panel app.
10. Commit the mutation with a write-time conditional/concurrency check that
    still requires the expected QC version/hash. The check must close the
    race between the initial read and the write and must define how concurrent
    writes from the existing Panel path are handled.
11. Call the v2 `MetadataDbClient.upsert_one_docdb_record` only if that client
    operation is part of an equivalent conditional/atomic write guarantee.
    A plain unconditional full-record upsert after a pre-read is not safe
    enough for this endpoint. If the DocDB API cannot provide the required
    guarantee, stop at the API-contract stage and do not claim stale-edit
    protection.

The request must not be allowed to supply `evaluator`, `curator`, timestamps,
or arbitrary history entries. Those values are server-controlled.

The concurrency design must be tested against both two new API callers and a
legacy Panel writer. If a shared QC Portal lock or write primitive is required,
document its scope, expiry, failure behavior, and deployment behavior across
multiple QC Portal workers. Do not rely on an in-process lock alone. If the
legacy Panel writer cannot use the same guarantee, the endpoint must remain
disabled while that writer is active; do not silently deploy a second
uncoordinated writer.

## 2.5 Return a small success response

Return something like:

```json
{
  "status": "applied",
  "record_id": "<DocDB _id>",
  "asset_name": "<asset name>",
  "actor": "<verified user>",
  "changed_metrics": 2
}
```

Do not return the entire record unless the UI specifically needs it. Zombie
can reload the public DocDB record after success.

## 2.6 Tests required before deployment

Add tests for:

- Missing, malformed, expired, wrong-tenant, wrong-audience, and wrong-scope
  tokens.
- Valid token with an unapproved role.
- Allowed and rejected CORS origins/preflights.
- Missing record, unknown metric, duplicate metric, unsupported field, and
  no-op payload.
- Regular value replacement, curation append, status history, and notes.
- Stale `expected_qc_hash` returning `409` without an upsert.
- Schema-validation failure without an upsert.
- DocDB failure leaving no false success response.
- Successful upsert using the verified token identity.
- Cross-language hash fixtures, including Unicode, numbers, nulls, arrays, and
  `json:` values.
- Two simultaneous API submissions and an API submission racing with the Panel
  writer; at most one conflicting mutation may apply, and rejected conflicts
  must not perform an upsert.
- Existing `/metadata/*` handler tests remain unchanged and pass, including
  their cookie, CORS, redirect, and proposal behavior.

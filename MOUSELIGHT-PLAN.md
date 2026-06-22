# MouseLight Neuron Browser — Integration Plan

Goal: pull neuron **metadata** and neuron **skeleton nodes** ("meshes" in the user's terms — actually point-and-parent skeletons, not surface meshes) from the public Janelia MouseLight Neuron Browser into our system. Region surface OBJs are intentionally out of scope here.

This document is a self-contained spec written so a future agent can implement an ingester without re-discovering the API.

---

## 1. What MouseLight is

- Public web app: `https://ml-neuronbrowser.janelia.org`
- Runs the Janelia MouseLight project's reconstructed single-neuron database.
- As of writing: **1653 neurons**, API version `1.6.4`, system version `1.6.2`, search scope cap `6` (Public).
- All neurons are tracings of single projection neurons in mouse brain, registered to the Allen CCF. Each neuron typically has two tracings: an **axon** and a **dendrite**.
- Coordinates are in micrometres in the Allen CCF space (25 µm voxel template). The two CCF variants available are:
  - `CCFV25` — "CCFv2.5 (ML legacy)" — original MouseLight registration
  - `CCFV30` — "CCFv3" — Allen 2017 CCF (AibsCcf)
  - Every node carries **both** `brainAreaIdCcfV25` and `brainAreaIdCcfV30`, so a single fetch covers both.

---

## 2. Endpoints (all public, no auth, no CORS pain)

Base: `https://ml-neuronbrowser.janelia.org`

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/graphql` | All metadata: constants, region tree, neuron search |
| `POST` | `/tracings` | Full skeleton node arrays for one or more tracing UUIDs (JSON, with brain-area + structure-id per node) |
| `POST` | `/swc` | Same skeletons as standard SWC, returned as a base64-encoded ZIP |
| `POST` | `/export` | Server-side SWC/JSON export bundle. Limited to `exportLimit` neurons per request (currently 20). Probably **don't use this** for bulk ingest. |
| `POST` | `/slice` | Slice imagery for the viewer's slicing UI. Irrelevant for ingest. |
| `GET`  | `/system` | `{"systemVersion":"1.6.2","searchScope":6,"exportLimit":20}` — quick health check |

Notes:
- The GraphQL server is Apollo, with **introspection disabled** in production. You cannot SDL-dump it; rely on the queries documented below (extracted from the bundled SPA at `/bundle.js`).
- All POSTs are `Content-Type: application/json`. No cookies, no API key.
- The site doesn't publish a rate limit. Be polite: batch IDs, cache responses, do not parallelise hard.

---

## 3. Constants (call once at startup)

Single GraphQL query that returns everything a client needs to interpret subsequent responses. This is what the SPA calls on first load.

```graphql
query ConstantsQuery($searchScope: Int) {
  systemSettings(searchScope: $searchScope) {
    apiVersion
    apiRelease
    neuronCount
  }
  tracingStructures   { id name value }
  structureIdentifiers { id name value }
  queryOperators      { id display operator }
  brainAreas {
    id
    name
    acronym
    aliasList
    structureId
    depth
    parentStructureId
    structureIdPath
    geometryColor
    geometryFile
    geometryEnable
  }
  systemMessage
}
```

Pass `searchScope = 6` (Public) for the public site.

### 3.1 `tracingStructures` — what a tracing represents

Each tracing belongs to one of:

| `id` (UUID) | `name`     | `value` |
|---|---|---|
| `68e76074-1777-42b6-bbf9-93a6a5f02fa4` | `axon`     | 1 |
| `aef2ba31-8f9b-4a47-9de0-58dab1cc06a8` | `dendrite` | 2 |

A neuron normally has one of each. Some neurons have only an axon.

### 3.2 `structureIdentifiers` — what a node represents (SWC label)

These are the per-node labels (the "Label" / type column of SWC). The `value` column matches the standard SWC type code.

| `id` (UUID) | `name` | `value` |
|---|---|---|
| `9b2cf056-1fba-468f-a877-04169dd9f708` | `path`              | 0 |
| `6afcafa5-ec7f-4899-8941-3e1f812682ce` | `soma`              | 1 |
| `a1df739e-f4a8-4b88-9a25-2cd6b9a7563c` | `axon`              | 2 |
| `d8eb210f-65fe-4983-bdcb-e34de5ca2e13` | `(basal) dendrite`  | 3 |
| `a3dec6a1-7484-45a7-bc05-cf3d6014c44d` | `apical dendrite`   | 4 |
| `2a8efa78-1067-4ce8-8e4f-cfcf9cf7d315` | `branch point`      | 5 |
| `c37953e1-a1e9-4b9a-847e-08d9566ced65` | `end point`         | 6 |

Build a lookup `structureIdentifierId → value` to write standard SWC.

### 3.3 `brainAreas` — Allen CCF region tree

This is the full Allen ontology used by MouseLight (1327 entries).

Per entry: `id` (MouseLight UUID), `acronym`, `name`, `safeName` (also returned in other queries), `aliasList`, `structureId` (the Allen integer ID, e.g. 997 = root), `depth`, `parentStructureId`, `structureIdPath` (root-to-leaf path of integer Allen IDs), `geometryColor`, `geometryFile`, `geometryEnable`.

For our purposes: build a map `brainAreaId (UUID) → { acronym, name, structureId, structureIdPath }` so that node-level `brainAreaIdCcfV25` / `brainAreaIdCcfV30` UUIDs can be resolved to Allen acronyms/integer IDs.

### 3.4 `queryOperators`

Comparison operators used when building per-region node-count predicates. Only needed if you implement filtered search; you can hard-code the IDs if you ever need them:

| `id` | `display` |
|---|---|
| `5f21a040-dd64-4116-aa9c-d00387b83db8` | `=` |
| `2060469a-aa88-4e61-b72c-e598d8e3e243` | `≠` |
| `f191e8b3-8fb9-4151-a48c-432c1a2382cd` | `>` |
| `ca6dc15b-bee7-4ee5-b53c-2d9f244b0312` | `<` |
| `8905baf3-89bc-4e23-b542-e8d0947991f8` | `≥` |
| `86934549-1d9c-41e2-8020-d29724ea505e` | `≤` |

---

## 4. Listing / searching neurons (metadata)

This is the main metadata pull. It returns neuron-level info plus tracing UUIDs that you then feed to `/tracings`.

```graphql
query SearchNeurons($context: SearchContext) {
  searchNeurons(context: $context) {
    nonce
    ccfVersion
    queryTime
    totalCount
    neurons {
      id            # neuron UUID
      idString      # human ID, e.g. "AA0001"
      consensus     # int (workflow status)
      brainArea { id acronym }   # soma's brain area
      sample     { id idNumber } # acquisition sample
      tracings {
        id
        tracingStructure { id name value }
        soma {
          id
          x y z radius
          parentNumber
          sampleNumber
          brainAreaIdCcfV25
          brainAreaIdCcfV30
          structureIdentifierId
        }
      }
    }
    error { name message }
  }
}
```

### 4.1 `SearchContext` input shape

This is the **only** mildly tricky part. The variable is **required** even when you just want all neurons.

```jsonc
{
  "scope": 6,                  // SearchScope: 6 = Public (use 6 for the public site)
  "nonce": "any-string",       // echoed back; use a UUID per request if you care
  "ccfVersion": "CCFV30",      // REQUIRED. "CCFV25" or "CCFV30"
  "predicates": [              // see 4.2; supply at least one
    {
      "predicateType": "ID",   // "ANATOMICAL" | "CUSTOM" | "ID"
      "tracingIdsOrDOIs": ["AA0001"],
      "tracingIdsOrDOIsExactMatch": true,
      "tracingStructureIds": [],
      "nodeStructureIds": [],
      "operatorId": null,
      "amount": 0,
      "brainAreaIds": [],
      "arbCenter": { "x": null, "y": null, "z": null },
      "arbSize": null,
      "invert": false,
      "composition": 1         // 1=and, 2=or, 3=not
    }
  ]
}
```

**Confirmed working request** (returns AA0001):

```bash
curl -s -X POST https://ml-neuronbrowser.janelia.org/graphql \
  -H "content-type: application/json" \
  --data '{"operationName":"SearchNeurons","query":"…the SearchNeurons query above…","variables":{"context":{"scope":6,"nonce":"abc","ccfVersion":"CCFV30","predicates":[{"predicateType":"ID","tracingIdsOrDOIs":["AA0001"],"tracingIdsOrDOIsExactMatch":true,"tracingStructureIds":[],"nodeStructureIds":[],"operatorId":null,"amount":0,"brainAreaIds":[],"arbCenter":{"x":null,"y":null,"z":null},"arbSize":null,"invert":false,"composition":1}]}}}'
```

Returned `totalCount: 1653` and a full neuron record (see §6 for verbatim).

### 4.2 Predicate cookbook

Three predicate types are supported. The bundle's class names are `BRAIN_AREA_FILTER_TYPE_*`.

#### a) "Give me every neuron" (bulk list)

The simplest known way is an **`ID`** predicate with an empty/wildcard list and `invert: true`:

```jsonc
{
  "predicateType": "ID",
  "tracingIdsOrDOIs": [],
  "tracingIdsOrDOIsExactMatch": false,
  "invert": true,
  "composition": 1,
  /* fill the other fields with the empty defaults above */
}
```

If that returns 0, fall back to an **`ANATOMICAL`** predicate scoped to the root region (Allen ID 997, MouseLight UUID lookup from `brainAreas` constants):

```jsonc
{
  "predicateType": "ANATOMICAL",
  "brainAreaIds": ["<UUID for structureId=997, i.e. the wholebrain entry>"],
  "tracingStructureIds": [],
  "nodeStructureIds": [],
  "operatorId": null,
  "amount": 0,
  "composition": 1,
  "invert": false,
  /* empty defaults */
}
```

Either way you get the full ~1653 neuron list in one shot (`searchNeurons` doesn't paginate — it returns the whole match set). Use the request's `queryTime` to gauge load.

#### b) By neuron ID / DOI

`predicateType: "ID"`, `tracingIdsOrDOIs: ["AA0001", "AA1280", ...]`, `tracingIdsOrDOIsExactMatch: true`.

#### c) By anatomical region with optional node-count threshold

`predicateType: "ANATOMICAL"`, `brainAreaIds: [<region UUIDs>]`, plus optionally:
- `tracingStructureIds: [<axon or dendrite UUID>]` to restrict which tracing's nodes count.
- `nodeStructureIds: [<structureIdentifier UUID>]` to restrict node types (e.g. end points only).
- `operatorId` + `amount` for "≥ 50 nodes" style thresholds.

#### d) By custom spherical region

`predicateType: "CUSTOM"`, `arbCenter: {x,y,z}`, `arbSize: <radius>` (µm in CCF), plus optional `tracingStructureIds`, `nodeStructureIds`, `operatorId`, `amount`.

#### e) Combining predicates

Send multiple predicates in the `predicates` array; each has its own `composition` (`1`=and, `2`=or, `3`=not) and `invert` flag. The first predicate's composition is ignored.

### 4.3 Enums (verbatim from bundle)

```ts
SearchScope:
  Unset=-1, Private=0, Team=1, Division=2, Internal=3,
  Moderated=4, External=5, Public=6, Published=7
// Use 6 for the public site.

CcfVersion (string enum, REQUIRED on SearchContext):
  "CCFV25" | "CCFV30"

PredicateType (string enum):
  "ANATOMICAL" | "CUSTOM" | "ID"

FilterComposition (int enum):
  and=1, or=2, not=3
```

---

## 5. Fetching skeleton nodes ("meshes")

Once you have `tracing.id` UUIDs from `searchNeurons`, hit `/tracings`.

```bash
curl -X POST https://ml-neuronbrowser.janelia.org/tracings \
  -H 'content-type: application/json' \
  -d '{"ids":["b0cfcfe1-9870-4e61-ad3e-cf09b114fc3a", "..."]}'
```

Response shape:

```jsonc
{
  "tracings": [
    {
      "id": "b0cfcfe1-9870-4e61-ad3e-cf09b114fc3a",
      "nodes": [
        {
          "id": "b41cf306-…",
          "x": 3388.08, "y": 2633.59, "z": 5765.94,   // µm, CCF space
          "radius": 1.0,                              // µm
          "sampleNumber": 344,                        // 1-based SWC index
          "parentNumber": 343,                        // -1 for the root (soma)
          "brainAreaIdCcfV25": "82592186-…",          // → brainAreas UUID
          "brainAreaIdCcfV30": "89e95582-…",          // → brainAreas UUID
          "structureIdentifierId": "9b2cf056-…"       // → structureIdentifiers UUID
        },
        …
      ]
    },
    …
  ]
}
```

Interpretation:
- `(x, y, z)` are CCF micrometres. The viewer applies a `-π/2` X rotation for CCFv3 to match orientation. For an ingest, just store the raw numbers and the CCF version they came from (CCFv2.5 vs CCFv3 use different soma coordinates **in some cases** — the same node carries area IDs for both, but a single tracing's coordinates are in one CCF; the ML default is CCFv2.5. Treat coordinates as CCFv2.5 unless you have evidence otherwise. The Janelia paper's coordinates are CCFv2.5.).
- `radius` is in µm; the SWC standard wants diameter, so multiply by 2 if you emit SWC (natverse does `W = radius*2`).
- To reconstruct an SWC row: `sampleNumber  structureIdValue  x  y  z  radius  parentNumber` where `structureIdValue` is the integer `.value` from `structureIdentifiers` keyed by `structureIdentifierId`.
- The root soma node has `parentNumber = -1`.
- The `brainAreaIdCcfV*` fields are MouseLight UUIDs; resolve to Allen integer `structureId` and acronym via the `brainAreas` map from §3.3. Some nodes have `null` brain-area IDs (outside the parcellation).

### 5.1 Bulk size and batching

- Per-neuron tracings are typically a few hundred KB to a few MB JSON.
- `/tracings` accepts batched `ids`. natverse's R client batches in groups of 5 with a 5 s/ID timeout. **Recommend batches of 5–10, sequential**, with retries on 5xx.
- A whole-database pull is ~1653 neurons × ~2 tracings ≈ ~3300 tracing fetches. With batches of 5, that's ~660 HTTP calls. Cache aggressively.

### 5.2 Alternative: `/swc` (skeleton as SWC zip)

```bash
curl -X POST https://ml-neuronbrowser.janelia.org/swc \
  -H 'content-type: application/json' \
  -d '{"ids":["<tracing-uuid>", …]}'
```

Response is JSON: `{ "contents": "<base64 zip>", … }` containing standard SWC files named by tracing ID. The SWC variant is convenient if you don't care about the dual-CCF region IDs per node and just want canonical SWC for downstream tools. **Use `/tracings` for full fidelity.**

### 5.3 Avoid `/export`

`/export` is server-throttled (`exportLimit: 20` from `/system`) and intended for end-user downloads. Don't use it for ingest.

---

## 6. Verbatim sample (`AA0001`, scope=6, CCFV30)

```jsonc
{
  "data": {
    "searchNeurons": {
      "nonce": "abc",
      "ccfVersion": "CCFV30",
      "queryTime": 105,
      "totalCount": 1653,
      "neurons": [{
        "id": "bf6b954b-b1e3-467e-803e-54d4e8264759",
        "idString": "AA0001",
        "consensus": 0,
        "brainArea": { "id": "7ca97433-…", "acronym": "SSp-m5" },
        "sample":    { "id": "18a038ff-…", "idNumber": 1 },
        "tracings": [
          {
            "id": "4c9c9327-e0bd-4739-b222-2b8d56c7785d",
            "tracingStructure": { "name": "axon",     "value": 1, "id": "68e76074-…" },
            "soma": {
              "x": 2977.33, "y": 2534.79, "z": 4625.38, "radius": 1,
              "parentNumber": -1, "sampleNumber": 1,
              "brainAreaIdCcfV25": "7ca97433-…",
              "brainAreaIdCcfV30": "7ca97433-…",
              "structureIdentifierId": "6afcafa5-…"   // = soma (value 1)
            }
          },
          {
            "id": "45efb520-4751-4f0c-a55e-9c035b58a8fa",
            "tracingStructure": { "name": "dendrite", "value": 2, "id": "aef2ba31-…" },
            "soma": { /* same shape */ }
          }
        ]
      }],
      "error": null
    }
  }
}
```

Then fetch each `tracings[i].id` from `/tracings` to get the full node list.

---

## 7. Optional, only-if-you-want-it

The GraphQL server also exposes (used in the SPA but **not needed for metadata + nodes**):
- `tomographyMetadata { id name origin pixelSize threshold limits { horizontal sagittal coronal } }` — bounding info for the 2D slice viewer.
- `brainAreas { … geometryFile geometryEnable }` already in the constants query — only relevant if you later decide to pull region surfaces from `/static/allen/obj/<structureId>.obj` (CCFv2.5) or `/static/ccf-2017/obj/<structureId>.obj` (CCFv3). Out of scope per this plan.

---

## 8. Suggested ingest sequence

1. `GET /system` — sanity check; record `systemVersion`, `searchScope`, `exportLimit`.
2. `POST /graphql` ConstantsQuery (`searchScope: 6`) — cache `tracingStructures`, `structureIdentifiers`, `queryOperators`, `brainAreas`. Build lookup tables:
   - `brainAreaUuid → { allenStructureId:int, acronym, name, structureIdPath:int[] }`
   - `structureIdentifierUuid → swcValue:int (0..6)`
   - `tracingStructureUuid → "axon" | "dendrite"`
3. `POST /graphql` SearchNeurons with an empty/invert-all predicate (§4.2 a) and `ccfVersion: "CCFV30"` — get all 1653 neurons and their tracing UUIDs.
4. For each batch of 5–10 tracing UUIDs:
   - `POST /tracings` with `{"ids":[…]}`.
   - For each returned tracing: emit one node table with columns
     `neuron_id_string, tracing_id, tracing_kind (axon/dendrite), sample_number, parent_number, x_um, y_um, z_um, radius_um, swc_type, brain_area_acronym_ccfv25, brain_area_structureid_ccfv25, brain_area_acronym_ccfv30, brain_area_structureid_ccfv30`.
   - Cache the raw JSON keyed by tracing UUID to make re-ingest cheap.
5. Persist as parquet partitioned by `neuron_id_string` (or as one row-per-node table; ~1653 neurons × ~2 tracings × ~hundreds-to-thousands of nodes ≈ a few million rows — well within a single parquet file).

---

## 9. Gotchas, tested

- **Introspection disabled.** Do not rely on `__schema`. Use the queries in §3 and §4 exactly as written; they're lifted from `/bundle.js`.
- **`SearchContext.ccfVersion` is required.** Omitting it produces `Field ccfVersion of required type CcfVersion! was not provided.`
- **`PredicateType` is a string enum** (`"ANATOMICAL"`, `"CUSTOM"`, `"ID"`), not an int. The bundle stores both forms (`PredicateType` int + `PredicateTypeValue` string); the GraphQL API takes the string.
- **`scope` is an Int** matching `SearchScope` (use `6` for Public).
- **Coordinates are µm in CCF.** No need to scale.
- **Radii are radii (µm).** SWC consumers expect diameter; multiply by 2 on emit if you're producing canonical SWC.
- **`geometryFile` lies.** It's a legacy display name like `PRNr_146.obj`; the actually served mesh path is `<structureId>.obj` (e.g. `997.obj`). Not relevant for this ingest, just don't trust the string if you ever do fetch surfaces.
- **No pagination on `searchNeurons`.** One call returns everything matching, with `queryTime` (ms) included.
- **No rate limit documented.** Throttle yourself; sequential batches of ≤10 are safe.
- **License / attribution.** Data is published under the Janelia MouseLight project (Winnubst et al. 2019, *Cell*; Economo et al. 2016, *eLife*). Cite both when redistributing.

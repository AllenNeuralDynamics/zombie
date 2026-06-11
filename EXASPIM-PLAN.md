# Reverse-engineering notes — Neuron Morphology Community Portal

Site: <https://morphology.allenneuraldynamics.org/>
Captured: 2026-06-10

## TL;DR

- **Frontend:** Single-page React app (webpack bundle), MobX for state, **Apollo Client** for GraphQL, **Semantic UI** (CDN) for styling, **Three.js** + WebGL canvas for 3D.
- **API:** Single **GraphQL** endpoint at `POST /graphql` (same origin). A small `GET /system` returns runtime config.
- **3D viewer:** **Neuroglancer** (confirmed by `?neuroglancer=…` query params and a console warning about the `google-brainmaps` credentials provider). One `<canvas>` element, neuron skeletons + CCF reference atlas rendered together.
- **Bulk data:** **Neuroglancer "precomputed"** format served as static files from
  - **AWS S3:** `s3://aind-neuron-morphology-community-portal-prod-o5171v/ngv01/` (neurons — split into `full/`, `axon/`, `dendrite/` segmentations, each with `info`, `segment_properties/info`, `skeleton/info`).
  - **Google Cloud Storage:** `gs://allen_neuroglancer_ccf/ccf_test1/` (Allen CCF reference atlas — `info`, `mesh/`, `segment_properties/`).
- 132 published neurons total. Each neuron has a UUIDv7-style ID; routes look like `/neuron/<uuid>` and `/candidates`.

## Network capture (after page load + a Search click)

App bundle:

- `GET /` (HTML shell) → loads `bundle.js`, code-split chunks `717.bundle.js`, `471.bundle.js`.
- `GET https://cdnjs.cloudflare.com/ajax/libs/semantic-ui/2.4.0/semantic.min.css`
- `GET https://fonts.googleapis.com/css?family=Lato:...`

Application API (own origin):

- `GET /system` →
  ```json
  {
    "systemVersion": "3.0.11",
    "precomputedLocation": "s3://aind-neuron-morphology-community-portal-prod-o5171v/ngv01",
    "doiHandler": "https://doi.org",
    "exportLimit": 20
  }
  ```
- `POST /graphql` — all metadata, search, and per-neuron data.

Bulk/3D data (cross-origin, fetched directly by Neuroglancer):

- `https://aind-neuron-morphology-community-portal-prod-o5171v.s3.amazonaws.com/ngv01/{full,axon,dendrite}/info`
- `…/ngv01/{full,axon,dendrite}/segment_properties/info`
- `…/ngv01/{full,axon,dendrite}/skeleton/info`
- `https://www.googleapis.com/storage/v1/b/allen_neuroglancer_ccf/o/ccf_test1%2F{info,segment_properties/info,mesh/info,mesh/997:0,mesh/997:0:0}?alt=media&neuroglancer=…`

## GraphQL schema highlights (captured from in-flight requests)

Operations observed:

- `UserQuery` → `user { id authDirectoryId firstName lastName emailAddress affiliation permissions }`
- `ConstantsQuery` → `systemSettings { apiVersion neuronCount }`, `neuronStructures`, `nodeStructures { id name swcValue }`, `queryOperators { id display operator }`, `atlasStructures { id name acronym aliases structureId depth parentStructureId structureIdPath defaultColor hasGeometry }`
- `GenotypesQuery` → `genotypes { id name }`
- `CollectionsQuery` → `collections { id name description reference specimenCount }`
- `SpecimensQuery($input: SpecimenQueryInput)` → `specimens { totalCount items { id label notes referenceDate referenceDataset { url segmentationUrl } tomography { url options { range window } linearTransform { scale{x,y,z} translate{x,y,z} } } … } }`

So the GraphQL service is the single source of truth for metadata, search filters, and per-specimen pointers; the actual neuron geometry and atlas meshes are pulled by Neuroglancer from precomputed cloud buckets via the URLs that GraphQL hands out (e.g. `referenceDataset.url`, `segmentationUrl`, `tomography.url`).

## Detected client-side globals

`__reactRouterVersion`, `__mobxInstanceCount`, `__mobxGlobals`, `__THREE__`, `__APOLLO_CLIENT__` → React + React Router + MobX + Three.js + Apollo confirmed.

## Implications for "exaSPIM-style" planning

If we want to mimic this stack:

1. Host neuron / volume data as **Neuroglancer precomputed** layers on S3 (already what AIND does).
2. Stand up a **GraphQL** (or any) service that returns, per specimen: `referenceDataset.url`, `segmentationUrl`, `tomography.url` (+ transforms, windowing, etc.). Atlas structure tree comes from the same service.
3. Embed **Neuroglancer** in a React shell; let it fetch directly from S3/GCS — no proxying needed because precomputed buckets are CORS-enabled.
4. Use the **`exportLimit` / `precomputedLocation`** style `/system` endpoint pattern for runtime config (avoids baking S3 paths into the bundle).

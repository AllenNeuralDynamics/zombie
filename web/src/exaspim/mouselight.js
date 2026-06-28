/**
 * exaspim/mouselight.js — Janelia MouseLight neuron source for the morphology
 * viewer.
 *
 * MouseLight (https://ml-neuronbrowser.janelia.org) publishes ~1.6K single
 * projection neurons reconstructed and registered to the Allen CCF. Unlike the
 * AIND portal neurons (which are served as Neuroglancer "precomputed"
 * segmentations), MouseLight only exposes skeleton node arrays via a small
 * JSON API. We fetch those nodes and render each neuron as a Neuroglancer
 * **local annotation** layer of line segments (one per parent→child edge).
 *
 * Coordinates are micrometres in CCFv3 space, the same space the AIND atlas
 * (`gs://allen_neuroglancer_ccf/ccf_test1`) uses. The atlas dimensions are
 * 10µm voxels, so we divide every µm coordinate by 10 to place MouseLight
 * skeletons in the shared scene.
 *
 * Pure helpers (`buildMouseLightAnnotationLayer`, `buildSearchContext`) are
 * exported for unit tests.
 */

// ─── Endpoints ──────────────────────────────────────────────────────────────

/**
 * Same-origin proxy prefix for the Janelia MouseLight API. The browser cannot
 * call `https://ml-neuronbrowser.janelia.org/*` directly — its `/tracings`
 * endpoint omits `Access-Control-Allow-Origin`, so CORS blocks the skeleton
 * fetches. We route both `/graphql` and `/tracings` through a same-origin
 * proxy instead (Vite dev server / nginx in prod, both stripping the
 * `/mouselight` prefix and forwarding to the Janelia host).
 */
const ML_BASE = '/mouselight';
const ML_GRAPHQL_URL = `${ML_BASE}/graphql`;
const ML_TRACINGS_URL = `${ML_BASE}/tracings`;

/** Public search scope (SearchScope.Public). */
const ML_SCOPE = 6;
/** MouseLight UUID for the CCF root region (structureId 997, "wholebrain"). */
const ML_ROOT_BRAIN_AREA = '464cb1ee-4664-40dc-948f-85dd1feb3e40';

/**
 * Neuroglancer output dimensions for the annotation source — must match the
 * CCF atlas voxel size (10µm) so skeletons overlay the brain correctly.
 */
const ML_DIMENSIONS = { x: [1e-5, 'm'], y: [1e-5, 'm'], z: [1e-5, 'm'] };
/** µm → 10µm-voxel scale factor. */
const ML_SCALE = 1 / 10;

/** Distinct colours cycled across selected MouseLight neurons. */
const ML_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080',
];

export function mouseLightColor(index) {
  return ML_PALETTE[((index % ML_PALETTE.length) + ML_PALETTE.length) % ML_PALETTE.length];
}

// ─── GraphQL ────────────────────────────────────────────────────────────────

const SEARCH_NEURONS_QUERY = `query SearchNeurons($context: SearchContext) {
  searchNeurons(context: $context) {
    totalCount
    neurons {
      id
      idString
      brainArea { acronym }
      tracings {
        id
        tracingStructure { name value }
      }
    }
    error { name message }
  }
}`;

/**
 * Build a SearchContext that returns every public neuron. The documented
 * "invert all" ID predicate returns a count but an empty neuron list, so we
 * scope an ANATOMICAL predicate to the whole-brain root region instead, which
 * reliably returns the full set with tracing UUIDs.
 */
export function buildSearchContext() {
  return {
    scope: ML_SCOPE,
    nonce: 'zombie',
    ccfVersion: 'CCFV30',
    predicates: [
      {
        predicateType: 'ANATOMICAL',
        tracingIdsOrDOIs: [],
        tracingIdsOrDOIsExactMatch: false,
        tracingStructureIds: [],
        nodeStructureIds: [],
        operatorId: null,
        amount: 0,
        brainAreaIds: [ML_ROOT_BRAIN_AREA],
        arbCenter: { x: null, y: null, z: null },
        arbSize: null,
        invert: false,
        composition: 1,
      },
    ],
  };
}

async function mlGql(query, variables, signal) {
  const res = await fetch(ML_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message ?? 'GraphQL error');
  return body.data;
}

/**
 * Fetch the full MouseLight neuron list.
 *
 * @returns {Promise<Array<{id, idString, region, tracings:Array<{id, kind}>}>>}
 */
export async function fetchMouseLightNeurons(signal) {
  const data = await mlGql(SEARCH_NEURONS_QUERY, { context: buildSearchContext() }, signal);
  const result = data?.searchNeurons;
  if (result?.error) throw new Error(result.error.message ?? 'MouseLight search error');
  const neurons = (result?.neurons ?? []).map((n) => ({
    id: n.id,
    idString: n.idString ?? '',
    region: n.brainArea?.acronym ?? '',
    tracings: (n.tracings ?? []).map((t) => ({
      id: t.id,
      kind: t.tracingStructure?.name ?? '',
    })),
  }));
  neurons.sort((a, b) => a.idString.localeCompare(b.idString, undefined, { numeric: true }));
  return neurons;
}

/**
 * Fetch skeleton nodes for one or more tracing UUIDs.
 *
 * @returns {Promise<Array<{id, nodes:Array}>>}
 */
export async function fetchMouseLightTracings(ids, signal) {
  if (!ids || ids.length === 0) return [];
  const res = await fetch(ML_TRACINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
    signal,
  });
  if (!res.ok) throw new Error(`tracings HTTP ${res.status}`);
  const body = await res.json();
  return body?.tracings ?? [];
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Build a Neuroglancer local-annotation layer of line segments for one neuron.
 *
 * @param {string} idString  Neuron label (e.g. "AA0001"); used as the layer name.
 * @param {Array<{nodes:Array<{sampleNumber,parentNumber,x,y,z}>}>} tracings
 *   The tracing node arrays from `/tracings` (axon + dendrite).
 * @param {string} color  CSS hex colour for the skeleton.
 * @returns {object} A Neuroglancer annotation layer.
 */
export function buildMouseLightAnnotationLayer(idString, tracings, color = ML_PALETTE[0]) {
  const annotations = [];
  let counter = 0;
  for (const tr of tracings ?? []) {
    const byNum = new Map();
    for (const n of tr.nodes ?? []) byNum.set(n.sampleNumber, n);
    for (const n of tr.nodes ?? []) {
      if (n.parentNumber == null || n.parentNumber < 0) continue;
      const p = byNum.get(n.parentNumber);
      if (!p) continue;
      annotations.push({
        type: 'line',
        id: String(counter++),
        pointA: [n.x * ML_SCALE, n.y * ML_SCALE, n.z * ML_SCALE],
        pointB: [p.x * ML_SCALE, p.y * ML_SCALE, p.z * ML_SCALE],
      });
    }
  }
  return {
    type: 'annotation',
    name: `ML-${idString}`,
    source: {
      url: 'local://annotations',
      transform: { outputDimensions: ML_DIMENSIONS },
    },
    annotations,
    annotationColor: color,
    // Render each edge as a bare line. Neuroglancer otherwise draws a filled
    // circle at every line endpoint, which on a dense skeleton (thousands of
    // nodes) looks like a cloud of dots. Zeroing the endpoint marker size hides
    // those circles so MouseLight neurons read as clean lines, like the AIND
    // precomputed skeletons (which use `skeletonRendering`, not annotations).
    shader: [
      'void main() {',
      '  setLineColor(defaultColor());',
      '  setEndpointMarkerSize(0.0);',
      '  setEndpointMarkerBorderWidth(0.0);',
      '}',
    ].join('\n'),
  };
}


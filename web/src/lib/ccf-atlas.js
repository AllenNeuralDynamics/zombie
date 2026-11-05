export const CCF_ATLAS_ID = '019d9127-08c9-71c1-93db-dd1516a7b09f';
export const CCF_SOURCE = 'precomputed://gs://allen_neuroglancer_ccf/ccf_test1';
export const CCF_ROOT_SEGMENT = '997';
export const CCF_GRAPHQL_URL = 'https://morphology.allenneuraldynamics.org/graphql';

const ATLAS_QUERY = `query CcfStructures($atlasId: String!) {
  atlasStructures(atlasId: $atlasId) {
    id name acronym structureId parentStructureId
    structureIdPath defaultColor hasGeometry
  }
}`;

export async function fetchCcfStructures({ fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(CCF_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: ATLAS_QUERY, variables: { atlasId: CCF_ATLAS_ID } }),
    signal,
  });
  if (!response.ok) throw new Error(`CCF atlas request failed: HTTP ${response.status}`);
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('CCF atlas response is not a JSON object');
  }
  if (body.errors && !Array.isArray(body.errors)) {
    throw new Error('CCF atlas response has malformed errors');
  }
  if (body.errors?.length) throw new Error(body.errors[0].message ?? 'CCF atlas query failed');
  if (!Array.isArray(body.data?.atlasStructures)) {
    throw new Error('CCF atlas response has no atlasStructures array');
  }
  return body.data.atlasStructures;
}

export function ccfColorMap(structures) {
  if (!Array.isArray(structures)) throw new Error('CCF atlas structures must be an array');
  const colors = new Map();
  for (const structure of structures) {
    const id = structure?.structureId;
    const color = structure?.defaultColor;
    if ((typeof id !== 'string' && typeof id !== 'number') ||
      !/^(?:#)?[0-9a-f]{6}$/i.test(String(color ?? ''))) {
      throw new Error('CCF atlas structure has an invalid ID or default color');
    }
    colors.set(String(id), `#${String(color).replace(/^#/, '')}`);
  }
  return colors;
}

export function buildCcfLayer({
  name,
  segments,
  objectAlpha,
  notSelectedAlpha,
  colors = null,
  allColors = false,
  meshSilhouetteRendering,
  tab,
}) {
  const layer = {
    type: 'segmentation',
    source: CCF_SOURCE,
    name,
    objectAlpha,
    segments: segments.map(String),
  };
  if (notSelectedAlpha !== undefined) layer.notSelectedAlpha = notSelectedAlpha;
  if (meshSilhouetteRendering !== undefined) layer.meshSilhouetteRendering = meshSilhouetteRendering;
  if (tab !== undefined) layer.tab = tab;
  if (colors) {
    const segmentColors = {};
    const selected = allColors ? null : new Set(segments.map(String));
    for (const [id, color] of colors) {
      if (allColors || selected.has(id)) segmentColors[id] = color;
    }
    if (Object.keys(segmentColors).length) layer.segmentColors = segmentColors;
  }
  return layer;
}

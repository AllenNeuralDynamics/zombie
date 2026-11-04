/**
 * Editable `qc_errors` annotation layer: one local point per QC location, tagged
 * with its metric and status. Port of neuron-ng `recipes/qc_review.py:review_layer`.
 */
export const REVIEW_LAYER = 'qc_errors';
export const REVIEW_STATUSES = ['Pass', 'Fail', 'Pending'];
/** Point colors (RGB) by status. */
export const REVIEW_STATUS_COLORS = { Pass: [0, 1, 0], Fail: [1, 0, 0], Pending: [1, 1, 0] };

const vec3 = rgb => `vec3(${rgb.map(v => v.toFixed(2)).join(', ')})`;
const POINT_SHADER = [
  'void main() {',
  '  uint status = prop_status();',
  ...REVIEW_STATUSES.map((s, i) => `  ${i ? '} else if' : 'if'} (status == ${i}u) {\n    setColor(${vec3(REVIEW_STATUS_COLORS[s])});`),
  '  } else {',
  '    setColor(defaultColor());',
  '  }',
  '  setPointMarkerSize(10.0);',
  '}',
  '',
].join('\n');
const UM = [1e-6, 'm'];

export function createReviewLayer() {
  return {
    type: 'annotation',
    name: REVIEW_LAYER,
    source: { url: 'local://annotations', transform: { outputDimensions: { x: UM, y: UM, z: UM } } },
    tab: 'annotations',
    annotationColor: '#ffff00',
    shader: POINT_SHADER,
    annotationProperties: [
      { id: 'metric', type: 'uint16', enum_values: [], enum_labels: [] },
      { id: 'status', type: 'uint8', enum_values: REVIEW_STATUSES.map((_, i) => i), enum_labels: [...REVIEW_STATUSES] },
    ],
    annotations: [],
  };
}

function getReviewLayer(state) {
  let layer = state.layers.find(l => l.name === REVIEW_LAYER);
  if (!layer) {
    layer = createReviewLayer();
    state.layers.push(layer);
    // Selected but closed: opening the side panel lands on the review list.
    state.selectedLayer = { layer: REVIEW_LAYER, visible: false };
  }
  return layer;
}

const STATUS_SEVERITY = { Fail: 2, Pending: 1, Pass: 0 };

/**
 * Selects the worst-status review point at `xyz` (µm) and opens the selection panel, or
 * clears the selection; returns its id. Neuroglancer can only select one annotation per layer.
 */
export function selectReviewPoint(state, xyz) {
  const point = xyz.map(Number);
  const layer = state.layers.find(l => l.name === REVIEW_LAYER);
  const severity = a => STATUS_SEVERITY[REVIEW_STATUSES[a.props[1]]] ?? 0;
  const match = (layer?.annotations ?? [])
    .filter(a => a.point.every((v, i) => v === point[i]))
    .reduce((worst, a) => (!worst || severity(a) > severity(worst) ? a : worst), null);
  const selection = { ...state.selection };
  delete selection.layers;
  state.selection = match
    ? { ...selection, visible: true, layers: { [REVIEW_LAYER]: { annotationId: match.id, annotationSource: 0 } } }
    : selection;
  return match?.id ?? null;
}

/** Adds a point at `xyz` (µm) for `metric`; returns false if that metric already has it. */
export function addReviewPoint(state, { xyz, metric, status }) {
  const layer = getReviewLayer(state);
  const name = String(metric ?? '');
  const point = xyz.map(Number);
  const metricSpec = layer.annotationProperties[0];
  let code = metricSpec.enum_labels.indexOf(name);
  if (code !== -1 && layer.annotations.some(a => a.props[0] === code && a.point.every((v, i) => v === point[i]))) {
    return false;
  }
  if (code === -1) {
    code = metricSpec.enum_labels.length;
    metricSpec.enum_labels.push(name);
    metricSpec.enum_values.push(code);
  }
  const statusLabel = REVIEW_STATUSES.includes(status) ? status : 'Pending';
  layer.annotations.push({
    type: 'point',
    id: `${name}-${layer.annotations.length}`,
    point,
    description: `${name} · ${statusLabel}`,
    props: [code, REVIEW_STATUSES.indexOf(statusLabel)],
  });
  return true;
}

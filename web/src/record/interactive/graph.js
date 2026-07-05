/**
 * graph.js — Layout engine for the record interactive view.
 *
 * Adapted from the aind-data-schema diagram-app (which draws the *schema*): here
 * every node is a live object/array from a specific record, and a field is
 * "expandable" when its actual value is a container (object or array) rather
 * than because the schema says its type is a model.  The dagre-based positioning
 * and orthogonal-lane edge routing are kept verbatim from the schema diagram so
 * the two views look and behave the same.
 */

import dagre from 'dagre';

/** Layout constants shared between graph building and node rendering. */
export const NODE_WIDTH = 320;
export const HEADER_H = 34;
export const ROW_H = 26;
export const PADDING_BOTTOM = 6;
const RANK_SEP = 50;
const NODE_SEP = 20;
const MIN_GAP = 16;
export const ROOT_COLOR = '#334155';
export const BASE_TURN = 24;
export const LANE_STEP = 16;
const CLEARANCE_BUFFER = 24;

/** Scalar string values longer than this are truncated in the card (full text on hover). */
export const MAX_VALUE_CHARS = 48;

// ---------------------------------------------------------------------------
// Value helpers — the record view is driven entirely by the data, not a schema.
// ---------------------------------------------------------------------------

/** A value is drillable (gets its own card on expand) iff it's a non-null object or array. */
export function isContainer(value) {
  return value !== null && typeof value === 'object';
}

/** The (label, value) rows of a container: object keys, or array indices. */
export function entriesOf(value) {
  if (Array.isArray(value)) return value.map((v, i) => ({ label: String(i), value: v }));
  return Object.keys(value).map((k) => ({ label: k, value: value[k] }));
}

/** How a value is shown inline in a row. `full` (when set) is the untruncated hover text. */
export function valueSummary(value) {
  if (value === null) return { text: 'null', kind: 'null' };
  if (Array.isArray(value)) return { text: `[ ${value.length} ]`, kind: 'container' };
  if (typeof value === 'object') {
    return { text: `{ ${Object.keys(value).length} }`, kind: 'container' };
  }
  if (typeof value === 'string') {
    const quoted = `"${value}"`;
    const text = quoted.length > MAX_VALUE_CHARS ? `${quoted.slice(0, MAX_VALUE_CHARS - 1)}…"` : quoted;
    return { text, kind: 'string', full: quoted };
  }
  return { text: String(value), kind: typeof value };
}

export const Side = { L: 'l', R: 'r' };

export function branchColor(index, total) {
  const hue = Math.round((360 * index) / total);
  return `hsl(${hue}, 60%, 40%)`;
}

/** Recover the instance id a field path belongs to (`${instanceId}::${label}`). */
export function instanceOfFieldPath(fieldPath) {
  return fieldPath.slice(0, fieldPath.lastIndexOf('::'));
}

/** The top-level core-file branch an instance/field path belongs to, or null for the root. */
export function branchOf(id) {
  if (id === 'root') return null;
  const parts = id.split('::');
  return parts[1];
}

/** Number of rows a card will render (one per entry of its container value). */
export function estimateHeight(instance) {
  const count = isContainer(instance.value) ? entriesOf(instance.value).length : 0;
  return HEADER_H + count * ROW_H + PADDING_BOTTOM;
}

// ---------------------------------------------------------------------------
// Core files: the record's top-level container fields, split/coloured like the
// schema diagram's core files so the initial fan-out out of the root matches.
// ---------------------------------------------------------------------------

/** Top-level container keys, in record order — these are the record's "core files". */
export function coreFilesOf(record) {
  return entriesOf(record)
    .filter((e) => isContainer(e.value))
    .map((e) => e.label);
}

function coreFieldAssignments(record) {
  const coreFiles = coreFilesOf(record);
  const half = Math.ceil(coreFiles.length / 2);
  const assignments = new Map();
  coreFiles.forEach((key, i) => {
    assignments.set(key, { side: i < half ? Side.L : Side.R, color: branchColor(i, coreFiles.length) });
  });
  return assignments;
}

/** Every field path that starts expanded: just the root's own core-file (container) fields. */
export function computeSeedExpansion(record) {
  const seed = new Set();
  for (const e of entriesOf(record)) {
    if (isContainer(e.value)) seed.add(`root::${e.label}`);
  }
  return seed;
}

/** Build the instances/edges currently visible for the given expansion set. */
export function buildInstanceTree(record, expandedFields) {
  const instances = [];
  const edges = [];
  const coreAssignments = coreFieldAssignments(record);

  const root = { id: 'root', value: record, parentId: null, side: null, color: ROOT_COLOR, title: 'Metadata' };
  instances.push(root);

  function fieldSideColor(parent, label) {
    const override = parent.id === 'root' ? coreAssignments.get(label) : undefined;
    return { side: override?.side ?? parent.side ?? Side.R, color: override?.color ?? parent.color };
  }

  function addChild(parent, entry) {
    const id = `${parent.id}::${entry.label}`;
    const { side, color } = fieldSideColor(parent, entry.label);
    const title = Array.isArray(entry.value) ? `${entry.label} [ ${entry.value.length} ]` : entry.label;
    const child = { id, value: entry.value, parentId: parent.id, side, color, title };
    instances.push(child);
    edges.push({ id, source: parent.id, sourceHandle: `out-${entry.label}`, target: id, color, lane: 0 });
    walk(child);
  }

  function walk(instance) {
    for (const entry of entriesOf(instance.value)) {
      if (!isContainer(entry.value)) continue;
      if (!expandedFields.has(`${instance.id}::${entry.label}`)) continue;
      addChild(instance, entry);
    }
  }

  walk(root);
  return { instances, edges };
}

/** Every expandable field path reachable from the root, expanded all the way down. */
export function computeFullExpansion(record) {
  const expanded = new Set();

  function walk(instanceId, value) {
    for (const entry of entriesOf(value)) {
      if (!isContainer(entry.value)) continue;
      const fieldPath = `${instanceId}::${entry.label}`;
      expanded.add(fieldPath);
      walk(fieldPath, entry.value);
    }
  }

  walk('root', record);
  return expanded;
}

// ---------------------------------------------------------------------------
// Positioning — unchanged from the schema diagram apart from reading heights /
// row order off the live instance instead of a schema model.
// ---------------------------------------------------------------------------

function outwardClearance(instanceId, edges, side, instancesById) {
  let maxLane = -1;
  for (const e of edges) {
    if (e.source !== instanceId) continue;
    if (side && instancesById?.get(e.target)?.side !== side) continue;
    maxLane = Math.max(maxLane, e.lane);
  }
  return maxLane < 0 ? 0 : BASE_TURN + maxLane * LANE_STEP + CLEARANCE_BUFFER;
}

function assignLanes(instances, edges, instancesById, centerY) {
  for (const side of [Side.L, Side.R]) {
    const bySource = new Map();
    for (const e of edges) {
      if (instancesById.get(e.target)?.side !== side) continue;
      const group = bySource.get(e.source) ?? [];
      group.push(e);
      bySource.set(e.source, group);
    }

    for (const [sourceId, group] of bySource) {
      const source = instancesById.get(sourceId);
      const sourceEntries = source ? entriesOf(source.value) : [];
      const sourceTop = (centerY.get(sourceId) ?? 0) - (source ? estimateHeight(source) : 0) / 2;

      const withDirection = group.map((edge) => {
        const label = edge.sourceHandle.replace(/^out-/, '');
        const rowIndex = Math.max(0, sourceEntries.findIndex((e) => e.label === label));
        const rowY = sourceTop + HEADER_H + rowIndex * ROW_H + ROW_H / 2;
        const targetCenterY = centerY.get(edge.target) ?? 0;
        return { edge, isUp: targetCenterY < rowY };
      });

      const upGroup = withDirection.filter((w) => w.isUp);
      const downGroup = withDirection.filter((w) => !w.isUp);
      upGroup.forEach((w, i) => (w.edge.lane = i));
      downGroup.forEach((w, i) => (w.edge.lane = downGroup.length - 1 - i));
    }
  }
}

function layoutSide(instances, edges, side, instancesById, colX, applyClearance) {
  const group = instances.filter((i) => i.side === side);
  const positions = new Map();
  if (group.length === 0) return positions;

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: RANK_SEP });
  g.setDefaultEdgeLabel(() => ({}));
  const idSet = new Set(group.map((i) => i.id));
  group.forEach((i) => {
    const clearance = applyClearance ? outwardClearance(i.id, edges, side, instancesById) : 0;
    g.setNode(i.id, { width: NODE_WIDTH + 2 * clearance, height: estimateHeight(i) });
  });
  edges.forEach((e) => {
    if (idSet.has(e.source) && idSet.has(e.target)) g.setEdge(e.source, e.target);
  });
  dagre.layout(g);

  const topLevel = group.filter((i) => i.parentId === 'root');
  const refX = topLevel.length ? g.node(topLevel[0].id).x : 0;
  const avgY = topLevel.length ? topLevel.reduce((sum, i) => sum + g.node(i.id).y, 0) / topLevel.length : 0;

  group.forEach((i) => {
    const n = g.node(i.id);
    const dx = n.x - refX;
    const x = side === Side.L ? -colX - dx : colX + dx;
    positions.set(i.id, { x, y: n.y - avgY });
  });
  return positions;
}

/** Top-left position (React Flow convention) for every instance, keyed by instance id. */
export function computePositions(instances, edges) {
  const instancesById = new Map(instances.map((i) => [i.id, i]));

  const placeholderColX = NODE_WIDTH + MIN_GAP;
  const prelimLeft = layoutSide(instances, edges, Side.L, instancesById, placeholderColX, false);
  const prelimRight = layoutSide(instances, edges, Side.R, instancesById, placeholderColX, false);
  const centerY = new Map([['root', 0]]);
  for (const inst of instances) {
    const p = (inst.side === Side.L ? prelimLeft : prelimRight).get(inst.id);
    if (p) centerY.set(inst.id, p.y);
  }

  assignLanes(instances, edges, instancesById, centerY);

  const colXFor = (side) => NODE_WIDTH + outwardClearance('root', edges, side, instancesById) + MIN_GAP;
  const left = layoutSide(instances, edges, Side.L, instancesById, colXFor(Side.L), true);
  const right = layoutSide(instances, edges, Side.R, instancesById, colXFor(Side.R), true);

  const result = new Map();
  for (const inst of instances) {
    const h = estimateHeight(inst);
    const center =
      inst.id === 'root' ? { x: 0, y: 0 } : (inst.side === Side.L ? left : right).get(inst.id) ?? { x: 0, y: 0 };
    result.set(inst.id, { x: center.x - NODE_WIDTH / 2, y: center.y - h / 2 });
  }
  return result;
}

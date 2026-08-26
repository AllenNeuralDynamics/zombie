/**
 * verification-graph/layout.js — dagre layout for the verification graph.
 *
 * The graph is laid out **bottom-up by derivation depth**: entities and
 * relations and the statements resting directly on them sit at the bottom,
 * and each claim built on top of them sits one rank higher. That is the whole
 * visual argument of the page — verified foundations under the claims that
 * depend on them — so the layout is driven by `depth` from the snapshot, not
 * by dagre's own ranking of the mixed edge set.
 */

import dagre from 'dagre';

/** Node box sizes, keyed by kind. Statements are cards; relations are pills. */
export const NODE_SIZE = {
  statement: { width: 260, height: 92 },
  entity: { width: 190, height: 46 },
  relation: { width: 170, height: 38 },
};

const RANK_SEP = 90;
const NODE_SEP = 28;

/** Return the box size for a snapshot node summary. */
export function sizeOf(node) {
  return NODE_SIZE[node.kind] ?? NODE_SIZE.entity;
}

/**
 * Position every node, returning `Map<id, {x, y}>` of top-left corners.
 *
 * `depends_on` edges point from a claim down to its evidence, so they are fed
 * to dagre reversed (evidence → claim) with `rankdir: 'BT'`; the structural
 * triple edges are fed as-is so a statement sits above its own subject,
 * relation and object.
 */
export function computeLayout(snapshot) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'BT', nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));

  const ids = new Set();
  for (const node of snapshot?.nodes ?? []) {
    const { width, height } = sizeOf(node);
    graph.setNode(node.id, { width, height });
    ids.add(node.id);
  }

  for (const edge of snapshot?.edges ?? []) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    // Both edge families run evidence → claim, so dagre ranks foundations low.
    graph.setEdge(edge.target, edge.source);
  }

  dagre.layout(graph);

  const positions = new Map();
  for (const node of snapshot?.nodes ?? []) {
    const laid = graph.node(node.id);
    if (!laid) continue;
    positions.set(node.id, { x: laid.x - laid.width / 2, y: laid.y - laid.height / 2 });
  }
  return positions;
}

/**
 * verification-graph/model.js — vocabulary shared by the shell and the graph.
 *
 * Pure functions over snapshot node summaries: how a status reads, how an
 * axis tick reads, and what a node's search text is. Kept out of the React
 * layer so the vanilla shell can use them without pulling React in, and so
 * they're unit-testable on their own.
 */

/** The four verification axes, in the order they are drawn as ticks. */
export const AXES = ['reproducible', 'replicable', 'robust', 'generalizable'];

/** Short letter drawn inside each axis tick. */
export const AXIS_LETTER = {
  reproducible: 'R',
  replicable: 'R',
  robust: 'R',
  generalizable: 'G',
};

/** What each axis actually means — shown when a tick is clicked. */
export const AXIS_MEANING = {
  reproducible: 'Same data, same code. The node’s pinned code, re-run against its pinned data assets in its pinned environment, produces the same result. This is the minimum bar.',
  replicable: 'Different data, same code. The code is re-run on held-out or resampled data — cross-validation over trials, or another session — and the statement still holds.',
  robust: 'Same data, different code. An independent second implementation — different test statistic, different binning, ideally a different author — reaches the same conclusion.',
  generalizable: 'Different data and different code. Both are swapped and the statement still holds.',
};

/** How each axis status is drawn: filled, hollow, crossed, or dimmed. */
export const AXIS_MARK = {
  passed: 'filled',
  not_attempted: 'hollow',
  failed: 'crossed',
  stale: 'dimmed',
};

/** Plain-English label for an axis status. */
export const AXIS_STATUS_LABEL = {
  passed: 'passed',
  failed: 'failed',
  not_attempted: 'not attempted',
  stale: 'stale',
};

/** Plain-English label for a node status. */
export const STATUS_LABEL = {
  verified: 'Verified',
  proposed: 'Proposed',
  stale: 'Stale',
  failed: 'Failed',
};

/**
 * Return the CSS custom property holding a status's colour.
 * Statuses map onto the palette's semantic status colours (see STYLE.md).
 */
export function statusVar(status) {
  switch (status) {
    case 'verified':
      return 'var(--vg-status-verified)';
    case 'failed':
      return 'var(--vg-status-failed)';
    case 'stale':
      return 'var(--vg-status-stale)';
    default:
      return 'var(--vg-status-proposed)';
  }
}

/** Effective status of a snapshot node summary, defaulting sensibly per kind. */
export function effectiveStatus(node) {
  if (node.kind !== 'statement') return null;
  return node.effective_status ?? node.status ?? 'proposed';
}

/** True when a statement is fully verified, dependencies included. */
export function isFullyVerified(node) {
  return node.kind === 'statement' && effectiveStatus(node) === 'verified';
}

/** Lowercased text a search box matches against. */
export function searchText(node) {
  return `${node.label ?? ''} ${node.id ?? ''} ${node.entity_type ?? ''}`.toLowerCase();
}

/**
 * Index a snapshot for lookup: `{ byId, edges, dependents }`.
 *
 * `dependents` maps a node id to the statements that derive from it, which is
 * what "collapse everything not verified" needs to keep foundations visible.
 */
export function indexSnapshot(snapshot) {
  const byId = new Map((snapshot?.nodes ?? []).map((n) => [n.id, n]));
  const edges = snapshot?.edges ?? [];
  const dependents = new Map();
  for (const edge of edges) {
    if (edge.type !== 'depends_on') continue;
    if (!dependents.has(edge.target)) dependents.set(edge.target, []);
    dependents.get(edge.target).push(edge.source);
  }
  return { byId, edges, dependents };
}

/**
 * Filter a snapshot down to the nodes the toolbar's controls select.
 *
 * A statement survives the filters on its own merits; the entities and the
 * relation of a surviving statement are always kept, so the graph never shows
 * a triple with a missing corner.
 *
 * @param {object} snapshot
 * @param {{ verifiedOnly?: boolean, status?: string, query?: string }} filters
 */
export function filterSnapshot(snapshot, { verifiedOnly = false, status = '', query = '' } = {}) {
  const nodes = snapshot?.nodes ?? [];
  const needle = query.trim().toLowerCase();

  const keep = new Set();
  for (const node of nodes) {
    if (node.kind !== 'statement') continue;
    if (verifiedOnly && !isFullyVerified(node)) continue;
    if (status && effectiveStatus(node) !== status) continue;
    if (needle && !searchText(node).includes(needle)) continue;
    keep.add(node.id);
  }

  // A search that matches no statement should still show matching entities and
  // relations, otherwise searching for a brain area returns an empty page.
  if (needle && keep.size === 0 && !verifiedOnly && !status) {
    for (const node of nodes) {
      if (searchText(node).includes(needle)) keep.add(node.id);
    }
  }

  for (const edge of snapshot?.edges ?? []) {
    if (keep.has(edge.source) && edge.type !== 'depends_on') keep.add(edge.target);
  }

  return {
    generated: snapshot?.generated,
    nodes: nodes.filter((n) => keep.has(n.id)),
    edges: (snapshot?.edges ?? []).filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}

/** Count statements by effective status, for the toolbar's summary line. */
export function statusCounts(snapshot) {
  const counts = { verified: 0, proposed: 0, stale: 0, failed: 0 };
  for (const node of snapshot?.nodes ?? []) {
    if (node.kind !== 'statement') continue;
    const status = effectiveStatus(node);
    if (status in counts) counts[status] += 1;
  }
  return counts;
}

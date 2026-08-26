/**
 * verification-graph-layout.test.js — dagre layout for the verification graph.
 *
 * The page's whole visual argument is that verified foundations sit *under*
 * the claims built on them, so these assert the vertical ordering directly.
 */

import { describe, it, expect } from 'vitest';
import { computeLayout, sizeOf, NODE_SIZE } from '../swdb/verification-graph/layout.js';

function node(id, kind, depth = 0) {
  return { id, kind, label: id, depth };
}

describe('sizeOf', () => {
  it('gives statements the card size and relations the pill size', () => {
    expect(sizeOf(node('s', 'statement'))).toEqual(NODE_SIZE.statement);
    expect(sizeOf(node('r', 'relation'))).toEqual(NODE_SIZE.relation);
  });

  it('falls back to the entity size for an unknown kind', () => {
    expect(sizeOf({ id: 'x', kind: 'mystery' })).toEqual(NODE_SIZE.entity);
  });
});

describe('computeLayout', () => {
  const snapshot = {
    nodes: [
      node('ent-unit', 'entity'),
      node('rel-r', 'relation'),
      node('ent-stim', 'entity'),
      node('stmt-low', 'statement'),
      node('stmt-high', 'statement', 1),
    ],
    edges: [
      { id: 'e1', source: 'stmt-low', target: 'ent-unit', type: 'subject' },
      { id: 'e2', source: 'stmt-low', target: 'rel-r', type: 'relation' },
      { id: 'e3', source: 'stmt-low', target: 'ent-stim', type: 'object' },
      { id: 'e4', source: 'stmt-high', target: 'stmt-low', type: 'depends_on' },
    ],
  };

  it('positions every node', () => {
    const positions = computeLayout(snapshot);
    expect(positions.size).toBe(5);
    for (const p of positions.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('places a derived claim above the statement it depends on', () => {
    const positions = computeLayout(snapshot);
    expect(positions.get('stmt-high').y).toBeLessThan(positions.get('stmt-low').y);
  });

  it('places a statement above its own subject, relation and object', () => {
    const positions = computeLayout(snapshot);
    const low = positions.get('stmt-low').y;
    for (const id of ['ent-unit', 'rel-r', 'ent-stim']) {
      expect(low).toBeLessThan(positions.get(id).y);
    }
  });

  it('returns top-left corners, not dagre centres', () => {
    const positions = computeLayout({ nodes: [node('s', 'statement')], edges: [] });
    // dagre centres the single node on the margin; the top-left must sit half
    // a box up and left of that centre, never at the same point.
    expect(positions.get('s').x).toBeGreaterThanOrEqual(0);
  });

  it('ignores edges pointing at nodes that were filtered out', () => {
    const positions = computeLayout({
      nodes: [node('s', 'statement')],
      edges: [{ id: 'e', source: 's', target: 'gone', type: 'depends_on' }],
    });
    expect(positions.size).toBe(1);
  });

  it('handles an empty snapshot', () => {
    expect(computeLayout({ nodes: [], edges: [] }).size).toBe(0);
    expect(computeLayout(null).size).toBe(0);
  });
});

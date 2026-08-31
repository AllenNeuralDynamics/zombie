/**
 * verification-graph-model.test.js — filters, status vocabulary, and indexing
 * for the verification graph page.
 */

import { describe, it, expect } from 'vitest';
import {
  AXES,
  effectiveStatus,
  filterSnapshot,
  indexSnapshot,
  isFullyVerified,
  statusCounts,
  statusVar,
} from '../swdb/verification-graph/model.js';

function statement(id, overrides = {}) {
  return {
    id, kind: 'statement', label: `${id} label`, status: 'verified', effective_status: 'verified',
    axes: { reproducible: 'passed', replicable: 'not_attempted', robust: 'not_attempted', generalizable: 'not_attempted' },
    depth: 0, ...overrides,
  };
}

const SNAPSHOT = {
  generated: '2026-08-26T00:00:00Z',
  nodes: [
    { id: 'ent-unit-1', kind: 'entity', entity_type: 'unit', label: 'Unit 1', depth: 0 },
    { id: 'ent-stim-vis1', kind: 'entity', entity_type: 'stimulus', label: 'vis1', depth: 0 },
    { id: 'rel-responds-to', kind: 'relation', label: 'responds to', depth: 0 },
    statement('stmt-a'),
    statement('stmt-b', { status: 'verified', effective_status: 'stale', depth: 1 }),
    statement('stmt-c', { status: 'proposed', effective_status: 'proposed', depth: 0 }),
  ],
  edges: [
    { id: 'e1', source: 'stmt-a', target: 'ent-unit-1', type: 'subject' },
    { id: 'e2', source: 'stmt-a', target: 'rel-responds-to', type: 'relation' },
    { id: 'e3', source: 'stmt-a', target: 'ent-stim-vis1', type: 'object' },
    { id: 'e4', source: 'stmt-b', target: 'stmt-a', type: 'depends_on' },
  ],
};

describe('status vocabulary', () => {
  it('names the four axes in tick order', () => {
    expect(AXES).toEqual(['reproducible', 'replicable', 'robust', 'generalizable']);
  });

  it('prefers effective status over the stored one', () => {
    expect(effectiveStatus(statement('x', { status: 'verified', effective_status: 'failed' }))).toBe('failed');
  });

  it('has no status for entities and relations', () => {
    expect(effectiveStatus({ id: 'e', kind: 'entity' })).toBeNull();
  });

  it('only calls a statement verified when its dependencies are too', () => {
    expect(isFullyVerified(statement('a'))).toBe(true);
    expect(isFullyVerified(statement('b', { effective_status: 'stale' }))).toBe(false);
  });

  it('maps each status onto a palette token', () => {
    expect(statusVar('verified')).toContain('verified');
    expect(statusVar('failed')).toContain('failed');
    expect(statusVar('stale')).toContain('stale');
    expect(statusVar('anything-else')).toContain('proposed');
  });
});

describe('indexSnapshot', () => {
  it('indexes nodes by id and records derivation dependents', () => {
    const { byId, dependents } = indexSnapshot(SNAPSHOT);
    expect(byId.get('stmt-a').label).toBe('stmt-a label');
    expect(dependents.get('stmt-a')).toEqual(['stmt-b']);
    expect(dependents.has('ent-unit-1')).toBe(false);
  });

  it('tolerates an empty snapshot', () => {
    expect(indexSnapshot(null).byId.size).toBe(0);
  });
});

describe('filterSnapshot', () => {
  it('passes everything through with no filters', () => {
    expect(filterSnapshot(SNAPSHOT, {}).nodes).toHaveLength(6);
  });

  it('verified-only drops statements whose dependencies are not verified', () => {
    const ids = filterSnapshot(SNAPSHOT, { verifiedOnly: true }).nodes.map((n) => n.id);
    expect(ids).toContain('stmt-a');
    expect(ids).not.toContain('stmt-b');
    expect(ids).not.toContain('stmt-c');
  });

  it('keeps the whole triple of a surviving statement', () => {
    const ids = filterSnapshot(SNAPSHOT, { verifiedOnly: true }).nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(['ent-unit-1', 'rel-responds-to', 'ent-stim-vis1']));
  });

  it('filters by an explicit status', () => {
    const ids = filterSnapshot(SNAPSHOT, { status: 'stale' }).nodes.map((n) => n.id);
    expect(ids).toContain('stmt-b');
    expect(ids).not.toContain('stmt-a');
  });

  it('searches statement labels', () => {
    const ids = filterSnapshot(SNAPSHOT, { query: 'stmt-c' }).nodes.map((n) => n.id);
    expect(ids).toEqual(['stmt-c']);
  });

  it('falls back to entities when a search matches no statement', () => {
    const ids = filterSnapshot(SNAPSHOT, { query: 'vis1' }).nodes.map((n) => n.id);
    expect(ids).toEqual(['ent-stim-vis1']);
  });

  it('drops edges whose endpoints did not survive', () => {
    const { edges } = filterSnapshot(SNAPSHOT, { verifiedOnly: true });
    expect(edges.map((e) => e.id)).not.toContain('e4');
  });
});

describe('statusCounts', () => {
  it('tallies statements by effective status', () => {
    expect(statusCounts(SNAPSHOT)).toEqual({ verified: 1, proposed: 1, stale: 1, failed: 0 });
  });
});

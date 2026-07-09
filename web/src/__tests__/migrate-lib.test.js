/**
 * migrate-lib.test.js — Unit tests for pure helpers in migrate/lib.js.
 *
 * The Preact components themselves are not exercised (they require a DOM
 * runtime and a network); these tests cover the pure helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  buildMergedRecord,
  canonicalJson,
  deepEqual,
  diffJson,
  extractServicePayload,
  formatDiffValue,
  getAtPath,
  lookupIdForEndpoint,
  normalizeServiceSection,
  setAtPath,
  topLevelChangedSections,
} from '../migrate/lib.js';

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('serialises primitives like JSON.stringify', () => {
    expect(canonicalJson(1)).toBe('1');
    expect(canonicalJson('a')).toBe('"a"');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
  });

  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});

// ---------------------------------------------------------------------------
// deepEqual
// ---------------------------------------------------------------------------

describe('deepEqual', () => {
  it('treats key order as irrelevant', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it('returns false for differing values', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
  });
  it('handles null + undefined correctly', () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// extractServicePayload
// ---------------------------------------------------------------------------

describe('extractServicePayload', () => {
  it('unwraps v1 { message, data } envelope', () => {
    const resp = { message: 'Valid Model.', data: { subject_id: '1' } };
    expect(extractServicePayload(resp, 'v1')).toEqual({ subject_id: '1' });
  });

  it('throws on v1 envelope with null data', () => {
    expect(() => extractServicePayload({ message: 'No data found', data: null }, 'v1'))
      .toThrow(/No data found/);
  });

  it('returns v2 payload as-is', () => {
    const resp = { object_type: 'Subject', subject_id: '1' };
    expect(extractServicePayload(resp, 'v2')).toEqual(resp);
  });

  it('throws on v2 FastAPI-style error envelope', () => {
    expect(() => extractServicePayload({ detail: 'Not found' }, 'v2')).toThrow(/Not found/);
  });
});

// ---------------------------------------------------------------------------
// diffJson
// ---------------------------------------------------------------------------

describe('diffJson', () => {
  it('emits nothing for equal values', () => {
    expect(diffJson({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toEqual([]);
  });

  it('detects added keys', () => {
    const diff = diffJson({ a: 1 }, { a: 1, b: 2 });
    expect(diff).toEqual([{ path: 'b', kind: 'added', oldValue: undefined, newValue: 2 }]);
  });

  it('detects removed keys', () => {
    const diff = diffJson({ a: 1, b: 2 }, { a: 1 });
    expect(diff).toEqual([{ path: 'b', kind: 'removed', oldValue: 2, newValue: undefined }]);
  });

  it('detects changed leaves with dot-path', () => {
    const diff = diffJson({ a: { b: 1 } }, { a: { b: 2 } });
    expect(diff).toEqual([{ path: 'a.b', kind: 'changed', oldValue: 1, newValue: 2 }]);
  });

  it('recurses into same-length arrays with [i] paths', () => {
    const diff = diffJson({ xs: [{ v: 1 }, { v: 2 }] }, { xs: [{ v: 1 }, { v: 99 }] });
    expect(diff).toEqual([
      { path: 'xs.[1].v', kind: 'changed', oldValue: 2, newValue: 99 },
    ]);
  });

  it('treats arrays of different lengths as a single wholesale change', () => {
    const diff = diffJson({ xs: [1] }, { xs: [1, 2] });
    expect(diff).toEqual([{ path: 'xs', kind: 'changed', oldValue: [1], newValue: [1, 2] }]);
  });

  it('handles entirely missing top-level value', () => {
    const diff = diffJson(undefined, { a: 1 });
    expect(diff).toEqual([{ path: '(root)', kind: 'added', oldValue: undefined, newValue: { a: 1 } }]);
  });
});

// ---------------------------------------------------------------------------
// formatDiffValue
// ---------------------------------------------------------------------------

describe('formatDiffValue', () => {
  it('renders scalars verbatim', () => {
    expect(formatDiffValue(undefined)).toBe('—');
    expect(formatDiffValue(null)).toBe('null');
    expect(formatDiffValue('hello')).toBe('hello');
    expect(formatDiffValue(42)).toBe('42');
    expect(formatDiffValue(true)).toBe('true');
  });

  it('renders objects as pretty JSON', () => {
    expect(formatDiffValue({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

// ---------------------------------------------------------------------------
// buildMergedRecord
// ---------------------------------------------------------------------------

describe('buildMergedRecord', () => {
  it('replaces the named section, leaving other fields untouched', () => {
    const cur = { _id: 'x', name: 'a', subject: { old: true }, other: 1 };
    const merged = buildMergedRecord(cur, 'subject', { new: true });
    expect(merged).toEqual({ _id: 'x', name: 'a', subject: { new: true }, other: 1 });
    // Original record untouched.
    expect(cur.subject).toEqual({ old: true });
  });

  it('returns null when no current record is supplied', () => {
    expect(buildMergedRecord(null, 'subject', { x: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// topLevelChangedSections
// ---------------------------------------------------------------------------

describe('topLevelChangedSections', () => {
  it('returns empty for byte-equal records', () => {
    const a = { _id: 'x', subject: { id: '1' }, procedures: { list: [1, 2] } };
    const b = { _id: 'x', procedures: { list: [1, 2] }, subject: { id: '1' } };
    expect(topLevelChangedSections(a, b)).toEqual([]);
  });

  it('lists only the changed top-level fields, sorted', () => {
    const a = { _id: 'x', subject: { id: '1' }, procedures: { list: [1, 2] }, other: true };
    const b = { _id: 'x', subject: { id: '2' }, procedures: { list: [1, 2] }, other: false };
    expect(topLevelChangedSections(a, b)).toEqual(['other', 'subject']);
  });

  it('treats added and removed top-level keys as changes', () => {
    const a = { _id: 'x', subject: {} };
    const b = { _id: 'x', subject: {}, new_section: { foo: 1 } };
    expect(topLevelChangedSections(a, b)).toEqual(['new_section']);
  });

  it('returns empty when either side is missing', () => {
    expect(topLevelChangedSections(null, { a: 1 })).toEqual([]);
    expect(topLevelChangedSections({ a: 1 }, null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getAtPath / setAtPath
// ---------------------------------------------------------------------------

describe('getAtPath', () => {
  it('reads nested values', () => {
    expect(getAtPath({ a: { b: { c: 1 } } }, ['a', 'b', 'c'])).toBe(1);
  });
  it('returns undefined when a hop is missing', () => {
    expect(getAtPath({ a: {} }, ['a', 'b', 'c'])).toBeUndefined();
    expect(getAtPath(null, ['a'])).toBeUndefined();
  });
});

describe('setAtPath', () => {
  it('immutably sets a nested value, cloning each level', () => {
    const orig = { data_description: { project_name: 'P', funding_source: [{ old: true }] } };
    const next = setAtPath(orig, ['data_description', 'funding_source'], [{ new: true }]);
    expect(next.data_description.funding_source).toEqual([{ new: true }]);
    // siblings preserved, original untouched
    expect(next.data_description.project_name).toBe('P');
    expect(orig.data_description.funding_source).toEqual([{ old: true }]);
    expect(next).not.toBe(orig);
  });

  it('creates intermediate objects when absent', () => {
    expect(setAtPath({}, ['data_description', 'investigators'], [1]))
      .toEqual({ data_description: { investigators: [1] } });
  });
});

// ---------------------------------------------------------------------------
// lookupIdForEndpoint
// ---------------------------------------------------------------------------

describe('lookupIdForEndpoint', () => {
  const record = {
    subject: { subject_id: '12345' },
    data_description: { project_name: 'AIBS WB AAV Toolbox' },
  };
  it('uses subject.subject_id for subject/procedures', () => {
    expect(lookupIdForEndpoint(record, 'subject')).toBe('12345');
    expect(lookupIdForEndpoint(record, 'procedures')).toBe('12345');
  });
  it('uses data_description.project_name for funding/investigators', () => {
    expect(lookupIdForEndpoint(record, 'funding')).toBe('AIBS WB AAV Toolbox');
    expect(lookupIdForEndpoint(record, 'investigators')).toBe('AIBS WB AAV Toolbox');
  });
  it('returns null when the field is absent', () => {
    expect(lookupIdForEndpoint({}, 'funding')).toBeNull();
    expect(lookupIdForEndpoint({}, 'subject')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeServiceSection
// ---------------------------------------------------------------------------

describe('normalizeServiceSection', () => {
  it('returns subject/procedures payloads verbatim', () => {
    const p = { subject_id: '1' };
    expect(normalizeServiceSection('subject', 'v2', p)).toBe(p);
    expect(normalizeServiceSection('procedures', 'v1', p)).toBe(p);
  });

  it('uses the v2 funding list as funding_source', () => {
    const list = [{ object_type: 'Funding', grant_number: 'G1' }];
    expect(normalizeServiceSection('funding', 'v2', list)).toEqual(list);
  });

  it('wraps the v1 funding object into a list and strips its investigators key', () => {
    const v1 = { funder: { name: 'NIMH' }, grant_number: 'G1', fundee: 'A, B', investigators: 'X, Y' };
    expect(normalizeServiceSection('funding', 'v1', v1)).toEqual([
      { funder: { name: 'NIMH' }, grant_number: 'G1', fundee: 'A, B' },
    ]);
  });

  it('uses the v2 investigators list as-is', () => {
    const list = [{ object_type: 'Person', name: 'Avery Hunker' }];
    expect(normalizeServiceSection('investigators', 'v2', list)).toEqual(list);
  });

  it('derives v1 investigators from the funding response string', () => {
    const v1 = { grant_number: 'G1', investigators: 'Avery Hunker, Bosiljka Tasic' };
    expect(normalizeServiceSection('investigators', 'v1', v1)).toEqual([
      { name: 'Avery Hunker', abbreviation: null, registry: null, registry_identifier: null },
      { name: 'Bosiljka Tasic', abbreviation: null, registry: null, registry_identifier: null },
    ]);
  });

  it('returns an empty investigators list when v1 funding has no investigators string', () => {
    expect(normalizeServiceSection('investigators', 'v1', { grant_number: 'G1' })).toEqual([]);
  });
});

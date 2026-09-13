import { describe, expect, it, vi } from 'vitest';
import {
  accountDisplayName,
  buildQcSubmitPayload,
  buildReviewRows,
  clearQcPendingChanges,
  QC_PENDING_CHANGES_STORAGE_PREFIX,
  QC_VIEW_MODE_STORAGE_KEY,
  qcPendingChangesStorageKey,
  readQcPendingChanges,
  readQcViewMode,
  writeQcPendingChanges,
  writeQcViewMode,
} from '../qc/editor.js';
import { canonicalQcJson, hashQc } from '../qc/canonical.js';
import { QC_HASH_FIXTURES } from '../qc/canonical-fixtures.js';

function recordWith(metrics, notes = '') {
  return { _id: 'record-1', name: 'asset-1', quality_control: { metrics, notes, default_grouping: [] } };
}

function metric(name, value, status = 'Pending') {
  return {
    object_type: 'QC metric',
    name,
    value,
    status_history: [{ status, evaluator: 'system', timestamp: '2024-01-01T00:00:00Z' }],
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

describe('QC SPA edit helpers', () => {
  it('uses the account display name before username or opaque account ids', () => {
    expect(accountDisplayName({ name: 'Ada Lovelace', username: 'opaque-id', homeAccountId: 'another-id' })).toBe('Ada Lovelace');
    expect(accountDisplayName({ name: 'CKyRAoBpUygn1Sle6uNHscpYK8Mpor-i8LmjfJud5Jo', idTokenClaims: { name: 'Ada Lovelace' } })).toBe('Ada Lovelace');
    expect(accountDisplayName({ username: 'CKyRAoBpUygn1Sle6uNHscpYK8Mpor-i8LmjfJud5Jo' })).toBe('AIND account');
  });

  it('persists only valid view modes in local storage without URL state', () => {
    const storage = {
      getItem: vi.fn(() => 'table'),
      setItem: vi.fn(),
    };
    expect(readQcViewMode(storage)).toBe('table');
    writeQcViewMode('tree', storage);
    expect(storage.setItem).toHaveBeenCalledWith(QC_VIEW_MODE_STORAGE_KEY, 'tree');
    writeQcViewMode('invalid', storage);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('falls back to tree when view-mode storage is unavailable or invalid', () => {
    expect(readQcViewMode({ getItem: () => 'grid' })).toBe('tree');
    expect(readQcViewMode({ getItem: () => { throw new Error('blocked'); } })).toBe('tree');
    expect(() => writeQcViewMode('table', { setItem: () => { throw new Error('blocked'); } })).not.toThrow();
  });

  it('stores pending drafts under asset-specific keys and clears only the selected asset', () => {
    const storage = memoryStorage();
    const drafts = { valueDrafts: { metric: '1' }, statusDrafts: { metric: 'Fail' }, notes: 'draft' };

    writeQcPendingChanges('asset/one', drafts, storage);
    writeQcPendingChanges('asset/two', { notes: 'other' }, storage);

    expect(qcPendingChangesStorageKey('asset/one')).toBe(`${QC_PENDING_CHANGES_STORAGE_PREFIX}asset%2Fone`);
    expect(readQcPendingChanges('asset/one', storage)).toEqual(drafts);
    clearQcPendingChanges('asset/one', storage);
    expect(readQcPendingChanges('asset/one', storage)).toBeNull();
    expect(readQcPendingChanges('asset/two', storage)).toEqual({ notes: 'other' });
  });

  it('ignores malformed pending draft storage', () => {
    expect(readQcPendingChanges('asset', { getItem: () => '{bad json' })).toBeNull();
  });

  it('matches the frozen cross-language canonical fixtures', async () => {
    for (const fixture of QC_HASH_FIXTURES) {
      expect(canonicalQcJson(fixture.value)).toBe(canonicalQcJson(JSON.parse(JSON.stringify(fixture.value))));
      expect(await hashQc(fixture.value)).toBe(fixture.hash);
    }
  });

  it('builds only the narrow changed-field payload', () => {
    const payload = buildQcSubmitPayload(
      { _id: 'record-1' },
      {
        expectedQcHash: 'a'.repeat(64),
        pendingChanges: { metric: { value: 0.94, status: 'Pass' } },
        notesChanged: true,
        notes: '',
      },
    );
    expect(payload).toEqual({
      record_id: 'record-1',
      expected_qc_hash: 'a'.repeat(64),
      changes: [{ metric_name: 'metric', value: 0.94, status: 'Pass' }],
      notes: '',
    });
    expect(payload.evaluator).toBeUndefined();
  });
});

describe('review diff against the freshly-pulled record', () => {
  it('shows current values from the fresh record, not the loaded one', () => {
    const loaded = recordWith([metric('drift', 0.5)]);
    const fresh = recordWith([metric('drift', 0.77)]);
    const [row] = buildReviewRows(fresh, loaded, { pendingChanges: { drift: { value: 0.94 } } });
    expect(row.currentValue).toBe('0.77');
    expect(row.nextValue).toBe('0.94');
  });

  it.each([
    ['dropdown', 'good', 'bad'],
    ['checkbox', ['good'], ['bad']],
  ])('only shows the value field for a changed %s metric', (type, current, next) => {
    const loadedValue = { type, options: ['good', 'bad'], value: current, status: ['Pass', 'Fail'] };
    const nextValue = { ...loadedValue, value: next };
    const loaded = recordWith([metric('quality', loadedValue)]);
    const fresh = recordWith([metric('quality', loadedValue)]);
    const [row] = buildReviewRows(fresh, loaded, { pendingChanges: { quality: { value: nextValue } } });

    expect(row.currentValue).toBe(`${JSON.stringify({ value: current })} …`);
    expect(row.nextValue).toBe(`${JSON.stringify({ value: next })} …`);
    expect(row.currentValue).not.toContain('options');
    expect(row.nextValue).not.toContain('status');
  });

  it('only shows changed fields for an ordinary dictionary value', () => {
    const loadedValue = { quality: 'good', count: 3, source: 'pipeline' };
    const nextValue = { ...loadedValue, quality: 'bad' };
    const loaded = recordWith([metric('quality', loadedValue)]);
    const fresh = recordWith([metric('quality', loadedValue)]);
    const [row] = buildReviewRows(fresh, loaded, { pendingChanges: { quality: { value: nextValue } } });

    expect(row.currentValue).toBe('{"quality":"good"} …');
    expect(row.nextValue).toBe('{"quality":"bad"} …');
    expect(row.currentValue).not.toContain('count');
    expect(row.nextValue).not.toContain('source');
  });

  it('flags a metric whose value moved underneath the edit', () => {
    const loaded = recordWith([metric('drift', 0.5)]);
    const fresh = recordWith([metric('drift', 0.77)]);
    const [row] = buildReviewRows(fresh, loaded, { pendingChanges: { drift: { value: 0.94 } } });
    expect(row.drifted).toBe(true);
  });

  it('does not flag drift when the record is unchanged', () => {
    const loaded = recordWith([metric('drift', 0.5)]);
    const fresh = recordWith([metric('drift', 0.5)]);
    const [row] = buildReviewRows(fresh, loaded, { pendingChanges: { drift: { value: 0.94 } } });
    expect(row.drifted).toBe(false);
  });

  it('flags a status that moved underneath the edit', () => {
    const loaded = recordWith([metric('drift', 0.5, 'Pending')]);
    const fresh = recordWith([metric('drift', 0.5, 'Fail')]);
    const [row] = buildReviewRows(fresh, loaded, { pendingChanges: { drift: { status: 'Pass' } } });
    expect(row.currentStatus).toBe('Fail');
    expect(row.nextStatus).toBe('Pass');
    expect(row.drifted).toBe(true);
  });

  it('marks a metric that disappeared from the fresh record', () => {
    const loaded = recordWith([metric('drift', 0.5)]);
    const fresh = recordWith([]);
    const [row] = buildReviewRows(fresh, loaded, { pendingChanges: { drift: { value: 0.94 } } });
    expect(row.missing).toBe(true);
    expect(row.drifted).toBe(true);
  });

  it('includes a notes row and flags notes changed elsewhere', () => {
    const loaded = recordWith([], 'original');
    const fresh = recordWith([], 'someone else edited');
    const rows = buildReviewRows(fresh, loaded, { notesChanged: true, notes: 'mine' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      isNotes: true,
      currentValue: 'someone else edited',
      nextValue: 'mine',
      drifted: true,
    });
  });

  it('omits the notes row when notes are unchanged', () => {
    const loaded = recordWith([metric('drift', 0.5)], 'same');
    const fresh = recordWith([metric('drift', 0.5)], 'same');
    const rows = buildReviewRows(fresh, loaded, { pendingChanges: { drift: { value: 1 } } });
    expect(rows.some(row => row.isNotes)).toBe(false);
  });
});

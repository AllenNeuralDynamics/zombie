import { describe, expect, it } from 'vitest';
import { buildQcSubmitPayload, buildReviewRows } from '../qc/editor.js';
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

describe('QC SPA edit helpers', () => {
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


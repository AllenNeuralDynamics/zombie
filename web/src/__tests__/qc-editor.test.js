import { describe, expect, it } from 'vitest';
import { buildQcSubmitPayload } from '../qc/editor.js';
import { canonicalQcJson, hashQc } from '../qc/canonical.js';
import { QC_HASH_FIXTURES } from '../qc/canonical-fixtures.js';

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


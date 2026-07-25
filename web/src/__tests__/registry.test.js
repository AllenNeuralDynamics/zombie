import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureTable, normalizeRegistrationOptions, releaseTable, setMetadata } from '../lib/registry.js';

const ACORN = {
  name: 'source_data',
  location: 's3://bucket/source_data/',
  partitioned: true,
  partition_key: 'subject_id',
  type: 'asset',
  columns: ['subject_id'],
};

function coordinator() {
  return { exec: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => setMetadata({ acorns: [ACORN] }));

describe('normalizeRegistrationOptions', () => {
  it('normalizes equivalent filters to one key and physical name', () => {
    const first = normalizeRegistrationOptions('source_data', { subjectIds: [456, '123', '123'] });
    const second = normalizeRegistrationOptions('source_data', { subjectIds: ['123', '456'] });
    expect(first).toEqual(second);
    expect(first.subjectIds).toEqual(['123', '456']);
    expect(first.physicalName).toMatch(/^source_data__scope_[0-9a-f]{16}$/);
  });

  it('distinguishes an absent filter from an empty filter', () => {
    expect(normalizeRegistrationOptions('source_data').physicalName).toBe('source_data');
    expect(normalizeRegistrationOptions('source_data', { subjectIds: [] }).physicalName)
      .not.toBe('source_data');
  });
});

describe('ensureTable', () => {
  it('caches unfiltered registration and resolves to the canonical name', async () => {
    const coord = coordinator();
    const first = ensureTable(coord, 'source_data');
    const second = ensureTable(coord, 'source_data');
    await expect(first).resolves.toBe('source_data');
    await expect(second).resolves.toBe('source_data');
    expect(coord.exec).toHaveBeenCalledTimes(1);
  });

  it('isolates concurrent filtered registrations from each other and the canonical table', async () => {
    const coord = coordinator();
    const [unfiltered, first, equivalent, second] = await Promise.all([
      ensureTable(coord, 'source_data'),
      ensureTable(coord, 'source_data', { subjectIds: ['2', '1'] }),
      ensureTable(coord, 'source_data', { subjectIds: ['1', '2'] }),
      ensureTable(coord, 'source_data', { subjectIds: ['3'] }),
    ]);
    expect(unfiltered).toBe('source_data');
    expect(first).toBe(equivalent);
    expect(second).not.toBe(first);
    expect(coord.exec).toHaveBeenCalledTimes(3);
    expect(coord.exec.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('TABLE "source_data"'),
      expect.stringContaining(`TABLE "${first}"`),
      expect.stringContaining(`TABLE "${second}"`),
    ]));
  });

  it('removes only a failed registration so it can be retried', async () => {
    const coord = coordinator();
    coord.exec.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(undefined);
    await expect(ensureTable(coord, 'source_data', { subjectIds: ['1'] })).rejects.toThrow('temporary');
    await expect(ensureTable(coord, 'source_data', { subjectIds: ['1'] })).resolves.toMatch(/__scope_/);
    expect(coord.exec).toHaveBeenCalledTimes(2);
  });

  it('registers an empty filter as a scoped table with no rows', async () => {
    const coord = coordinator();
    const tableName = await ensureTable(coord, 'source_data', { subjectIds: [] });
    expect(tableName).toMatch(/__scope_/);
    expect(coord.exec).toHaveBeenCalledWith(expect.stringContaining('WHERE FALSE'));
  });
});

describe('releaseTable', () => {
  it('drops a scoped table but never the canonical table', async () => {
    const coord = coordinator();
    const tableName = await ensureTable(coord, 'source_data', { subjectIds: ['1'] });
    await expect(releaseTable(coord, 'source_data', { subjectIds: ['1'] })).resolves.toBe(true);
    expect(coord.exec).toHaveBeenLastCalledWith(`DROP TABLE IF EXISTS "${tableName}"`);
    await expect(releaseTable(coord, 'source_data')).resolves.toBe(false);
  });
});
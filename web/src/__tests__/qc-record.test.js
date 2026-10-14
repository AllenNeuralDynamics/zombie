import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../lib/docdb.js', () => ({ queryDocDb: vi.fn() }));
import { queryDocDb } from '../lib/docdb.js';
import { fetchQcRecord } from '../qc/record.js';

beforeEach(() => vi.resetAllMocks());

it('keeps real DocDB records authoritative and skips the temporary API', async () => {
  const record = { name: 'real' };
  queryDocDb.mockResolvedValue([record]);
  const fetchImpl = vi.fn();
  expect(await fetchQcRecord('real', { fetchImpl })).toEqual({ record, temporary: false });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('loads a temporary record only after an empty DocDB result', async () => {
  queryDocDb.mockResolvedValue([]);
  const record = { name: 'test & preview', quality_control: { metrics: [] } };
  const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ name: record.name, temporary: true, metadata: record }) }));
  expect(await fetchQcRecord(record.name, { fetchImpl })).toEqual({ record, temporary: true });
  expect(fetchImpl).toHaveBeenCalledWith('/metadata-viz/temporary-metadata?name=test+%26+preview', { cache: 'no-store' });
});

it('does not hide DocDB outages behind temporary metadata', async () => {
  queryDocDb.mockRejectedValue(new Error('DocDB unavailable'));
  const fetchImpl = vi.fn();
  await expect(fetchQcRecord('test', { fetchImpl })).rejects.toThrow('DocDB unavailable');
  expect(fetchImpl).not.toHaveBeenCalled();
});

it.each([404, 503])('reports temporary lookup failure (%s)', async status => {
  queryDocDb.mockResolvedValue([]);
  await expect(fetchQcRecord('test', { fetchImpl: async () => ({ status, ok: false }) })).rejects.toThrow(
    status === 404 ? 'not found' : 'lookup failed (503)',
  );
});

it('rejects mismatched temporary records', async () => {
  queryDocDb.mockResolvedValue([]);
  await expect(fetchQcRecord('test', { fetchImpl: async () => ({ ok: true,
    json: async () => ({ name: 'other', temporary: true, metadata: { name: 'other' } }),
  }) })).rejects.toThrow('Invalid temporary metadata response');
});

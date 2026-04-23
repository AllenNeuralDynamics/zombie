/**
 * docdb.test.js — Unit tests for pure helpers in docdb.js.
 *
 * Network-dependent functions (queryDocDb, fetchDocDbRecordsByName) are
 * tested via mock fetch; buildDocDbUrl is pure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDocDbUrl, queryDocDb, fetchDocDbRecordsByName, DOCDB_BASE_URL } from '../lib/docdb.js';

// ---------------------------------------------------------------------------
// buildDocDbUrl
// ---------------------------------------------------------------------------

describe('buildDocDbUrl', () => {
  it('appends /metadata/search to the base URL', () => {
    expect(buildDocDbUrl('https://api.example.com/v2')).toBe(
      'https://api.example.com/v2/metadata/search',
    );
  });

  it('works with the default DOCDB_BASE_URL', () => {
    const url = buildDocDbUrl(DOCDB_BASE_URL);
    expect(url).toContain('/docdb');
    expect(url).toContain('/metadata/search');
  });
});

// ---------------------------------------------------------------------------
// queryDocDb
// ---------------------------------------------------------------------------

describe('queryDocDb', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns array directly when API returns an array', async () => {
    const records = [{ name: 'asset-a' }, { name: 'asset-b' }];
    fetch.mockResolvedValueOnce({ ok: true, json: async () => records });

    const result = await queryDocDb({ name: 'asset-a' }, { baseUrl: 'http://test' });
    expect(result).toEqual(records);
  });

  it('unwraps { results: [...] } envelope', async () => {
    const records = [{ name: 'asset-a' }];
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ results: records }) });

    const result = await queryDocDb({ name: 'asset-a' }, { baseUrl: 'http://test' });
    expect(result).toEqual(records);
  });

  it('returns [] when response body is an empty object', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    const result = await queryDocDb({}, { baseUrl: 'http://test' });
    expect(result).toEqual([]);
  });

  it('throws on non-ok response', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error', text: async () => 'oops' });
    await expect(queryDocDb({}, { baseUrl: 'http://test' })).rejects.toThrow('500');
  });

  it('sends filter and limit in POST body', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => [] });

    await queryDocDb({ name: 'x' }, { baseUrl: 'http://test', limit: 42 });

    const [, init] = fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.filter).toEqual({ name: 'x' });
    expect(body.limit).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// fetchDocDbRecordsByName
// ---------------------------------------------------------------------------

describe('fetchDocDbRecordsByName', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns [] for empty input', async () => {
    const result = await fetchDocDbRecordsByName([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('returns [] for null/undefined input', async () => {
    expect(await fetchDocDbRecordsByName(null)).toEqual([]);
    expect(await fetchDocDbRecordsByName(undefined)).toEqual([]);
  });

  it('merges results from multiple names', async () => {
    const aRec = [{ name: 'a' }];
    const bRec = [{ name: 'b' }, { name: 'b2' }];
    fetch
      .mockResolvedValueOnce({ ok: true, json: async () => aRec })
      .mockResolvedValueOnce({ ok: true, json: async () => bRec });

    const result = await fetchDocDbRecordsByName(['a', 'b'], { baseUrl: 'http://test' });
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.name)).toEqual(['a', 'b', 'b2']);
  });
});

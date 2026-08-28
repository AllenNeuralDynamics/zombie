/**
 * verification-graph-api.test.js — the verification-graph REST client.
 */

import { describe, it, expect, vi } from 'vitest';
import { createVerificationApi, VerificationApiError } from '../swdb/verification-graph/api.js';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, statusText: 'x', json: async () => body, text: async () => JSON.stringify(body) };
}

function apiWith(fetchImpl) {
  return createVerificationApi({ baseUrl: 'http://portal', fetchImpl });
}

describe('createVerificationApi', () => {
  it('fetches the graph and forwards filters as query params', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nodes: [], edges: [] }));
    await apiWith(fetchImpl).graph({ status: 'verified', root: 'stmt-a' });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://portal/verification/graph?status=verified&root=stmt-a');
  });

  it('omits the query string when no filters are given', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await apiWith(fetchImpl).graph();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://portal/verification/graph');
  });

  it('reads anonymously, because the portal CORS is a wildcard', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await apiWith(fetchImpl).node('stmt-a');
    expect(fetchImpl.mock.calls[0][1].credentials).toBe('omit');
  });

  it('sends credentials on writes so the ORCID session cookie rides along', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await apiWith(fetchImpl).approve('stmt-a');
    expect(fetchImpl.mock.calls[0][1].credentials).toBe('include');
  });

  it('encodes node ids into the path', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await apiWith(fetchImpl).runs('stmt/a b');
    expect(fetchImpl.mock.calls[0][0]).toBe('http://portal/verification/nodes/stmt%2Fa%20b/runs');
  });

  it('returns code files as raw text', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'def main():\n    pass\n' }));
    const source = await apiWith(fetchImpl).codeFile('stmt-a', 'analysis.py');
    expect(source).toContain('def main');
    expect(fetchImpl.mock.calls[0][0]).toContain('code?path=analysis.py');
  });

  it('posts a verify request with the axis in the body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ job_id: 'verify-1' }));
    const job = await apiWith(fetchImpl).verify('stmt-a', 'reproducible');
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ axis: 'reproducible' });
    expect(job.job_id).toBe('verify-1');
  });

  it('raises the server error message with its status', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'no node' }, { ok: false, status: 404 }));
    await expect(apiWith(fetchImpl).node('nope')).rejects.toMatchObject({
      message: 'no node',
      status: 404,
    });
  });

  it('reports transport failures as status 0', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); });
    const error = await apiWith(fetchImpl).graph().catch((e) => e);
    expect(error).toBeInstanceOf(VerificationApiError);
    expect(error.status).toBe(0);
  });

  it('lists jobs anonymously with no filters by default', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    await apiWith(fetchImpl).jobs();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://portal/verification/jobs');
    expect(options.credentials).toBe('omit');
  });

  it('forwards the jobs state and limit filters as query params', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    await apiWith(fetchImpl).jobs({ state: 'running', limit: 50 });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://portal/verification/jobs?state=running&limit=50');
  });

  it('posts a batch verify with explicit node ids', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ queued: [], skipped: [] }));
    await apiWith(fetchImpl).verifyBatch({ nodeIds: ['stmt-a', 'stmt-b'] });
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(JSON.parse(options.body)).toEqual({ axis: 'reproducible', node_ids: ['stmt-a', 'stmt-b'] });
  });

  it('posts a batch verify targeting every eligible node by status, when node ids are omitted', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ queued: [], skipped: [] }));
    await apiWith(fetchImpl).verifyBatch({ status: 'proposed', axis: 'reproducible' });
    const [, options] = fetchImpl.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ axis: 'reproducible', status: 'proposed' });
  });
});

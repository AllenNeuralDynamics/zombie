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

  it('posts an agent job request', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ job_id: 'agent-1' }));
    await apiWith(fetchImpl).createAgentJob('Verify that 30% of CA3 units respond to vis1');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).request).toContain('CA3');
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
});

describe('live session control', () => {
  it('posts a cancel for a running job', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ cancelled: true, signalled: true }));
    const result = await apiWith(fetchImpl).cancelJob('agent-1');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://portal/verification/jobs/agent-1/cancel');
    expect(options.method).toBe('POST');
    expect(options.credentials).toBe('include');
    expect(result.signalled).toBe(true);
  });

  it('posts a steering message in the body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ queued: true }));
    await apiWith(fetchImpl).steerJob('agent-1', 'focus on CA3');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://portal/verification/jobs/agent-1/steer');
    expect(JSON.parse(options.body)).toEqual({ message: 'focus on CA3' });
  });

  it('surfaces a 409 when the job is no longer running', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'not running' }, { ok: false, status: 409 }));
    await expect(apiWith(fetchImpl).steerJob('agent-1', 'x')).rejects.toMatchObject({ status: 409 });
  });
});

describe('job listing', () => {
  it('asks only for the caller\'s active agent jobs', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    await apiWith(fetchImpl).jobs({ kind: 'agent', active: true });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://portal/verification/jobs?kind=agent&active=true');
  });

  it('omits absent filters from the query string', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    await apiWith(fetchImpl).jobs();
    expect(fetchImpl.mock.calls[0][0]).toBe('http://portal/verification/jobs');
  });

  it('sends credentials so the session cookie scopes the list', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    await apiWith(fetchImpl).jobs({ kind: 'agent' });
    expect(fetchImpl.mock.calls[0][1].credentials).toBe('include');
  });

  it('returns the job records', async () => {
    const records = [{ job_id: 'agent-1', state: 'running' }];
    const fetchImpl = vi.fn(async () => jsonResponse(records));
    await expect(apiWith(fetchImpl).jobs({ active: true })).resolves.toEqual(records);
  });
});

describe('credential scoping', () => {
  it('still omits credentials on anonymous reads', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ nodes: [], edges: [] }));
    const api = apiWith(fetchImpl);
    await api.graph();
    await api.job('agent-1');
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].credentials).toBe('omit');
    }
  });

  it('sends credentials on every write', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const api = apiWith(fetchImpl);
    await api.cancelJob('agent-1');
    await api.steerJob('agent-1', 'x');
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].credentials).toBe('include');
    }
  });
});

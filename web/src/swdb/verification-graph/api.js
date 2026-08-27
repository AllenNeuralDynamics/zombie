/**
 * verification-graph/api.js — client for the verification-graph REST API.
 *
 * Reads (`graph`, `node`, `code`, `runs`) are anonymous and deliberately send
 * no credentials: the portal's CORS is a wildcard, and a browser refuses a
 * wildcard `Access-Control-Allow-Origin` on a credentialed request, so asking
 * for the cookie would break cross-origin reads for no benefit.
 *
 * Writes, and the one authenticated read (`jobs`, which is scoped to the
 * logged-in user), carry the ORCID session cookie via `credentials: 'include'`.
 * That only works same-origin — in production that is the `/metadata-viz` nginx
 * proxy, in dev the portal host directly (where they will fail CORS unless
 * the page is served from an `*.allenneuraldynamics.org` host).
 *
 * `fetchImpl` is injectable so the tests never touch the network.
 */

import { VERIFICATION_API_BASE } from '../../constants.js';

const REQUEST_TIMEOUT_MS = 15_000;

/** An error carrying the HTTP status and the server's `{error}` message. */
export class VerificationApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status - HTTP status, or 0 for a transport failure.
   */
  constructor(message, status) {
    super(message);
    this.name = 'VerificationApiError';
    this.status = status;
  }
}

/**
 * Build an API client bound to a base URL and a fetch implementation.
 *
 * @param {{ baseUrl?: string, fetchImpl?: typeof fetch }} [options]
 */
export function createVerificationApi({ baseUrl = VERIFICATION_API_BASE, fetchImpl = null } = {}) {
  const doFetch = fetchImpl ?? ((...args) => fetch(...args));

  async function request(path, { method = 'GET', body, raw = false, signal, authed = false } = {}) {
    // Writes always need the session cookie, and so does an authenticated
    // read; anonymous reads must omit it or wildcard CORS rejects them. See
    // the module comment.
    const credentials = authed || method !== 'GET' ? 'include' : 'omit';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    let response;
    try {
      response = await doFetch(`${baseUrl}/verification${path}`, {
        method,
        credentials,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new VerificationApiError(
        controller.signal.aborted ? 'The verification service did not respond in time.' : String(error?.message ?? error),
        0,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (raw) {
      const text = await response.text();
      if (!response.ok) throw new VerificationApiError(text || response.statusText, response.status);
      return text;
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (_) {
      payload = null;
    }
    if (!response.ok) {
      throw new VerificationApiError(payload?.error ?? payload?.detail ?? response.statusText, response.status);
    }
    return payload;
  }

  return {
    /** Fetch the compiled graph snapshot, optionally filtered. */
    graph({ status, root, signal } = {}) {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (root) params.set('root', root);
      const query = params.toString();
      return request(`/graph${query ? `?${query}` : ''}`, { signal });
    },

    /** Fetch one node's full document. */
    node(nodeId, { signal } = {}) {
      return request(`/nodes/${encodeURIComponent(nodeId)}`, { signal });
    },

    /** Fetch a node's code file listing plus its layout gate results. */
    codeListing(nodeId, { signal } = {}) {
      return request(`/nodes/${encodeURIComponent(nodeId)}/code`, { signal });
    },

    /** Fetch one file from a node's code sidecar as plain text. */
    codeFile(nodeId, path, { signal } = {}) {
      return request(
        `/nodes/${encodeURIComponent(nodeId)}/code?path=${encodeURIComponent(path)}`,
        { raw: true, signal },
      );
    },

    /** Fetch a node's verification run history, newest first. */
    runs(nodeId, { signal } = {}) {
      return request(`/nodes/${encodeURIComponent(nodeId)}/runs`, { signal });
    },

    /** Queue a verification run for one axis of a node. */
    verify(nodeId, axis) {
      return request(`/nodes/${encodeURIComponent(nodeId)}/verify`, { method: 'POST', body: { axis } });
    },

    /** Promote a node out of `proposed` (admin only). */
    approve(nodeId) {
      return request(`/nodes/${encodeURIComponent(nodeId)}/approve`, { method: 'POST' });
    },

    /** Ask the authoring agent for a new claim. */
    createAgentJob(text) {
      return request('/agent/jobs', { method: 'POST', body: { request: text, root_node: null } });
    },

    /** Poll one job's status. */
    job(jobId, { signal } = {}) {
      return request(`/jobs/${encodeURIComponent(jobId)}`, { signal });
    },

    /** List the caller's jobs. `active` keeps only ones still queued or running. */
    jobs({ kind, active, signal } = {}) {
      const params = new URLSearchParams();
      if (kind) params.set('kind', kind);
      if (active) params.set('active', 'true');
      const query = params.toString();
      return request(`/jobs${query ? `?${query}` : ''}`, { signal, authed: true });
    },

    /** Stop a running agent session. Work already in its outbox is still kept. */
    cancelJob(jobId) {
      return request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    },

    /** Send a live instruction to a running session; applied at its next turn. */
    steerJob(jobId, message) {
      return request(`/jobs/${encodeURIComponent(jobId)}/steer`, { method: 'POST', body: { message } });
    },
  };
}

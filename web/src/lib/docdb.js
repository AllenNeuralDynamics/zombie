/**
 * docdb.js — Shared helper for querying the AIND DocDB REST API.
 *
 * The DocDB API (https://api.allenneuraldynamics.org/v2/) supports CORS for
 * browser clients.  All requests are POST to /metadata/search with a MongoDB-
 * style filter object.
 *
 * If the deployment adds an nginx `/api/` proxy, set DOCDB_BASE_URL to '/api/v2'
 * (see deploy/nginx.conf comments).
 *
 * Pure helpers (buildDocDbUrl) are exported for unit-testing without network I/O.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Base URL for the DocDB proxy.
 * Requests go through the Vite dev proxy (local) or nginx (production)
 * to the local Python docdb_proxy.py server, which forwards them to the
 * internal-network AIND API via aind_data_access_api.
 */
export const DOCDB_BASE_URL = '/docdb';

/** Default maximum number of records to return per query. */
export const DOCDB_DEFAULT_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build the search endpoint URL.
 *
 * @param {string} base - Base URL, e.g. DOCDB_BASE_URL.
 * @returns {string}
 */
export function buildDocDbUrl(base) {
  return `${base}/metadata/search`;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Query the DocDB search endpoint.
 *
 * @param {Record<string, unknown>} filterQuery - MongoDB-style filter object,
 *   e.g. `{ name: 'my-asset' }`.
 * @param {object} [options]
 * @param {string}  [options.baseUrl=DOCDB_BASE_URL]
 * @param {number}  [options.limit=DOCDB_DEFAULT_LIMIT]
 * @param {Record<string, 0|1>} [options.projection] - Optional MongoDB-style
 *   projection, e.g. `{ _id: 1, name: 1 }`. When omitted, the full record is
 *   returned.
 * @param {AbortSignal} [options.signal] - Optional AbortSignal for cancellation.
 * @returns {Promise<Array<Record<string, unknown>>>} - Resolved array of matching records.
 */
export async function queryDocDb(filterQuery, options = {}) {
  const {
    baseUrl = DOCDB_BASE_URL,
    limit = DOCDB_DEFAULT_LIMIT,
    projection,
    signal,
  } = options;

  const url = buildDocDbUrl(baseUrl);

  const body = { filter: filterQuery, limit };
  if (projection) body.projection = projection;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DocDB request failed: ${resp.status} ${resp.statusText}${text ? ` — ${text}` : ''}`);
  }

  const data = await resp.json();

  // The API may return an array directly or wrap it in { results: [...] }.
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

/**
 * Fetch all records whose `name` field matches one of the given asset names.
 * Makes one request per name to avoid large OR queries.
 *
 * @param {string[]} assetNames
 * @param {object} [options] - Forwarded to queryDocDb.
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function fetchDocDbRecordsByName(assetNames, options = {}) {
  if (!assetNames || assetNames.length === 0) return [];

  const results = await Promise.all(
    assetNames.map((name) => queryDocDb({ name }, options)),
  );

  return results.flat();
}

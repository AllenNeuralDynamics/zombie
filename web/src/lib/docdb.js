/**
 * docdb.js — Shared helper for querying the AIND DocDB REST API.
 *
 * The DocDB API (https://api.allenneuraldynamics.org) returns
 * access-control-allow-origin: * so requests can be made directly from the
 * browser without any proxy.  All requests are GET to
 * /v2/metadata_index/data_assets/find with a MongoDB-style filter serialised
 * as a JSON query-string parameter.
 *
 * Pure helpers (buildDocDbUrl) are exported for unit-testing without network I/O.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DOCDB_BASE_URL = 'https://api.allenneuraldynamics.org/v2/metadata_index/data_assets';

/** Default maximum number of records to return per query. */
export const DOCDB_DEFAULT_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Build the find endpoint URL.
 *
 * @param {string} base - Base URL, e.g. DOCDB_BASE_URL.
 * @returns {string}
 */
export function buildDocDbUrl(base) {
  return `${base}/find`;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Query the DocDB find endpoint.
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

  const params = new URLSearchParams({
    filter: JSON.stringify(filterQuery),
    limit: String(limit),
  });
  if (projection) params.set('projection', JSON.stringify(projection));

  const url = `${buildDocDbUrl(baseUrl)}?${params}`;

  const resp = await fetch(url, { signal });

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

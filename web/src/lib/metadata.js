/**
 * metadata.js — Fetch, parse, and register cache_registry.json dataset definitions.
 *
 * Pure helper functions are exported individually so they can be unit-tested
 * without a live DuckDB-WASM instance.  Functions that touch the Mosaic
 * coordinator are grouped at the bottom under "# DB Operations".
 */

import { S3_REGION, S3_BUCKET, DATA_CACHE_PREFIX } from '../constants.js';

// ---------------------------------------------------------------------------
// # Schema validation helpers
// ---------------------------------------------------------------------------

/** Minimum fields every acorn entry must carry. */
const REQUIRED_ACORN_FIELDS = ['name', 'location', 'type', 'columns'];

/**
 * Validate one acorn entry.
 *
 * @param {unknown} acorn - Candidate object from the JSON.
 * @param {number}  index - Position in the acorns array (for error messages).
 * @throws {Error} if any required field is missing or has the wrong type.
 */
export function validateAcorn(acorn, index = -1) {
  const label = index >= 0 ? `acorns[${index}]` : 'acorn';
  if (acorn === null || typeof acorn !== 'object') {
    throw new Error(`${label} must be an object, got ${typeof acorn}`);
  }
  for (const field of REQUIRED_ACORN_FIELDS) {
    if (!(field in acorn)) {
      throw new Error(`${label} is missing required field "${field}"`);
    }
  }
  if (!Array.isArray(acorn.columns)) {
    throw new Error(`${label}.columns must be an array`);
  }
}

// ---------------------------------------------------------------------------
// # Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse and validate the raw cache registry JSON object.
 *
 * @param {unknown} json - Parsed JSON value (not a string).
 * @returns {{ acorns: object[] }} Validated metadata object.
 * @throws {Error} on structural problems.
 */
export function parseCacheRegistryJson(json) {
  if (json === null || typeof json !== 'object') {
    throw new Error('cache_registry.json must be a JSON object');
  }
  if (!('tables' in json) || !Array.isArray(json.tables)) {
    throw new Error('cache_registry.json must have a "tables" array');
  }
  json.tables.forEach((acorn, i) => validateAcorn(acorn, i));
  // Alias tables → acorns so all internal consumers remain unchanged.
  json.acorns = json.tables;
  return json;
}

/**
 * Convert an `s3://bucket/key` path to a publicly accessible HTTPS URL.
 *
 * Uses the virtual-hosted-style URL:
 *   https://<bucket>.s3.<region>.amazonaws.com/<key>
 *
 * @param {string} s3Path - e.g. "s3://my-bucket/path/to/file.pqt"
 * @param {string} [region=S3_REGION] - AWS region string.
 * @returns {string} HTTPS URL.
 * @throws {Error} if the path is not a valid s3:// URI.
 */
export function s3PathToHttps(s3Path, region = S3_REGION) {
  if (typeof s3Path !== 'string') {
    throw new TypeError(`s3Path must be a string, got ${typeof s3Path}`);
  }
  const match = s3Path.match(/^s3:\/\/([^/]+)\/?(.*)/);
  if (!match) {
    throw new Error(`Invalid S3 path: "${s3Path}"`);
  }
  const [, bucket, key] = match;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Build the DuckDB `read_parquet(...)` argument string for an acorn.
 *
 * Converts `s3://bucket/key` → `https://bucket.s3.us-west-2.amazonaws.com/key`
 * so DuckDB-WASM can read the file over plain HTTPS without needing AWS
 * credentials or S3-protocol config. The bucket is public with CORS enabled.
 *
 * - Non-partitioned: single HTTPS URL.
 * - Partitioned directory: glob HTTPS URL with `hive_partitioning=true, union_by_name=true`.
 *
 * @param {object} acorn - A validated acorn entry.
 * @returns {string} The argument string to place inside `read_parquet(...)`.
 */
export function buildParquetArg(acorn) {
  if (acorn.partitioned) {
    const base = s3PathToHttps(acorn.location.replace(/\/+$/, ''));
    return `'${base}/**', hive_partitioning=true, union_by_name=true`;
  }
  return `'${s3PathToHttps(acorn.location)}'`;
}

/**
 * Column-level type casts applied when registering specific acorn tables.
 *
 * biodata-cache currently writes some columns with incorrect types (e.g.
 * acquisition timestamps stored as VARCHAR instead of TIMESTAMPTZ). These
 * overrides fix them at ingest time via DuckDB's `SELECT * REPLACE(...)` so
 * the rest of the app always sees proper typed columns.
 *
 * Remove entries here once the upstream parquet files are fixed.
 *
 * @type {Record<string, Record<string, string>>}
 */
export const ACORN_COLUMN_CASTS = {
  asset_basics: {
    // Stored as ISO-8601 VARCHAR with offset (e.g. "2024-07-09 15:39:33-07:00").
    // Cast to TIMESTAMPTZ so vgplot renders them as a proper UTC time scale.
    acquisition_start_time: 'TIMESTAMPTZ',
    acquisition_end_time: 'TIMESTAMPTZ',
  },
};

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function quoteIdentifier(identifier) {
  if (typeof identifier !== 'string' || !SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Invalid SQL identifier: "${identifier}"`);
  }
  return `"${identifier}"`;
}

/**
 * Build the `CREATE OR REPLACE TABLE` SQL for registering an acorn.
 *
 * Exported as a pure function so it can be unit-tested without a live
 * coordinator.
 *
 * @param {object}                acorn       - Validated acorn entry.
 * @param {Record<string,string>} [columnCasts={}]
 *   Map of column name → DuckDB type string.  When non-empty, generates
 *   `SELECT * REPLACE(CAST(col AS type) AS col, ...)` to fix column types
 *   inline during table creation.
 * @param {string} [targetName=acorn.name] - Validated physical table name.
 * @returns {string} The full CREATE TABLE … AS SELECT … SQL statement.
 */
export function buildRegisterSql(acorn, columnCasts = {}, subjectIds = null, targetName = acorn.name) {
  const arg = buildParquetArg(acorn);
  const quotedTargetName = quoteIdentifier(targetName);
  const entries = Object.entries(columnCasts);
  let selectExpr = '*';
  if (entries.length > 0) {
    const replaceExprs = entries
      .map(([col, type]) => `CAST(${col} AS ${type}) AS ${col}`)
      .join(', ');
    selectExpr = `* REPLACE(${replaceExprs})`;
  }

  // Optionally restrict to a set of subject_ids from the selected project.
  // Only applied to asset-type acorns that have subject_id as a partition key
  // or column; metadata acorns are always loaded in full.
  let whereClause = '';
  if (acorn.type === 'asset' && subjectIds != null) {
    const hasSubjectId =
      acorn.partition_key === 'subject_id' ||
      (Array.isArray(acorn.columns) && acorn.columns.some(
        (c) => (typeof c === 'string' ? c : c.name) === 'subject_id',
      ));
    if (hasSubjectId) {
      if (subjectIds.length === 0) {
        whereClause = ' WHERE FALSE';
      } else {
        const quotedIds = subjectIds
          .map((id) => "'" + String(id).replace(/'/g, "''") + "'")
          .join(', ');
        whereClause = ' WHERE subject_id IN (' + quotedIds + ')';
      }
    }
  }

  return `CREATE OR REPLACE TABLE ${quotedTargetName} AS SELECT ${selectExpr} FROM read_parquet(${arg})${whereClause}`;
}

/**
 * Return all acorns whose type is `"metadata"`.
 *
 * @param {object[]} acorns
 * @returns {object[]}
 */
export function getMetadataAcorns(acorns) {
  return acorns.filter((a) => a.type === 'metadata');
}

/**
 * Return all acorns whose type is `"asset"`.
 *
 * @param {object[]} acorns
 * @returns {object[]}
 */
export function getAssetAcorns(acorns) {
  return acorns.filter((a) => a.type === 'asset');
}

/**
 * Find an acorn by name.  Returns `undefined` if not found.
 *
 * @param {object[]} acorns
 * @param {string}   name
 * @returns {object | undefined}
 */
export function getAcornByName(acorns, name) {
  return acorns.find((a) => a.name === name);
}

// ---------------------------------------------------------------------------
// # Version resolution
// ---------------------------------------------------------------------------

/** Module-level resolved base URL (set after first successful fetch). */
let _resolvedBaseUrl = null;

/**
 * Return the resolved data-cache base URL (e.g. `https://…/data-asset-cache/zs-v0.28.1`).
 * Available only after `fetchAndRegisterMetadata` has completed successfully.
 *
 * @returns {string|null}
 */
export function getResolvedBaseUrl() {
  return _resolvedBaseUrl;
}

/**
 * Return the resolved data-cache version folder name (e.g. `bdc-v0.37`).
 * Available only after `fetchAndRegisterMetadata` has completed successfully.
 *
 * @returns {string|null}
 */
export function getResolvedVersion() {
  return _resolvedBaseUrl ? _resolvedBaseUrl.split('/').pop() : null;
}

/**
 * Compare two semver strings (e.g. "0.28.1" > "0.27.3").
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Fetch the versions index, pick the latest version, and return its base URL.
 *
 * @param {string} versionsUrl - HTTPS URL of cache_versions.json.
 * @returns {Promise<{baseUrl: string}>}
 */
async function resolveLatestVersion(versionsUrl) {
  // Normal (default) HTTP caching: S3 returns Last-Modified/ETag on this
  // object, so the browser can heuristically cache it across page
  // navigations instead of forcing a full round-trip on every load.
  const resp = await fetch(versionsUrl);
  if (!resp.ok) {
    throw new Error(`Failed to fetch versions index: ${resp.status} ${resp.statusText}`);
  }
  const versions = await resp.json();
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error('cache_versions.json must be a non-empty array');
  }
  // versions are folder names like "bc-v0.1.0" or bare version strings "0.1.0"
  const parsed = versions.map((v) => {
    const bare = String(v).replace(/^[a-z]+-v/, '');
    return { raw: v, bare };
  });
  parsed.sort((a, b) => compareSemver(a.bare, b.bare));
  const latest = parsed[parsed.length - 1];
  return { baseUrl: `${DATA_CACHE_PREFIX}/${latest.raw}` };
}

// ---------------------------------------------------------------------------
// # DB Operations (require a live Mosaic coordinator)
// ---------------------------------------------------------------------------

/**
 * Fetch the cache_versions.json version index, resolve the latest version,
 * fetch the corresponding cache_registry.json metadata file, and register all
 * `"metadata"`-type acorns as DuckDB tables via the provided coordinator.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {string} versionsUrl - HTTPS URL of cache_versions.json.
 * @returns {Promise<{ acorns: object[], baseUrl: string }>} The parsed registry JSON + base URL.
 */
/**
 * Fetch and parse the cache_registry.json metadata over plain HTTPS.
 *
 * This step needs NO DuckDB/Mosaic coordinator, so callers can fetch the
 * (tiny) registry while the much larger DuckDB-WASM engine downloads in
 * parallel. Use {@link registerEagerTables} afterwards to register tables.
 *
 * @param {string} versionsUrl - HTTPS URL of cache_versions.json.
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]
 * @returns {Promise<{ acorns: object[], baseUrl: string }>} The parsed registry + base URL.
 */
export async function fetchMetadata(versionsUrl, { onProgress } = {}) {
  // 1. Resolve the latest version from the versions index.
  onProgress?.({ phase: 'versions' });
  const { baseUrl } = await resolveLatestVersion(versionsUrl);
  _resolvedBaseUrl = baseUrl;

  // 2. Load the distributed registry: each acorn entry lives at
  // `<version>/cache_registry/<table>.json` (there is no single registry file).
  onProgress?.({ phase: 'registry' });
  const metadata = await fetchDistributedRegistry(baseUrl);
  metadata.baseUrl = baseUrl;
  return metadata;
}

/**
 * Load the distributed registry: each acorn entry lives at
 * `<version>/cache_registry/<table>.json`. We list the folder over the
 * anonymous S3 REST API, then fetch every entry in parallel.
 *
 * @param {string} baseUrl - Resolved version base URL (…/data-asset-cache/<version>).
 * @returns {Promise<{ acorns: object[] }>}
 */
async function fetchDistributedRegistry(baseUrl) {
  const version = baseUrl.split('/').pop();
  const prefix = `data-asset-cache/${version}/cache_registry/`;
  const listUrl =
    `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/` +
    `?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
  // The ListObjectsV2 XML response carries no cache validators from S3, so
  // it always hits the network regardless of cache mode — default is fine.
  const listResp = await fetch(listUrl);
  if (!listResp.ok) {
    throw new Error(
      `Failed to list registry at ${listUrl}: ${listResp.status} ${listResp.statusText}`,
    );
  }
  const xml = await listResp.text();
  const keys = [];
  const re = /<Key>([^<]+\.json)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(m[1]);
  if (keys.length === 0) {
    throw new Error(`Registry folder ${prefix} is empty`);
  }
  const tables = await Promise.all(
    keys.map(async (key) => {
      const url = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;
      // Normal caching: these objects carry Last-Modified/ETag, so repeat
      // page loads within the browser's heuristic freshness window are
      // served from disk cache instead of re-fetching every entry.
      const r = await fetch(url);
      if (!r.ok) {
        throw new Error(`Failed to fetch registry entry ${url}: ${r.status} ${r.statusText}`);
      }
      return r.json();
    }),
  );
  return parseCacheRegistryJson({ tables });
}


/**
 * Aggregate error thrown by {@link registerEagerTables} when one or more
 * *required* tables fail to register. Carries the full structured failure
 * report so callers can render every failed table, not just the first.
 */
export class RequiredTablesError extends Error {
  /**
   * @param {Array<object>} requiredFailures - Failures where `required` is true.
   * @param {object} [opts]
   * @param {Array<object>} [opts.failures=requiredFailures] - All failures (required + optional).
   * @param {string[]} [opts.registered=[]] - Names of tables that registered successfully.
   */
  constructor(requiredFailures, { failures = requiredFailures, registered = [] } = {}) {
    const names = requiredFailures.map((f) => f.table).join(', ');
    super(`Required table(s) failed to load: ${names}`);
    this.name = 'RequiredTablesError';
    this.requiredFailures = requiredFailures;
    this.failures = failures;
    this.registered = registered;
  }
}

/** Short, safe, user-facing categories for a table registration failure. */
const TABLE_ERROR_CATEGORIES = {
  network: 'Network or CORS failure while fetching the data file.',
  registry: 'The table could not be found in the data registry.',
  parquet: 'The underlying data file is unavailable.',
  query: 'DuckDB failed to register the table.',
  resource: 'The browser ran out of memory or hit another resource limit.',
  unknown: 'An unknown error occurred.',
};

/**
 * Map a raw error (or message) from a table registration failure to a short,
 * safe category key. Used to avoid ever showing raw stack traces / URLs to
 * end users by default.
 *
 * @param {unknown} err - Error object or message string.
 * @returns {keyof typeof TABLE_ERROR_CATEGORIES}
 */
export function categorizeTableError(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  if (msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('cors')) {
    return 'network';
  }
  if (msg.includes('unknown acorn') || msg.includes('registry folder') || msg.includes('cache_registry')) {
    return 'registry';
  }
  if (msg.includes('parquet') || msg.includes('404') || msg.includes('403') || msg.includes('no files found')) {
    return 'parquet';
  }
  if (msg.includes('duckdb') || msg.includes('binder') || msg.includes('syntax') || msg.includes('sql')) {
    return 'query';
  }
  if (msg.includes('memory') || msg.includes('oom') || msg.includes('resource')) {
    return 'resource';
  }
  return 'unknown';
}

/**
 * Return the safe, user-facing description for a table registration failure.
 *
 * @param {unknown} err - Error object or message string.
 * @returns {string}
 */
export function describeTableError(err) {
  return TABLE_ERROR_CATEGORIES[categorizeTableError(err)] ?? TABLE_ERROR_CATEGORIES.unknown;
}

/**
 * Redact query strings and common credential/token parameters from an error
 * message before it is ever displayed to the user (e.g. in a diagnostics
 * panel). Never insert raw, unredacted error text into the DOM.
 *
 * @param {unknown} message
 * @returns {string}
 */
export function sanitizeErrorMessage(message) {
  if (!message) return '';
  return String(message)
    .replace(/(https?:\/\/[^\s'")]+?)\?[^\s'")]*/g, '$1?[redacted]')
    .replace(/([?&](?:token|signature|key|secret|authorization|x-amz-[a-z0-9-]+)=)[^&\s'")]*/gi, '$1[redacted]');
}

/**
 * Register the eagerly-needed `"metadata"`-type acorns as DuckDB tables.
 *
 * `requiredTables` (default: `['asset_basics']`) must all succeed — if any
 * fail, every attempted registration still runs to completion, then a
 * {@link RequiredTablesError} is thrown carrying the full structured report.
 * `optionalTables` may fail without blocking startup; their failures are
 * simply included in the returned report.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {{ acorns: object[] }} metadata - Parsed registry from {@link fetchMetadata}.
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {string[]} [opts.requiredTables=['asset_basics']]
 * @param {string[]} [opts.optionalTables=[]]
 * @returns {Promise<{ registered: string[], failures: object[] }>}
 * @throws {RequiredTablesError} if any required table fails to register.
 */
export async function registerEagerTables(coordinator, metadata, {
  onProgress,
  requiredTables = ['asset_basics'],
  optionalTables = [],
} = {}) {
  const overlap = requiredTables.filter((t) => optionalTables.includes(t));
  if (overlap.length > 0) {
    throw new Error(`Table(s) cannot be listed as both required and optional: ${overlap.join(', ')}`);
  }

  // DuckDB-WASM has httpfs built in — no INSTALL/LOAD needed.
  // All parquet URLs are converted to HTTPS so no S3 credentials are required.
  const acornsByName = new Map(getMetadataAcorns(metadata.acorns).map((a) => [a.name, a]));
  const requested = [
    ...requiredTables.map((name) => ({ name, required: true })),
    ...optionalTables.map((name) => ({ name, required: false })),
  ];
  for (const { name } of requested) {
    if (!acornsByName.has(name)) {
      throw new Error(`Unknown eager table "${name}" — no metadata acorn with that name in the registry`);
    }
  }

  const registered = [];
  const failures = [];
  for (let i = 0; i < requested.length; i++) {
    const { name, required } = requested[i];
    onProgress?.({ phase: 'table', step: i, total: requested.length, name });
    try {
      await registerAcornTable(coordinator, acornsByName.get(name));
      registered.push(name);
    } catch (err) {
      console.warn(
        `[metadata] Failed to register acorn "${name}"${required ? ' (required)' : ', skipping'}:`,
        err?.message ?? err,
      );
      failures.push({
        table: name,
        required,
        phase: 'register',
        message: err?.message ?? String(err),
        cause: err,
      });
    }
  }

  const requiredFailures = failures.filter((f) => f.required);
  if (requiredFailures.length > 0) {
    throw new RequiredTablesError(requiredFailures, { failures, registered });
  }

  return { registered, failures };
}

/**
 * Fetch the metadata registry and register the eager tables in one call.
 * Thin wrapper over {@link fetchMetadata} + {@link registerEagerTables},
 * kept for callers that already have a coordinator in hand.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {string} versionsUrl - HTTPS URL of cache_versions.json.
 * @param {object} [opts]
 * @param {(p: object) => void} [opts.onProgress]
 * @param {string[]} [opts.requiredTables=['asset_basics']]
 * @param {string[]} [opts.optionalTables=[]]
 * @returns {Promise<{ acorns: object[], baseUrl: string }>} The parsed registry JSON + base URL.
 * @throws {RequiredTablesError} if any required table fails to register.
 */
export async function fetchAndRegisterMetadata(coordinator, versionsUrl, { onProgress, requiredTables = ['asset_basics'], optionalTables = [] } = {}) {
  const metadata = await fetchMetadata(versionsUrl, { onProgress });
  await registerEagerTables(coordinator, metadata, { onProgress, requiredTables, optionalTables });
  return metadata;
}

/** Columns that are list-typed in the new parquet schema. */
const LIST_COLUMNS = new Set([
  'modalities', 'experimenters', 'experimenters_normalized',
  'investigators', 'investigators_normalized',
]);

/**
 * Build a SQL WHERE clause (including the WHERE keyword) that filters
 * `asset_basics` rows to those matching the given query filter.
 *
 * The returned string always ends with `AND subject_id IS NOT NULL` so it
 * is safe to use directly in subject-ID queries.
 *
 * @param {{ projects: string[], extraFilters: Array<{column: string, values: string[]}> }} queryFilter
 * @returns {string} A WHERE … SQL fragment, or 'WHERE subject_id IS NOT NULL'
 *   when the filter is empty.
 */
export function buildQueryWhereClause(queryFilter) {
  const { projects = [], extraFilters = [] } = queryFilter || {};
  const parts = [];
  if (projects.length > 0) {
    const quoted = projects
      .map((p) => "'" + String(p).replace(/'/g, "''") + "'")
      .join(', ');
    parts.push(`project_name IN (${quoted})`);
  }
  for (const f of extraFilters) {
    if (Array.isArray(f.values) && f.values.length > 0) {
      const col = f.column.replace(/"/g, '""');
      const quoted = f.values
        .map((v) => "'" + String(v).replace(/'/g, "''") + "'")
        .join(', ');
      if (LIST_COLUMNS.has(f.column)) {
        parts.push(`list_has_any("${col}", [${quoted}])`);
      } else {
        parts.push(`"${col}" IN (${quoted})`);
      }
    }
  }
  const filter = parts.length > 0 ? parts.join(' AND ') + ' AND ' : '';
  return `WHERE ${filter}subject_id IS NOT NULL`;
}

/**
 * Fetch distinct subject_ids from `asset_basics` that match the given query
 * filter (projects + extra column filters).  Returns null when the filter
 * selects nothing (empty projects list and no extra filters).
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {{ projects: string[], extraFilters: Array<{column: string, values: string[]}> }|null} queryFilter
 * @returns {Promise<string[]|null>}
 */
export async function fetchSubjectIdsForQuery(coordinator, queryFilter) {
  if (!queryFilter) return null;
  const { projects = [], extraFilters = [] } = queryFilter;
  if (projects.length === 0 && extraFilters.length === 0) return null;
  const whereClause = buildQueryWhereClause(queryFilter);
  try {
    const result = await coordinator.query(
      `SELECT DISTINCT subject_id::VARCHAR AS subject_id FROM asset_basics ${whereClause} ORDER BY 1`,
    );
    const col = result.getChild('subject_id');
    if (!col) return null;
    return Array.from({ length: col.length }, (_, i) => String(col.get(i)));
  } catch (err) {
    console.warn('[DataExplorer] fetchSubjectIdsForQuery failed:', err);
    return null;
  }
}

/**
 * Fetch all distinct non-null subject_ids from the `asset_basics` table,
 * ordered alphabetically.  Used to populate the subject-selector dropdown.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @returns {Promise<string[]>} Sorted list of subject ID strings (may be empty on error).
 */
export async function fetchAllSubjectIds(coordinator) {
  try {
    const result = await coordinator.query(
      `SELECT DISTINCT subject_id::VARCHAR AS subject_id FROM asset_basics WHERE subject_id IS NOT NULL ORDER BY 1`,
    );
    const col = result.getChild('subject_id');
    if (!col) return [];
    return Array.from({ length: col.length }, (_, i) => String(col.get(i)));
  } catch (err) {
    console.warn('[DataExplorer] fetchAllSubjectIds failed:', err);
    return [];
  }
}

/**
 * Fetch the distinct subject_ids for a single project from the `asset_basics`
 * table.  Thin wrapper around fetchSubjectIdsForQuery kept for compatibility.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {string|null} projectName
 * @returns {Promise<string[]|null>}
 */
export async function fetchSubjectIdsForProject(coordinator, projectName) {
  if (!projectName) return null;
  return fetchSubjectIdsForQuery(coordinator, { projects: [projectName], extraFilters: [] });
}

/**
 * Register a single acorn as a DuckDB table (or replace if it already exists).
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {object}        acorn                    - Validated acorn entry.
 * @param {object}        [options={}]
 * @param {string[]|null} [options.subjectIds=null] - If provided, restricts the
 *   table to rows matching these subject_ids (used to filter asset tables to
 *   the currently selected project).
 * @param {string}        [options.targetName=acorn.name] - Physical table name.
 * @returns {Promise<string>}
 */
export async function registerAcornTable(coordinator, acorn, { subjectIds = null, targetName = acorn.name } = {}) {
  const casts = ACORN_COLUMN_CASTS[acorn.name] ?? {};
  const sql = buildRegisterSql(acorn, casts, subjectIds, targetName);
  await coordinator.exec(sql);
  return targetName;
}

/**
 * Drop a previously registered acorn table.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {string} acornName - The `name` field of the acorn to drop.
 * @returns {Promise<void>}
 */
export async function dropAcornTable(coordinator, acornName) {
  await coordinator.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(acornName)}`);
}

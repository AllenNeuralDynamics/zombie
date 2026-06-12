/**
 * Application-wide constants for Data Explorer.
 *
 * S3 paths use the virtual-hosted HTTPS style so DuckDB-WASM httpfs can
 * reach them without AWS credentials (public bucket, CORS enabled).
 *
 * s3://bucket/key  →  https://bucket.s3.us-west-2.amazonaws.com/key
 */

// ---------------------------------------------------------------------------
// S3 / metadata
// ---------------------------------------------------------------------------

/** AWS region that hosts all AIND scratch data. */
export const S3_REGION = 'us-west-2';

/** S3 bucket name for application caches. */
export const S3_BUCKET = 'allen-data-views';

/**
 * URL of the top-level version index listing all available biodata-cache
 * version folders.  Fetched once at startup; the latest version is chosen
 * and the corresponding `cache_registry.json` is loaded from its subfolder.
 */
export const VERSIONS_URL = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/data-asset-cache/cache_versions.json`;

/** Base prefix for data-asset-cache (used by modules that build versioned URLs). */
export const DATA_CACHE_PREFIX = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/data-asset-cache`;

// ---------------------------------------------------------------------------
// AIND brand colours (ported from src/zombie/layout.py)
// ---------------------------------------------------------------------------

export const AIND_COLORS = {
  dark_blue: '#111111',
  light_blue: '#555555',
  green:      '#1D8649',
  yellow:     '#d97706',
  grey:       '#888888',
  red:        '#c0392b',
};

// ---------------------------------------------------------------------------
// Default application state
// ---------------------------------------------------------------------------

/** URL query-param key used to restore selected project names on load (comma-separated). */
export const URL_PARAM_PROJECTS = 'projects';

/** URL query-param key used to restore enabled data types on load. */
export const URL_PARAM_DATA_TYPES = 'dataTypes';

/**
 * URL query-param key used to restore extra asset_basics column filters on load.
 * Encoded as: col1:val1|val2,col2:val3  (colon separates column from values,
 * pipe separates values, comma separates individual filter entries).
 */
export const URL_PARAM_EXTRA_FILTERS = 'extraFilters';

/** Fallback project name when none is set via URL or user selection. */
export const DEFAULT_PROJECT = null;

// ---------------------------------------------------------------------------
// Contributions / authorship API
// ---------------------------------------------------------------------------

/**
 * Base URL for the aind-metadata-viz contributions REST API.
 * In production (and local dev) this hits the production server directly.
 */
export const CONTRIBUTIONS_API_BASE = import.meta.env.DEV
  ? 'https://metadata-portal.allenneuraldynamics.org'
  : '/metadata-viz';

// ---------------------------------------------------------------------------
// DuckDB server connector
// ---------------------------------------------------------------------------

/**
 * WebSocket URL for the duckdb-server.
 *
 * Development (Vite dev server):
 *   Connects directly to the local duckdb-server at ws://localhost:3000/.
 *   Start the server with `npm run server` (or `.venv/bin/duckdb-server`).
 *
 * Production (Docker / Vite build):
 *   nginx proxies /ws → duckdb-server on :3000 inside the container.
 *   The URL is derived from the page's own origin so it works at any hostname,
 *   and automatically uses wss:// when the page is served over HTTPS.
 */
export const SERVER_WS_URL = import.meta.env.PROD
  ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
  : 'ws://localhost:3000/';

/**
 * HTTP REST URL for the local duckdb-server (debug / alternative connector).
 * Only meaningful in development; in production the WebSocket path is used.
 */
export const SERVER_HTTP_URL = import.meta.env.PROD
  ? `${window.location.protocol}//${window.location.host}/ws`
  : 'http://localhost:3000/';

// ---------------------------------------------------------------------------
// Layout / plot defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PLOT_WIDTH = 600;
export const DEFAULT_PLOT_HEIGHT = 400;
export const TIME_VIEW_HEIGHT = 160;

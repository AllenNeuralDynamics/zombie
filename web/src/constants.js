/**
 * Application-wide constants for ZOMBIE Mosaic.
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
export const S3_BUCKET = 'aind-scratch-data';

/**
 * HTTPS URL of the squirrel JSON metadata file.
 * Fetched once at startup to discover all available datasets ("acorns").
 */
export const SQUIRREL_URL =
  `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/application-caches/squirrel.json`;

// ---------------------------------------------------------------------------
// AIND brand colours (ported from src/zombie/layout.py)
// ---------------------------------------------------------------------------

export const AIND_COLORS = {
  dark_blue: '#003057',
  light_blue: '#2A7DE1',
  green: '#1D8649',
  yellow: '#FFB71B',
  grey: '#7C7C7F',
  red: '#FF5733',
};

// ---------------------------------------------------------------------------
// Default application state
// ---------------------------------------------------------------------------

/** URL query-param key used to override the default project on load. */
export const URL_PARAM_PROJECT = 'project';

/** URL query-param key used to restore enabled data types on load. */
export const URL_PARAM_DATA_TYPES = 'dataTypes';

/** Fallback project name when none is set via URL or user selection. */
export const DEFAULT_PROJECT = null;

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

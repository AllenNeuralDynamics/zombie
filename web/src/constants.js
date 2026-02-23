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
 * WebSocket URL for the local duckdb-server.
 * Start the server with `npm run server` (or `.venv/bin/duckdb-server`).
 * The coordinator's socketConnector defaults to this URL.
 */
export const SERVER_WS_URL = 'ws://localhost:3000/';

/**
 * HTTP REST URL for the local duckdb-server.
 * Used as an alternative to the WebSocket connector (e.g. for fetch-based
 * debugging).  `restConnector` defaults to this URL.
 */
export const SERVER_HTTP_URL = 'http://localhost:3000/';

// ---------------------------------------------------------------------------
// Layout / plot defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PLOT_WIDTH = 600;
export const DEFAULT_PLOT_HEIGHT = 400;
export const TIME_VIEW_HEIGHT = 160;

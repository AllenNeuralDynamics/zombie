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

/** Where users should report persistent data-loading failures. */
export const ISSUE_TRACKER_URL = 'https://github.com/AllenNeuralDynamics/aind-scientific-computing/issues';

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
// Verification graph API (see GRAPH-PLAN.md)
// ---------------------------------------------------------------------------

/**
 * Base URL for the aind-metadata-viz verification-graph REST API.
 *
 * Reads are anonymous and work cross-origin. Writes carry the ORCID session
 * cookie, which the portal's wildcard CORS cannot do, so in production every
 * call goes through the same-origin `/metadata-viz` nginx proxy instead.
 */
export const VERIFICATION_API_BASE = import.meta.env.DEV
  ? 'https://metadata-portal.allenneuraldynamics.org'
  : '/metadata-viz';

// ---------------------------------------------------------------------------
// QC portal metadata proposals API (see METADATA-AUTH.md in aind-qc-portal/dev)
// ---------------------------------------------------------------------------

/**
 * Base URL for the QC portal hosting the two-party metadata proposals flow:
 *   GET    /metadata/login?redirect=<url>   (top-level navigation)
 *   GET    /metadata/me
 *   GET    /metadata/proposals[?status=…]
 *   POST   /metadata/proposals
 *   POST   /metadata/proposals/<id>/approve|reject
 *   DELETE /metadata/proposals/<id>
 *
 * The session cookie is HttpOnly on `.allenneuraldynamics.org`, so the migrate
 * pages only work when served from an `*.allenneuraldynamics.org` host.
 */
export const QC_PORTAL_BASE = 'https://qc.allenneuraldynamics.org';

// ---------------------------------------------------------------------------
// Layout / plot defaults
// ---------------------------------------------------------------------------

export const DEFAULT_PLOT_WIDTH = 600;
export const DEFAULT_PLOT_HEIGHT = 400;
export const TIME_VIEW_HEIGHT = 160;

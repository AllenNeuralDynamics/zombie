/**
 * swdb/data.js — cache access for the SWDB curated sets.
 *
 * The SWDB assets are merged HDF5 NWB files (~3.7 GB each) that a browser cannot
 * read directly, so `biodata-cache`'s `swdb` sync job flattens the parts a
 * dashboard plots into six small parquet tables. This module is the only place
 * that knows their URLs.
 *
 * Every table except the session catalog is partitioned by `asset_name`, and the
 * page always knows which asset it is showing, so each read targets one explicit
 * parquet URL. That deliberately avoids DuckDB-WASM's inability to glob
 * virtual-hosted HTTPS URLs (the workaround `fib_traces` and `ecephys_spikes`
 * need), and parquet column pruning keeps the wide tables cheap: plotting pupil
 * area fetches two columns out of nineteen, not the whole file.
 *
 * All times are in the NWB session clock (t=0 = `session_start_time`); shifting
 * to "first trial at zero" happens in `dr-session.js`, not here.
 */

import { DATA_CACHE_PREFIX } from '../constants.js';
import { getResolvedVersion, quoteIdentifier } from '../lib/metadata.js';
import { queryRows } from '../lib/arrow.js';
import { ensureTable } from '../lib/registry.js';
import { fetchAssetsWithSources } from '../lib/assets-table.js';

/** Registry names of the SWDB cache tables. */
export const SWDB_TABLES = {
  sessions: 'platform_swdb_sessions',
  trials: 'platform_swdb_trials',
  performance: 'platform_swdb_performance',
  events: 'platform_swdb_events',
  eye: 'platform_swdb_eye',
  running: 'platform_swdb_running',
};

/** Registry prefix for the published SWDB metadata datasets. */
export const SWDB_DATASET_PREFIX = 'swdb_2025_';

function _base() {
  const version = getResolvedVersion();
  if (!version) throw new Error('SWDB cache version not resolved yet');
  return `${DATA_CACHE_PREFIX}/${version}`;
}

/** URL of the unpartitioned session catalog. */
export function sessionsUrl() {
  return `${_base()}/${SWDB_TABLES.sessions}.pqt`;
}

/** URL of one asset's partition of a partitioned SWDB table. */
export function partitionUrl(table, assetName) {
  return `${_base()}/${table}/asset_name=${assetName}/data.pqt`;
}

function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Assert an asset name is a plain cache partition key.
 *
 * Asset names reach here from the URL query string, and they are interpolated
 * into both a parquet URL and a SQL string, so anything other than the known
 * name shape is rejected rather than escaped.
 *
 * @param {string} assetName
 * @returns {string} the validated name
 */
export function assertAssetName(assetName) {
  if (!/^[A-Za-z0-9_.-]+$/.test(assetName ?? '')) {
    throw new Error(`Invalid SWDB asset name: ${assetName}`);
  }
  return assetName;
}

async function _readPartition(coord, table, assetName, { columns = '*', where = null, orderBy = null } = {}) {
  const url = partitionUrl(table, assertAssetName(assetName));
  const sql = [
    `SELECT ${columns} FROM read_parquet(${sqlStr(url)})`,
    where ? `WHERE ${where}` : '',
    orderBy ? `ORDER BY ${orderBy}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return queryRows(coord, sql);
}

/**
 * Load the session catalog: one row per curated asset across every set.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @returns {Promise<object[]>}
 */
export async function loadSessions(coord) {
  return queryRows(
    coord,
    `SELECT * FROM read_parquet(${sqlStr(sessionsUrl())}) ORDER BY set_id, session_date`,
  );
}

/**
 * Return the SWDB metadata datasets present in the resolved cache registry.
 *
 * The metadata cache currently publishes one small table per curated dataset
 * (for example, `swdb_2025_bci`). Keeping discovery registry-driven means the
 * landing page shows newly published datasets without a frontend release.
 */
export function listSwdbDatasets(metadata) {
  return (metadata?.acorns ?? [])
    .filter((acorn) => acorn.name.startsWith(SWDB_DATASET_PREFIX))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load one summary row for every published SWDB metadata dataset.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {{ acorns: object[] }} metadata - Resolved cache registry.
 * @returns {Promise<object[]>}
 */
export async function loadSwdbDatasetSummaries(coord, metadata) {
  return Promise.all(listSwdbDatasets(metadata).map(async (acorn) => {
    const table = await ensureTable(coord, acorn.name);
    const columns = new Set((acorn.columns ?? []).map((column) => (
      typeof column === 'string' ? column : column.name
    )));
    const expressions = ['COUNT(*) AS n_assets'];
    if (columns.has('subject_id')) expressions.push('COUNT(DISTINCT subject_id) AS n_subjects');
    if (columns.has('session_date')) {
      expressions.push('MIN(session_date) AS first_date', 'MAX(session_date) AS last_date');
    }
    const [row] = await queryRows(
      coord,
      `SELECT ${expressions.join(', ')} FROM ${quoteIdentifier(table)}`,
    );
    return {
      ...acorn,
      nAssets: Number(row?.n_assets) || 0,
      nSubjects: Number(row?.n_subjects) || 0,
      firstDate: row?.first_date ?? null,
      lastDate: row?.last_date ?? null,
    };
  }));
}

/**
 * Resolve the published dataset's asset names into the canonical asset_basics
 * rows used by the standard `/view` asset dataframe.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {{ acorns: object[] }} metadata - Resolved cache registry.
 * @param {string} datasetName - Registry name such as `swdb_2025_bci`.
 * @returns {Promise<{assets: object[], sourceMap: object}>}
 */
export async function loadSwdbDatasetAssets(coord, metadata, datasetName) {
  const acorn = listSwdbDatasets(metadata).find((candidate) => candidate.name === datasetName);
  if (!acorn) throw new Error(`Unknown SWDB dataset: ${datasetName}`);

  const table = await ensureTable(coord, acorn.name);
  const datasetRows = await queryRows(
    coord,
    `SELECT name FROM ${quoteIdentifier(table)} WHERE name IS NOT NULL ORDER BY name`,
  );
  const names = datasetRows.map((row) => row.name).filter(Boolean);
  if (names.length === 0) return { assets: [], sourceMap: {} };

  const quotedNames = names
    .map((name) => `'${String(name).replace(/'/g, "''")}'`)
    .join(', ');
  return fetchAssetsWithSources(coord, `a.name IN (${quotedNames})`);
}

/**
 * Load every behavior trial for one asset.
 *
 * @param {object} coord
 * @param {string} assetName
 * @returns {Promise<object[]>}
 */
export async function loadTrials(coord, assetName) {
  return _readPartition(coord, SWDB_TABLES.trials, assetName, { orderBy: 'trial_index' });
}

/**
 * Load per-block task performance for one asset.
 *
 * @param {object} coord
 * @param {string} assetName
 * @returns {Promise<object[]>}
 */
export async function loadPerformance(coord, assetName) {
  return _readPartition(coord, SWDB_TABLES.performance, assetName, { orderBy: 'block_index' });
}

/**
 * Load events for one asset, optionally restricted to certain kinds.
 *
 * @param {object} coord
 * @param {string} assetName
 * @param {string[]|null} [kinds] - e.g. ['lick', 'reward']; null loads every kind.
 * @returns {Promise<object[]>}
 */
export async function loadEvents(coord, assetName, kinds = null) {
  const where = kinds?.length ? `kind IN (${kinds.map(sqlStr).join(', ')})` : null;
  return _readPartition(coord, SWDB_TABLES.events, assetName, { where, orderBy: 't' });
}

/**
 * Load eye-tracking columns for one asset.
 *
 * Only the requested columns are read; parquet column pruning means the cost
 * scales with the number of traces plotted, not the width of the table.
 *
 * @param {object} coord
 * @param {string} assetName
 * @param {string[]} [columns]
 * @returns {Promise<object[]>}
 */
export async function loadEye(
  coord,
  assetName,
  columns = ['timestamps', 'pupil_area', 'pupil_center_x', 'pupil_center_y', 'pupil_is_bad_frame'],
) {
  const safe = columns.filter((c) => /^[a-z_]+$/.test(c));
  if (safe.length === 0) throw new Error('loadEye requires at least one valid column');
  return _readPartition(coord, SWDB_TABLES.eye, assetName, {
    columns: safe.join(', '),
    orderBy: 'timestamps',
  });
}

/**
 * Load running speed for one asset, decimated to at most `maxPoints` samples.
 *
 * Running speed is ~400k samples per session; a plot a few hundred pixels wide
 * cannot show that, so the thinning happens in DuckDB rather than shipping every
 * sample to the browser.
 *
 * @param {object} coord
 * @param {string} assetName
 * @param {number} [maxPoints]
 * @returns {Promise<object[]>}
 */
export async function loadRunning(coord, assetName, maxPoints = 4000) {
  const url = partitionUrl(SWDB_TABLES.running, assertAssetName(assetName));
  const sql = `
    WITH src AS (
      SELECT timestamps, speed, row_number() OVER (ORDER BY timestamps) AS rn,
             count(*) OVER () AS n
      FROM read_parquet(${sqlStr(url)})
    )
    SELECT timestamps, speed
    FROM src
    WHERE rn % greatest(1, CAST(ceil(n / ${Number(maxPoints)}.0) AS BIGINT)) = 0
    ORDER BY timestamps
  `;
  return queryRows(coord, sql);
}

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
export const SWDB_DATASET_PREFIX = 'swdb_';

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

function fallbackAcquisitionTime(assetName) {
  const match = String(assetName ?? '').match(/(?:^|_)(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})(?:_|$)/);
  return match ? `${match[1]}T${match[2].replaceAll('-', ':')}Z` : null;
}

function fallbackModality(datasetName) {
  const name = String(datasetName ?? '');
  return /neuropixels|dynamic_routing|visual_coding_neuropixels/i.test(name)
    ? ['ecephys']
    : ['pophys'];
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
 * (for example, `swdb_2026_visual_learning`). Keeping discovery registry-driven means the
 * landing page shows newly published datasets without a frontend release.
 */
export function listSwdbDatasets(metadata) {
  const acorns = metadata?.acorns ?? [];
  const hasPublicReplacement = new Set(
    acorns.filter((acorn) => acorn.name.startsWith('swdb_2026_')).map((acorn) => acorn.name),
  );
  return acorns
    .filter((acorn) => acorn.name.startsWith(SWDB_DATASET_PREFIX))
    // The 2026 public-collection tables supersede the old DocDB-derived
    // copies when both are present; otherwise the landing page shows duplicate
    // BCI/V1DD cards for the same public dataset.
    .filter((acorn) => !(
      acorn.name === 'swdb_2025_bci' && hasPublicReplacement.has('swdb_2026_bci')
    ) && !(
      acorn.name === 'swdb_2025_v1dd' && hasPublicReplacement.has('swdb_2026_v1dd')
    ))
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
  const datasets = listSwdbDatasets(metadata);
  if (datasets.length === 0) return [];

  // Dataset tables only describe membership. Resolve subjects from the
  // canonical metadata table so public collection products and older SWDB
  // tables use the same subject definition.
  await ensureTable(coord, 'asset_basics');

  return Promise.all(datasets.map(async (acorn) => {
    const table = await ensureTable(coord, acorn.name);
    const [datasetRow] = await queryRows(
      coord,
      `SELECT COUNT(*) AS n_assets FROM ${quoteIdentifier(table)}`,
    );
    const [metadataRow] = await queryRows(
      coord,
      `
        SELECT
          COUNT(DISTINCT a.subject_id) AS n_subjects,
          MIN(TRY_CAST(a.acquisition_start_time AS DATE)) AS first_date,
          MAX(TRY_CAST(a.acquisition_start_time AS DATE)) AS last_date
        FROM asset_basics a
        INNER JOIN (
          SELECT DISTINCT name
          FROM ${quoteIdentifier(table)}
          WHERE name IS NOT NULL
        ) d ON d.name = a.name
        WHERE a.subject_id IS NOT NULL
      `,
    );
    return {
      ...acorn,
      nAssets: Number(datasetRow?.n_assets) || 0,
      nSubjects: Number(metadataRow?.n_subjects) || 0,
      firstDate: metadataRow?.first_date ?? null,
      lastDate: metadataRow?.last_date ?? null,
    };
  }));
}

/**
 * Load the dated canonical asset rows needed by the SWDB landing-page
 * overview. Each row carries its published SWDB dataset name so the shared
 * histogram can switch between modality and dataset grouping in the browser.
 *
 * @param {object} coord
 * @param {{ acorns: object[] }} metadata
 * @returns {Promise<object[]>}
 */
export async function loadSwdbOverviewAssets(coord, metadata) {
  const datasets = listSwdbDatasets(metadata);
  if (datasets.length === 0) return [];

  await ensureTable(coord, 'asset_basics');
  const rowsByDataset = await Promise.all(datasets.map(async (acorn) => {
    const table = await ensureTable(coord, acorn.name);
    const columns = new Set((acorn.columns ?? []).map((column) => (
      typeof column === 'string' ? column : column.name
    )));
    const datasetModality = columns.has('modality') ? ', d.modality AS dataset_modality' : '';
    const datasetDate = columns.has('session_date') ? ', d.session_date::VARCHAR AS dataset_date' : '';
    const rows = await queryRows(
      coord,
      `
        SELECT d.name, a.acquisition_start_time::VARCHAR AS acquisition_start_time,
               a.modalities${datasetModality}${datasetDate}
        FROM (
          SELECT DISTINCT name${columns.has('modality') ? ', modality' : ''}${columns.has('session_date') ? ', session_date' : ''}
          FROM ${quoteIdentifier(table)}
          WHERE name IS NOT NULL
        ) d
        LEFT JOIN asset_basics a
          ON d.name = a.name
         AND (a.data_level IS NULL OR a.data_level != 'derived')
        ORDER BY a.acquisition_start_time, d.name
      `,
    );
    return rows.map((row) => ({
      name: row.name,
      acquisition_start_time: row.acquisition_start_time
        ?? row.dataset_date
        ?? fallbackAcquisitionTime(row.name),
      modalities: row.modalities ?? (row.dataset_modality ? [row.dataset_modality] : fallbackModality(acorn.name)),
      dataset: acorn.name,
    }));
  }));

  return rowsByDataset.flat();
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
  const hasDataAssetId = (acorn.columns ?? []).some((column) => (
    (typeof column === 'string' ? column : column.name) === 'data_asset_id'
  ));
  const datasetRows = await queryRows(
    coord,
    `SELECT name${hasDataAssetId ? ', data_asset_id' : ''} FROM ${quoteIdentifier(table)} WHERE name IS NOT NULL ORDER BY name`,
  );
  const names = datasetRows.map((row) => row.name).filter(Boolean);
  if (names.length === 0) return { assets: [], sourceMap: {} };

  const quotedNames = names
    .map((name) => `'${String(name).replace(/'/g, "''")}'`)
    .join(', ');

  // SWDB bootstraps with no eager tables. The shared asset dataframe helper
  // joins against asset_basics, so register that canonical table lazily here
  // before delegating to it.
  await ensureTable(coord, 'asset_basics');
  const canonical = await fetchAssetsWithSources(coord, `a.name IN (${quotedNames})`);
  const matched = new Set(canonical.assets.map((asset) => asset.name));
  // Public Code Ocean data assets can be collection-level products without a
  // matching metadata-index row. Keep those names in the standard table so
  // membership is still visible and the eventual /view link remains usable.
  const missing = datasetRows
    .filter((row) => row.name && !matched.has(row.name))
    .map((row) => ({ name: row.name, code_ocean: row.data_asset_id ?? null }));
  return {
    assets: [...canonical.assets, ...missing],
    sourceMap: canonical.sourceMap,
  };
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

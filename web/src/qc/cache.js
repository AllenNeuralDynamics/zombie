/**
 * Build the direct read query for one raw-asset QC partition.
 *
 * DuckDB-WASM cannot glob the virtual-hosted S3 URL for the partitioned QC
 * table, so QC must be loaded from the one partition needed by the page.
 */

import { s3PathToHttps } from '../lib/metadata.js';

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * @param {object} acorn - quality_control registry entry
 * @param {string} rawAssetName - raw root asset name
 * @returns {string} SQL selecting the requested raw-asset partition
 */
export function buildQcPartitionQuery(acorn, rawAssetName) {
  if (!acorn?.partitioned || acorn.partition_key !== 'raw_asset_name') {
    throw new Error('quality_control must be partitioned by raw_asset_name');
  }
  if (!rawAssetName) throw new Error('A raw asset name is required for QC lookup');

  const base = s3PathToHttps(acorn.location.replace(/\/+$/, ''));
  const url = `${base}/${acorn.partition_key}=${rawAssetName}/data.pqt`;
  return `SELECT * FROM read_parquet(${sqlString(url)}, hive_partitioning=true)`;
}

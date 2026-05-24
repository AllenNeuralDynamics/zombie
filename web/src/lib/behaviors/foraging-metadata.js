/**
 * foraging-metadata.js — Query helpers for the zs_foraging_sessions DuckDB table.
 *
 * The table is registered from a parquet file on S3 (allen-data-views bucket)
 * during app startup via squirrel.json or manual registration.
 */

import { S3_REGION, S3_BUCKET } from '../../constants.js';

const TABLE_NAME = 'zs_foraging_sessions';
const PARQUET_URL = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/data-asset-cache/zs_foraging_sessions.pqt`;

/**
 * Ensure the zs_foraging_sessions table is registered in DuckDB.
 * Safe to call multiple times — uses CREATE OR REPLACE.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 */
export async function ensureForagingTable(coordinator) {
  const sql = `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} AS SELECT * FROM read_parquet('${PARQUET_URL}')`;
  await coordinator.exec(sql);
}

/**
 * Query foraging session metadata for a given subject + date.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {string} subjectId
 * @param {string} sessionDate - ISO date string (YYYY-MM-DD)
 * @returns {Promise<object|null>} Session metadata row or null if not found.
 */
export async function queryForagingSession(coordinator, subjectId, sessionDate) {
  try {
    await ensureForagingTable(coordinator);

    const safeId = subjectId.replace(/'/g, "''");
    const safeDate = sessionDate.replace(/'/g, "''");

    const result = await coordinator.query(
      `SELECT * FROM ${TABLE_NAME} WHERE subject_id = '${safeId}' AND session_date = '${safeDate}' LIMIT 1`,
    );

    if (!result || result.numRows === 0) return null;

    const row = {};
    for (const field of result.schema.fields) {
      const col = result.getChild(field.name);
      row[field.name] = col ? col.get(0) : null;
    }
    return row;
  } catch (err) {
    console.warn('[ForagingMetadata] query failed:', err);
    return null;
  }
}

/**
 * Query all foraging sessions for a given subject.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {string} subjectId
 * @returns {Promise<object[]>} Array of session metadata rows.
 */
export async function queryForagingSessionsForSubject(coordinator, subjectId) {
  try {
    await ensureForagingTable(coordinator);

    const safeId = subjectId.replace(/'/g, "''");
    const result = await coordinator.query(
      `SELECT * FROM ${TABLE_NAME} WHERE subject_id = '${safeId}' ORDER BY session_date`,
    );

    if (!result || result.numRows === 0) return [];

    const rows = [];
    for (let i = 0; i < result.numRows; i++) {
      const row = {};
      for (const field of result.schema.fields) {
        const col = result.getChild(field.name);
        row[field.name] = col ? col.get(i) : null;
      }
      rows.push(row);
    }
    return rows;
  } catch (err) {
    console.warn('[ForagingMetadata] queryForSubject failed:', err);
    return [];
  }
}

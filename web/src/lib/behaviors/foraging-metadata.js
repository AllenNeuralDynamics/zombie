/**
 * foraging-metadata.js — Query helpers for the foraging_sessions DuckDB table.
 *
 * The table is registered from a parquet file on S3 (allen-data-views bucket)
 * via squirrel.json acorn definitions (centralized in lib/registry.js).
 */

import { ensureTable } from '../registry.js';
import { queryRows } from '../arrow.js';

const TABLE_NAME = 'foraging_sessions';

/**
 * Ensure the foraging_sessions table is registered in DuckDB.
 * Safe to call multiple times — uses singleton promise in registry.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 */
export async function ensureForagingTable(coordinator) {
  await ensureTable(coordinator, TABLE_NAME);
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

    const rows = await queryRows(
      coordinator,
      `SELECT * FROM ${TABLE_NAME} WHERE subject_id = '${safeId}' AND session_date = '${safeDate}' LIMIT 1`,
    );

    return rows.length > 0 ? rows[0] : null;
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

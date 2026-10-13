/**
 * foraging-metadata.js — Query helpers for the platform_dynamic_foraging_sessions DuckDB table.
 *
 * The table is registered from a parquet file on S3 (allen-data-views bucket)
 * via cache_registry.json acorn definitions (centralized in lib/registry.js).
 */

import { ensureTable } from '../registry.js';
import { queryRows } from '../arrow.js';

const TABLE_NAME = 'platform_dynamic_foraging_sessions';

/**
 * Ensure the platform_dynamic_foraging_sessions table is registered in DuckDB.
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
 * Query foraging session metadata for several dates of one subject at once.
 *
 * Used by the multi-session comparison panel, which needs one row per selected
 * acquisition and must not fire a query per session.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coordinator
 * @param {string} subjectId
 * Rows carry an extra `session_date_iso` column: `session_date` is not a plain
 * string in the cache, so Arrow hands the raw column back as a date value that
 * no caller can match against a `YYYY-MM-DD` key. Casting in SQL keeps the
 * join on the JS side honest.
 *
 * @param {string[]} sessionDates - ISO date strings (YYYY-MM-DD)
 * @returns {Promise<object[]>} Rows for the dates that exist, oldest first.
 */
export async function queryForagingSessionsByDates(coordinator, subjectId, sessionDates) {
  const dates = [...new Set((sessionDates ?? []).filter(Boolean))];
  if (!dates.length) return [];
  try {
    await ensureForagingTable(coordinator);

    const safeId = String(subjectId).replace(/'/g, "''");
    const inList = dates.map((d) => `'${String(d).replace(/'/g, "''")}'`).join(', ');

    return await queryRows(
      coordinator,
      `SELECT *, CAST(session_date AS VARCHAR) AS session_date_iso
         FROM ${TABLE_NAME}
        WHERE subject_id = '${safeId}' AND session_date IN (${inList})
        ORDER BY session_date`,
    );
  } catch (err) {
    console.warn('[ForagingMetadata] queryByDates failed:', err);
    return [];
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

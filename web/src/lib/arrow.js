/**
 * lib/arrow.js — Apache Arrow result conversion utilities.
 *
 * @module
 */

/**
 * Convert an Apache Arrow result table to an array of plain JS row objects.
 * List-typed columns are converted to plain JS arrays.
 *
 * @param {import('apache-arrow').Table} result
 * @returns {object[]}
 */
export function arrowTableToRows(result) {
  const rows = [];
  const fields = result.schema.fields.map((f) => f.name);
  for (let i = 0; i < result.numRows; i++) {
    const row = {};
    for (const f of fields) {
      const col = result.getChild(f);
      if (!col) { row[f] = null; continue; }
      const val = col.get(i);
      // Arrow list columns return a Vector-like object with toArray()
      if (val != null && typeof val === 'object' && typeof val.toArray === 'function' && !Array.isArray(val)) {
        row[f] = Array.from(val.toArray());
      } else {
        row[f] = val;
      }
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Query DuckDB via the coordinator, returning plain JS row objects.
 * This is the standard way to run a SELECT and get usable results.
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coord
 * @param {string} sql
 * @returns {Promise<object[]>}
 */
export async function queryRows(coord, sql) {
  const result = await coord.query(sql);
  return arrowTableToRows(result);
}

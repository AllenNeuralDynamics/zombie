/**
 * utils.js — Shared utility functions across the application.
 */

import Papa from 'papaparse';

export const PAGE_SIZE = 100;
export const SELECT_THRESHOLD = 40;

/**
 * Escape a string for safe inclusion in HTML text nodes and attribute values.
 * @param {string} str
 * @returns {string}
 */
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Format an ISO datetime string to "YYYY-MM-DD HH:MM" (UTC, no seconds).
 * @param {string|null} iso
 * @returns {string}
 */
export function formatDatetime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
           `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  } catch {
    return String(iso);
  }
}

/**
 * Format an ISO datetime string to "YYYY-MM-DD" (UTC, date only).
 * @param {string|null} iso
 * @returns {string}
 */
export function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  } catch {
    return String(iso);
  }
}

/**
 * Sort an array of row objects by a column in-place.
 * @param {object[]} rows
 * @param {string} col
 * @param {'asc'|'desc'} dir
 * @returns {object[]}
 */
export function sortRows(rows, col, dir) {
  rows.sort((a, b) => {
    const av = a[col] ?? '';
    const bv = b[col] ?? '';
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return rows;
}

/**
 * Collect unique non-null/non-empty values for a column, sorted lexicographically.
 * @param {object[]} rows
 * @param {string} col
 * @returns {string[]}
 */
export function uniqueValues(rows, col, { split = null } = {}) {
  const seen = new Set();
  for (const row of rows) {
    const v = row[col];
    if (v == null || v === '') continue;
    if (split) {
      for (const part of String(v).split(split).map((s) => s.trim()).filter(Boolean)) {
        seen.add(part);
      }
    } else {
      seen.add(String(v));
    }
  }
  return Array.from(seen).sort();
}

/**
 * Apply per-column filters to a row array. Text filters use case-insensitive substring match.
 * @param {object[]} rows
 * @param {Record<string, string>} filters
 * @returns {object[]}
 */
export function filterRows(rows, filters) {
  const entries = Object.entries(filters).filter(([, v]) => v !== '');
  if (entries.length === 0) return rows;
  return rows.filter((row) =>
    entries.every(([col, val]) => {
      const cell = String(row[col] ?? '').toLowerCase();
      return cell.includes(val.toLowerCase());
    }),
  );
}

/**
 * Shared regex (as a string) used by both the JS and SQL instrument-ID
 * normalisers. Keeping it in one place ensures they can never silently diverge.
 *
 * Pattern: ^<location>[_-]<name>_<date>$
 * where <date> is YYYYMMDD, YYYY-MM-DD, or YYMMDD (short year 23-26).
 */
export const INSTRUMENT_ID_REGEX =
  '^[^_-]+[_-](.+)_(\\d{8}|\\d{4}-\\d{2}-\\d{2}|2[3-6]\\d{4})$';

/**
 * Normalize a raw instrument_id by extracting just the <name> portion from
 * legacy naming patterns:
 *   <location>_<name>_<date>
 *   <location>-<name>_<date>
 *
 * where <date> is YYYYMMDD, YYYY-MM-DD, or YYMMDD (short year 23–26).
 * IDs that don't match are returned unchanged.
 * Spacer characters (- and _) are stripped from the result in both cases.
 *
 * @param {string|null} id
 * @returns {string}
 */
export function normalizeInstrumentId(id) {
  if (!id) return id ?? '';
  const m = String(id).match(new RegExp(INSTRUMENT_ID_REGEX));
  return (m ? m[1] : String(id)).replace(/[_-]/g, '');
}

/**
 * Return a DuckDB SQL expression that normalises an instrument_id column,
 * stripping the legacy <location>_<name>_<date> prefix/suffix and then
 * removing spacer characters (- and _).
 *
 * Uses the same regex as INSTRUMENT_ID_REGEX.
 *
 * @param {string} col - SQL column reference, e.g. 'instrument_id'
 * @returns {string} SQL expression
 */
export function normalizeInstrumentIdSql(col) {
  return `regexp_replace(
    COALESCE(
      NULLIF(
        regexp_extract(
          COALESCE(${col}, ''),
          '${INSTRUMENT_ID_REGEX}',
          1
        ),
        ''
      ),
      ${col},
      '(unknown)'
    ),
    '[_-]', '', 'g'
  )`;
}

/**
 * Normalize a single person/experimenter/trainer name:
 *  1. Replace non-alphanumeric/non-space chars (dots, underscores, etc.) with a space
 *  2. Collapse multiple spaces and strip leading/trailing whitespace
 *  3. Lowercase everything
 *  4. Re-capitalize the first letter of each word (title case)
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeName(name) {
  return String(name)
    .replace(/[^a-zA-Z0-9 ]/g, ' ')   // special chars -> space
    .replace(/\s+/g, ' ')              // collapse whitespace
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase()); // title case
}

/**
 * Merge key for deduplication: lowercase with all spaces removed.
 * "John Doe" and "JohnDoe" both produce "johndoe".
 *
 * @param {string} displayName - Already normalized display name.
 * @returns {string}
 */
export function mergeKey(displayName) {
  return displayName.toLowerCase().replace(/ /g, '');
}

/**
 * Parse a comma-separated experimenter/trainer field into an array of
 * deduplicated, normalized display names.
 *
 * @param {string|null} val
 * @returns {string[]}
 */
export function parseExperimenters(val) {
  if (!val) return [];
  const seen = new Set();
  const result = [];
  for (const part of String(val).split(',')) {
    const normalized = normalizeName(part);
    if (normalized && !seen.has(mergeKey(normalized))) {
      seen.add(mergeKey(normalized));
      result.push(normalized);
    }
  }
  return result;
}

/**
 * Collect unique experimenter display names from rows, deduplicated by
 * mergeKey, sorted alphabetically. Reads the `experimenters` column.
 *
 * @param {object[]} rows
 * @returns {string[]}
 */
export function uniqueExperimenters(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    for (const name of parseExperimenters(row.experimenters)) {
      const key = mergeKey(name);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(name);
      }
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

/**
 * Generate a CSV file and trigger download using papaparse.
 * @param {string} filename
 * @param {string[]} headers
 * @param {Array<string[]>} dataRows
 */
export function downloadCsv(filename, headers, dataRows) {
  const csv = Papa.unparse([headers, ...dataRows]);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

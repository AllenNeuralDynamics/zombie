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
 * Format an ISO datetime string to "YYYY-MM-DD HH:MM" by reading the
 * wall-clock digits directly from the string — no timezone conversion.
 * @param {string|null} iso
 * @returns {string}
 */
export function formatDatetimeRaw(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(iso);
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
 * Handles both array-typed values (parquet list columns) and optionally
 * splitting string values by a delimiter.
 * @param {object[]} rows
 * @param {string} col
 * @returns {string[]}
 */
export function uniqueValues(rows, col, { split = null } = {}) {
  const seen = new Set();
  for (const row of rows) {
    const v = row[col];
    if (v == null || v === '') continue;
    if (Array.isArray(v)) {
      for (const item of v) {
        const s = String(item).trim();
        if (s) seen.add(s);
      }
    } else if (split) {
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
 * Array-valued cells are joined with ', ' before matching.
 * @param {object[]} rows
 * @param {Record<string, string>} filters
 * @returns {object[]}
 */
export function filterRows(rows, filters) {
  const entries = Object.entries(filters).filter(([, v]) => v !== '');
  if (entries.length === 0) return rows;
  return rows.filter((row) =>
    entries.every(([col, val]) => {
      const raw = row[col];
      const cell = (Array.isArray(raw) ? raw.join(', ') : String(raw ?? '')).toLowerCase();
      return cell.includes(val.toLowerCase());
    }),
  );
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
 * Parse an experimenter field (array or comma-separated string) into an array
 * of deduplicated display names.
 *
 * @param {string|string[]|null} val
 * @returns {string[]}
 */
export function parseExperimenters(val) {
  if (!val) return [];
  const parts = Array.isArray(val) ? val : String(val).split(',');
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    const trimmed = String(part).trim();
    if (trimmed && !seen.has(mergeKey(trimmed))) {
      seen.add(mergeKey(trimmed));
      result.push(trimmed);
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
 * Aggregate raw session rows by experimenter and optionally filter to a
 * selected set.  The `experimenters` field may be a comma-separated raw
 * string such as `"anna.katelyn.mcdougal, nick.ponvert"` — it is parsed and
 * normalised by `parseExperimenters` before comparison.
 *
 * @param {Array<{experimenters: string|null, session_seconds: number|string|null}>} rawRows
 * @param {Set<string>|null} selectedExperimenters
 *   Normalised display names to include (produced by `parseExperimenters`),
 *   or `null` to include all.
 * @returns {Array<{group: string, sessionCount: number, totalSeconds: number}>}
 *   Sorted descending by sessionCount.
 */
export function aggregateByExperimenter(rawRows, selectedExperimenters) {
  const expMap = new Map();
  for (const r of rawRows) {
    const exps = parseExperimenters(r.experimenters);
    const secs = Number(r.session_seconds ?? 0);
    if (exps.length === 0) {
      const entry = expMap.get('(none)') ?? { sessionCount: 0, totalSeconds: 0 };
      entry.sessionCount++;
      entry.totalSeconds += secs;
      expMap.set('(none)', entry);
    } else {
      for (const exp of exps) {
        const entry = expMap.get(exp) ?? { sessionCount: 0, totalSeconds: 0 };
        entry.sessionCount++;
        entry.totalSeconds += secs;
        expMap.set(exp, entry);
      }
    }
  }

  let rows = [...expMap.entries()].map(([group, d]) => ({
    group,
    sessionCount: d.sessionCount,
    totalSeconds: d.totalSeconds,
  }));
  rows.sort((a, b) => b.sessionCount - a.sessionCount);

  if (selectedExperimenters !== null) {
    const allowedKeys = new Set([...selectedExperimenters].map(mergeKey));
    rows = rows.filter(
      (r) => r.group === '(none)' || allowedKeys.has(mergeKey(r.group)),
    );
  }

  return rows;
}

/**
 * Aggregate raw session rows by project, optionally filtered to a selected
 * set of experimenters.  Each raw row must have:
 *   - group_key: project name (already COALESCE'd to '(none)')
 *   - experimenters: comma-separated display names, or null
 *   - session_seconds: session duration in seconds
 *
 * Experimenter filtering happens in JS rather than SQL because
 * experimenters_normalized is a VARCHAR[] in DuckDB and LIKE on arrays
 * throws a Binder Error.
 *
 * @param {Array<{group_key: string, experimenters: string|null, session_seconds: number|string|null}>} rawRows
 * @param {Set<string>|null} selectedExperimenters
 *   Normalised display names to include, or null to include all.
 * @returns {Array<{group: string, sessionCount: number, totalSeconds: number}>}
 *   Sorted descending by sessionCount.
 */
export function aggregateByProject(rawRows, selectedExperimenters) {
  const allowedKeys = selectedExperimenters
    ? new Set([...selectedExperimenters].map(mergeKey))
    : null;
  const projMap = new Map();
  for (const r of rawRows) {
    if (allowedKeys) {
      const exps = parseExperimenters(r.experimenters);
      if (exps.length === 0 || !exps.some((e) => allowedKeys.has(mergeKey(e)))) continue;
    }
    const key = r.group_key ?? '(none)';
    const entry = projMap.get(key) ?? { sessionCount: 0, totalSeconds: 0 };
    entry.sessionCount++;
    entry.totalSeconds += Number(r.session_seconds ?? 0);
    projMap.set(key, entry);
  }
  return [...projMap.entries()]
    .map(([group, d]) => ({ group, sessionCount: d.sessionCount, totalSeconds: d.totalSeconds }))
    .sort((a, b) => b.sessionCount - a.sessionCount);
}

/**
 * Normalise a raw `protocol_id` value to a canonical `https://dx.doi.org/…` URL.
 *
 * Handled input formats:
 *   "dx.doi.org/10.17504/protocols.io.SLUG/vN"
 *   "https://dx.doi.org/10.17504/protocols.io.SLUG/vN"
 *   "10.17504/protocols.io.SLUG/vN"
 *   "protocols.io.SLUG/vN"   (shorthand without DOI prefix)
 *   "https://www.protocols.io/view/SLUG"
 *
 * @param {string|null|undefined} raw
 * @returns {string|null} Canonical URL, or null if not recognisable.
 */
export function normalizeProtocolId(raw) {
  if (!raw) return null;
  let s = String(raw).trim();

  if (/^https?:\/\/(www\.)?protocols\.io\//i.test(s)) {
    return s;
  }

  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/^(dx\.doi\.org|doi\.org)\//i, '');

  if (/^protocols\.io\./i.test(s)) {
    s = `10.17504/${s}`;
  }

  if (/^10\.\d{4,}\//.test(s)) {
    return `https://dx.doi.org/${s}`;
  }

  return null;
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

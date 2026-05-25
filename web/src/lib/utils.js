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

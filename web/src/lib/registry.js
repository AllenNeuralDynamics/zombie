/**
 * lib/registry.js — Centralized DuckDB table registration.
 *
 * After `fetchAndRegisterMetadata` completes, all acorn definitions are stored
 * here. Any module can call `ensureTable(coord, 'table_name')` to guarantee
 * the table is registered in DuckDB — no URL construction needed.
 *
 * @module
 */

import { registerAcornTable } from './metadata.js';

// ---------------------------------------------------------------------------
// Module state — populated by setMetadata() during bootstrap
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} acornName → acorn definition */
const _acornMap = new Map();

/** @type {Map<string, Promise<void>>} acornName → registration promise (singleton) */
const _tablePromises = new Map();

// ---------------------------------------------------------------------------
// Setup (called once from bootstrap)
// ---------------------------------------------------------------------------

/**
 * Store the loaded metadata so ensureTable can look up acorn definitions.
 * Called automatically by `bootstrap()` after `fetchAndRegisterMetadata`.
 *
 * @param {{ acorns: object[] }} metadata
 */
export function setMetadata(metadata) {
  _acornMap.clear();
  _tablePromises.clear();
  for (const acorn of metadata.acorns) {
    _acornMap.set(acorn.name, acorn);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a table is registered in DuckDB.  Uses the acorn definition from
 * cache_registry.json — no hardcoded URLs needed.
 *
 * Safe to call multiple times — returns the same promise on subsequent calls
 * for the same table name (singleton pattern).
 *
 * @param {import('@uwdata/mosaic-core').Coordinator} coord
 * @param {string} name - The acorn/table name (e.g. 'platform_fib', 'metadata_upgrade').
 * @param {object} [opts]
 * @param {string[]|null} [opts.subjectIds] - Restrict asset tables to these subject_ids.
 * @returns {Promise<void>}
 */
export function ensureTable(coord, name, { subjectIds = null } = {}) {
  // If no subject filter, use the singleton promise
  if (!subjectIds) {
    if (!_tablePromises.has(name)) {
      const acorn = _acornMap.get(name);
      if (!acorn) {
        return Promise.reject(new Error(`[registry] Unknown acorn: "${name}". Available: ${[..._acornMap.keys()].join(', ')}`));
      }
      const p = registerAcornTable(coord, acorn).catch((err) => {
        _tablePromises.delete(name); // allow retry on failure
        throw err;
      });
      _tablePromises.set(name, p);
    }
    return _tablePromises.get(name);
  }

  // With subject filter, always re-register (not cached)
  const acorn = _acornMap.get(name);
  if (!acorn) {
    return Promise.reject(new Error(`[registry] Unknown acorn: "${name}"`));
  }
  return registerAcornTable(coord, acorn, { subjectIds });
}

/**
 * Get an acorn definition by name.
 *
 * @param {string} name
 * @returns {object|undefined}
 */
export function getAcorn(name) {
  return _acornMap.get(name);
}

/**
 * Get all acorn definitions.
 *
 * @returns {object[]}
 */
export function getAllAcorns() {
  return [..._acornMap.values()];
}

/**
 * Get acorns filtered by type.
 *
 * @param {string} type - e.g. 'metadata', 'asset', 'platform'
 * @returns {object[]}
 */
export function getAcornsByType(type) {
  return [..._acornMap.values()].filter((a) => a.type === type);
}

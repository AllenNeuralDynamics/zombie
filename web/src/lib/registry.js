/**
 * lib/registry.js — Centralized DuckDB table registration.
 *
 * After `fetchAndRegisterMetadata` completes, all acorn definitions are stored
 * here. Any module can call `ensureTable(coord, 'table_name')` to guarantee
 * the table is registered in DuckDB — no URL construction needed.
 *
 * @module
 */

import { dropAcornTable, registerAcornTable } from './metadata.js';

// ---------------------------------------------------------------------------
// Module state — populated by setMetadata() during bootstrap
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} acornName → acorn definition */
const _acornMap = new Map();

/** @type {Map<string, { promise: Promise<string>, physicalName: string, scoped: boolean }>} */
const _tablePromises = new Map();

function hashRegistrationKey(value) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export function normalizeRegistrationOptions(name, { subjectIds = null } = {}) {
  if (subjectIds === null || subjectIds === undefined) {
    return { key: JSON.stringify([name, null]), subjectIds: null, physicalName: name };
  }
  if (!Array.isArray(subjectIds)) {
    throw new TypeError('subjectIds must be an array or null');
  }
  const normalizedSubjectIds = [...new Set(subjectIds.map(String))].sort();
  const key = JSON.stringify([name, normalizedSubjectIds]);
  return {
    key,
    subjectIds: normalizedSubjectIds,
    physicalName: `${name}__scope_${hashRegistrationKey(key)}`,
  };
}

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
 * @returns {Promise<string>} The physical table name to query.
 */
export function ensureTable(coord, name, { subjectIds = null } = {}) {
  const acorn = _acornMap.get(name);
  if (!acorn) {
    return Promise.reject(new Error(`[registry] Unknown acorn: "${name}". Available: ${[..._acornMap.keys()].join(', ')}`));
  }
  const registration = normalizeRegistrationOptions(name, { subjectIds });
  if (!_tablePromises.has(registration.key)) {
    const promise = registerAcornTable(coord, acorn, {
      subjectIds: registration.subjectIds,
      targetName: registration.physicalName,
    }).catch((err) => {
      _tablePromises.delete(registration.key);
      throw err;
    });
    _tablePromises.set(registration.key, {
      promise,
      physicalName: registration.physicalName,
      scoped: registration.subjectIds !== null,
    });
  }
  return _tablePromises.get(registration.key).promise;
}

/**
 * Release a scoped registration after its consumers have finished querying it.
 * Canonical unfiltered registrations are never released by this API.
 */
export async function releaseTable(coord, name, options) {
  const registration = normalizeRegistrationOptions(name, options);
  const entry = _tablePromises.get(registration.key);
  if (!entry?.scoped) return false;
  await entry.promise;
  await dropAcornTable(coord, entry.physicalName);
  _tablePromises.delete(registration.key);
  return true;
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

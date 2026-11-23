/**
 * lib/platform-overview/helpers.js — Shared helpers for the platform overview
 * dropdowns and settings modal.
 *
 * @module
 */

/** Read a cookie value by name, or null if absent. */
export function readCookie(name) {
  const m = ('; ' + document.cookie).split(`; ${name}=`);
  if (m.length < 2) return null;
  return decodeURIComponent(m.pop().split(';')[0]);
}

/** Write a persistent cookie (1-year expiry, SameSite=Lax). */
export function writeCookie(name, value) {
  const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
}

/**
 * Build a SQL WHERE fragment for an asset filter spec
 * ({ type, value, excludeInstrumentIds? }) over asset_basics columns.
 */
export function buildFilterCondition(assetFilter) {
  return baseFilterCondition(assetFilter) + buildInstrumentExclusion(assetFilter);
}

function baseFilterCondition(assetFilter) {
  if (!assetFilter) return '1=1';
  const safeVal = String(assetFilter.value ?? '').replace(/'/g, "''");
  if (assetFilter.type === 'modality') return `list_contains(modalities, '${safeVal}')`;
  if (assetFilter.type === 'acquisition_type') return `acquisition_type = '${safeVal}'`;
  if (assetFilter.type === 'acquisition_type_regex') return `regexp_matches(acquisition_type, '${safeVal}')`;
  if (assetFilter.type === 'instrument_id_contains') return `instrument_id IS NOT NULL AND instrument_id ILIKE '%${safeVal}%'`;
  if (assetFilter.type === 'project_name') return `project_name = '${safeVal}'`;
  return '1=1';
}

/**
 * ` AND …` fragment dropping assets on assetFilter.excludeInstrumentIds, or ''
 * when there are none. With `nameCol`, matches that asset-name column against
 * asset_basics (for tables without instrument_id); otherwise filters
 * asset_basics' own instrument_id.
 */
export function buildInstrumentExclusion(assetFilter, { nameCol = null } = {}) {
  const ids = assetFilter?.excludeInstrumentIds ?? [];
  if (!ids.length) return '';
  const inList = ids.map((s) => `'${String(s).replace(/'/g, "''")}'`).join(', ');
  if (!nameCol) return ` AND (instrument_id IS NULL OR instrument_id NOT IN (${inList}))`;
  // name IS NOT NULL: a NULL in a NOT IN subquery would reject every row.
  return ` AND ${nameCol} NOT IN (SELECT name FROM asset_basics WHERE name IS NOT NULL AND instrument_id IN (${inList}))`;
}

/** Validate that a value is a YYYY-MM-DD date string before interpolating into SQL. */
export const isValidDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

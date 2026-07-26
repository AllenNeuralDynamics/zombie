/**
 * lib/raw-to-derived.js — the canonical way to find a derived asset from a raw
 * acquisition.
 *
 * The subject timeline only carries raw acquisitions. Derived assets record
 * their inputs in the `source_data` table (`source_data.source_data` is a
 * comma+space-joined list of raw source names). To go raw → derived we reverse
 * that mapping, join `asset_basics` for the derived asset's metadata, filter by
 * modality, and take the most recently processed run (assets get reprocessed,
 * so `processing_time DESC` skips stale runs).
 *
 * This is ALWAYS how derived assets should be resolved — never by guessing at
 * `<raw>_processed_%` name patterns (a raw can have several derived assets of
 * the same modality, and the naming is not reliable).
 */

import { ensureTable } from './registry.js';
import { queryRows } from './arrow.js';

function esc(s) {
  return String(s).replace(/'/g, "''");
}

/**
 * Resolve the latest derived asset for a raw acquisition, optionally filtered
 * by modality.
 *
 * @param {object} coord - DuckDB coordinator.
 * @param {string} rawAssetName - Raw acquisition asset name.
 * @param {object} [opts]
 * @param {string} [opts.modality] - Required modality (exact element of the
 *   `modalities` list, e.g. 'behavior', 'pophys', 'fib').
 * @returns {Promise<{name:string, location:string}|null>}
 */
export async function resolveLatestDerived(coord, rawAssetName, { modality } = {}) {
  if (!coord || !rawAssetName) return null;
  try {
    await ensureTable(coord, 'source_data');
    const safe = esc(rawAssetName);
    const modCond = modality
      ? `AND list_contains(ab.modalities, '${esc(modality)}')`
      : '';
    const rows = await queryRows(coord, `
      SELECT ab.name, ab.location
      FROM source_data sd
      JOIN asset_basics ab ON ab.name = sd.name
      WHERE ('; ' || replace(sd.source_data, ', ', '; ') || ';') LIKE '%; ${safe};%'
        AND ab.data_level = 'derived'
        ${modCond}
      ORDER BY sd.processing_time DESC
      LIMIT 1
    `);
    return rows[0] ?? null;
  } catch (err) {
    console.error(`[raw-to-derived] resolve failed for "${rawAssetName}" (${modality ?? 'any'})`, err);
    return null;
  }
}

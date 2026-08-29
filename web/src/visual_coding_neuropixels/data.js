/**
 * Visual Coding Neuropixels unit-location adapter.
 *
 * These SWDB assets are AllenSDK ecephys sessions re-published as AIND-format
 * derived NWB-Zarr on aind-open-data — the same asset layout Dynamic Routing
 * uses, so the NWB-Zarr root is resolved with the same helper
 * (resolveNwbZarrBase). Only the `units/` schema differs: field names come
 * from the AllenSDK ecephys session, and probe identity is a numeric
 * `ecephys_probe_id` rather than a name, so it is resolved against each
 * probe's electrode-group `.zattrs` sidecar to get a display name like
 * "probeA".
 */

import * as zarr from 'zarrita';
import { assertRasterAssetName, resolveNwbZarrBase } from '../dynamic_routing_raster/data.js';
import { loadSwdbUnitLocations } from '../swdb/data.js';
import { ensureTable } from '../lib/registry.js';
import { queryRows } from '../lib/arrow.js';
import { quoteIdentifier } from '../lib/metadata.js';

const OPEN_DATA_BASE = 'https://aind-open-data.s3.amazonaws.com';

// Precomputed by biodata-cache (platform_visual_coding_neuropixels_units):
// one row per unit across the whole public collection, CCF coordinates
// already mirrored to the ccf_ml convention below. The overview always wants
// every session's units at once, so this single small table replaces
// hundreds of live per-session NWB-Zarr + probe-name-lookup requests.
const UNIT_LOCATIONS_CACHE_TABLE = 'platform_visual_coding_neuropixels_units';

const UNIT_LOCATION_COLUMNS = [
  'id', 'ecephys_probe_id', 'ecephys_structure_acronym',
  'anterior_posterior_ccf_coordinate', 'dorsal_ventral_ccf_coordinate',
  'left_right_ccf_coordinate',
];

function toNumber(value) {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asString(value) {
  return value == null ? null : String(value);
}

// AllenSDK's `left_right_ccf_coordinate` follows the raw CCFv3 volume axis
// (small = left, large = right, midline at 5700 µm). The shared CCF→three.js
// transform (subject/brain-viz-3d.js, reused unchanged by
// dynamic_routing_raster/unit-viz-3d.js) instead expects Dynamic Routing's
// `ccf_ml` convention, which runs the opposite way (small = right). Mirror
// the raw coordinate across the midline so both datasets land in the correct
// hemisphere in the shared viewer.
const CCF_ML_MIDLINE_UM = 5700;

function mirrorCcfMl(value) {
  const number = toNumber(value);
  return number == null ? null : 2 * CCF_ML_MIDLINE_UM - number;
}

/**
 * Resolve each probe group's display name (e.g. "probeA") against its
 * numeric `probe_id`. There is no per-unit probe-name field in the units
 * table, only the numeric id that each electrode group's `.zattrs` sidecar
 * also carries, so the small group list + sidecars are read once per asset.
 *
 * @param {string} base - Resolved NWB-Zarr root (no trailing slash).
 * @param {AbortSignal} [signal]
 * @returns {Promise<Map<number, string>>}
 */
async function loadProbeNamesByProbeId(base, signal) {
  const key = `${base.slice(`${OPEN_DATA_BASE}/`.length)}/general/extracellular_ephys/`;
  const url = `${OPEN_DATA_BASE}/?list-type=2&prefix=${encodeURIComponent(key)}`
    + `&delimiter=${encodeURIComponent('/')}&max-keys=1000`;
  const response = await fetch(url, { signal });
  if (!response.ok) return new Map();
  const xml = await response.text();
  const groupNames = [...xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)]
    .map((match) => match[1].slice(key.length).replace(/\/$/, ''))
    // `electrodes` is the merged electrode table, not an electrode group.
    .filter((name) => name && name !== 'electrodes');

  const entries = await Promise.all(groupNames.map(async (name) => {
    try {
      const attrsResponse = await fetch(`${OPEN_DATA_BASE}/${key}${name}/.zattrs`, { signal });
      if (!attrsResponse.ok) return null;
      const attrs = await attrsResponse.json();
      return attrs?.probe_id != null ? [Number(attrs.probe_id), name] : null;
    } catch {
      return null;
    }
  }));
  return new Map(entries.filter(Boolean));
}

async function readUnitColumn(root, column, signal) {
  const array = await zarr.open(root.resolve(`units/${column}`), { kind: 'array' });
  const chunk = await zarr.get(array, null, { signal });
  return Array.from(chunk.data);
}

/**
 * Load the CCF unit-location catalog for one Visual Coding Neuropixels
 * derived asset. Returns the same shape as
 * dynamic_routing_raster's loadRasterUnitLocations, so it plugs into the
 * same 3D viewer (createEphysUnitViz3D) and SWDB overview aggregation
 * (loadSwdbUnitLocations) unchanged.
 *
 * @param {string} asset - Public derived ecephys asset name.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<object[]>}
 */
export async function loadVisualCodingNeuropixelsUnitLocations(asset, { signal } = {}) {
  const key = assertRasterAssetName(asset);
  const base = await resolveNwbZarrBase(key, { signal });
  const root = zarr.root(new zarr.FetchStore(base));

  const [columnEntries, probeNames] = await Promise.all([
    Promise.all(UNIT_LOCATION_COLUMNS.map(async (column) => (
      [column, await readUnitColumn(root, column, signal)]
    ))),
    loadProbeNamesByProbeId(base, signal),
  ]);
  if (signal?.aborted) throw new Error('aborted');
  const columns = Object.fromEntries(columnEntries);
  const n = columns.id?.length ?? 0;

  return Array.from({ length: n }, (_, index) => {
    const probeId = toNumber(columns.ecephys_probe_id?.[index]);
    const probeName = probeNames.get(probeId) ?? (probeId != null ? `probe ${probeId}` : 'unknown probe');
    return {
      key: `raw:${index}`,
      unitName: asString(columns.id?.[index]) ?? `unit-${index}`,
      deviceName: probeName,
      probeName,
      structure: asString(columns.ecephys_structure_acronym?.[index]),
      location: null,
      ccfAp: toNumber(columns.anterior_posterior_ccf_coordinate?.[index]),
      ccfDv: toNumber(columns.dorsal_ventral_ccf_coordinate?.[index]),
      ccfMl: mirrorCcfMl(columns.left_right_ccf_coordinate?.[index]),
    };
  });
}

function sqlStr(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function toCacheUnit(row, asset, acquisitionLabel, index) {
  return {
    key: `vcn:${asset}:cache:${index}`,
    unitName: String(row.unit_id),
    deviceName: row.probe_name,
    probeName: row.probe_name,
    structure: row.structure,
    location: null,
    ccfAp: toNumber(row.ccf_ap),
    ccfDv: toNumber(row.ccf_dv),
    ccfMl: toNumber(row.ccf_ml),
    acquisition: asset,
    acquisitionLabel,
  };
}

/**
 * Load the CCF unit locations for every acquisition in the Visual Coding
 * Neuropixels SWDB dataset.
 *
 * Reads the precomputed `platform_visual_coding_neuropixels_units` cache
 * table (a single small parquet covering every session) instead of the live
 * per-asset NWB-Zarr path whenever it is available; any asset missing from
 * the cache (e.g. one added after the last cache build) falls back to
 * {@link loadVisualCodingNeuropixelsUnitLocations}.
 *
 * @param {object[]} sessionRows - Rows from the dataset's asset catalog.
 * @param {{ coord?: object, signal?: AbortSignal }} [options]
 * @returns {Promise<{units: object[], failedAssets: object[]}>}
 */
export async function loadVisualCodingNeuropixelsUnits(sessionRows, { coord = null, signal } = {}) {
  const rows = [...(sessionRows ?? [])]
    .filter((row) => row.asset_name)
    .sort((a, b) => String(a.asset_name).localeCompare(String(b.asset_name)));
  if (rows.length === 0) return { units: [], failedAssets: [] };

  const acquisitionLabelByAsset = new Map(rows.map((row) => [
    row.asset_name,
    [row.session_date, row.subject_id]
      .filter((value) => value != null && value !== '')
      .join(' · ') || row.asset_name,
  ]));

  let cacheUnitsByAsset = new Map();
  if (coord) {
    try {
      const table = await ensureTable(coord, UNIT_LOCATIONS_CACHE_TABLE);
      const cacheRows = await queryRows(
        coord,
        `SELECT asset_name, unit_id, probe_name, structure, ccf_ap, ccf_dv, ccf_ml
         FROM ${quoteIdentifier(table)}
         WHERE asset_name IN (${rows.map((row) => sqlStr(row.asset_name)).join(', ')})`,
      );
      for (const row of cacheRows) {
        if (!cacheUnitsByAsset.has(row.asset_name)) cacheUnitsByAsset.set(row.asset_name, []);
        cacheUnitsByAsset.get(row.asset_name).push(row);
      }
    } catch (error) {
      console.warn('[visual-coding-neuropixels] unit-location cache lookup failed; falling back to live NWB-Zarr', error);
      cacheUnitsByAsset = new Map();
    }
  }
  if (signal?.aborted) throw new Error('aborted');

  const cachedUnits = [];
  const missingRows = [];
  for (const row of rows) {
    const cached = cacheUnitsByAsset.get(row.asset_name);
    if (!cached) {
      missingRows.push(row);
      continue;
    }
    const acquisitionLabel = acquisitionLabelByAsset.get(row.asset_name);
    cached.forEach((unitRow, index) => {
      if (![unitRow.ccf_ap, unitRow.ccf_dv, unitRow.ccf_ml].every(Number.isFinite)) return;
      cachedUnits.push(toCacheUnit(unitRow, row.asset_name, acquisitionLabel, index));
    });
  }

  const live = await loadSwdbUnitLocations(
    missingRows, loadVisualCodingNeuropixelsUnitLocations, 'vcn', { signal },
  );
  return { units: [...cachedUnits, ...live.units], failedAssets: live.failedAssets };
}

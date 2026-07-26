/**
 * pophys/cache.js — load the precomputed pophys ROI / FOV cache.
 *
 * The heavy segmentation masks in the derived pophys NWB are far too large to
 * stream to the browser, so biodata-cache precomputes, per derived pophys
 * asset:
 *   - platform_pophys/asset_name=<asset>/data.pqt  — one row per ROI with a
 *     simplified polygon `contour` (JSON, 512×512 FOV pixel coords), centroid,
 *     area, is_soma / soma_probability.
 *   - pophys_fov/<asset>/<plane>_{max,avg}.png       — normalized FOV images.
 *
 * `roi_id` equals the ROI's column index in the NWB RoiResponseSeries `data`
 * (verified: rois == roi_table id == 0..N), so a clicked contour maps directly
 * to a trace column (see nwb-traces.js).
 */

import { DATA_CACHE_PREFIX } from '../constants.js';
import { getResolvedVersion } from '../lib/metadata.js';
import { queryRows } from '../lib/arrow.js';

/** URL of the per-asset ROI parquet. */
export function pophysRoiUrl(asset) {
  return `${DATA_CACHE_PREFIX}/${getResolvedVersion()}/platform_pophys/asset_name=${asset}/data.pqt`;
}

/** URL of a FOV projection PNG ('max' | 'avg'). */
export function fovUrl(asset, plane, kind = 'max') {
  return `${DATA_CACHE_PREFIX}/${getResolvedVersion()}/pophys_fov/${asset}/${plane}_${kind}.png`;
}

/** Parse "VISp_3" → { structure: 'VISp', index: 3 } (index sorts the planes). */
export function parsePlaneName(plane) {
  const m = String(plane).match(/^([A-Za-z]+)_?(\d+)?$/);
  return { structure: m?.[1] ?? plane, index: m?.[2] != null ? Number(m[2]) : 0 };
}

/**
 * Load the ROI cache for one derived pophys asset, grouped by plane.
 *
 * @returns {Promise<{planes: Array<{plane, structure, index, rois: object[]}>}>}
 */
export async function loadPophysRois(coord, asset) {
  const url = pophysRoiUrl(asset).replace(/'/g, "''");
  const rows = await queryRows(
    coord,
    `SELECT plane, roi_id, is_soma, soma_probability, centroid_x, centroid_y, area_px, contour
     FROM read_parquet('${url}')
     ORDER BY plane, roi_id`,
  );

  const byPlane = new Map();
  for (const r of rows) {
    let contour = [];
    try { contour = JSON.parse(r.contour); } catch { contour = []; }
    const roi = {
      id: Number(r.roi_id),
      isSoma: Number(r.is_soma) === 1,
      somaProb: r.soma_probability != null ? Number(r.soma_probability) : null,
      cx: Number(r.centroid_x),
      cy: Number(r.centroid_y),
      area: Number(r.area_px),
      contour,
    };
    if (!byPlane.has(r.plane)) byPlane.set(r.plane, []);
    byPlane.get(r.plane).push(roi);
  }

  const planes = [...byPlane.entries()]
    .map(([plane, rois]) => ({ plane, ...parsePlaneName(plane), rois }))
    .sort((a, b) => (a.structure === b.structure ? a.index - b.index : a.structure.localeCompare(b.structure)));

  return { planes };
}

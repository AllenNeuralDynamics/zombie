/** Visual Coding Ophys cache access. */

import { DATA_CACHE_PREFIX } from '../constants.js';
import { getResolvedVersion } from '../lib/metadata.js';
import { queryRows } from '../lib/arrow.js';

function assertAssetName(asset) {
  if (!/^[A-Za-z0-9_.-]+$/.test(asset ?? '')) {
    throw new Error(`Invalid Visual Coding Ophys asset name: ${asset}`);
  }
  return asset;
}

export function visualCodingOphysRoiUrl(asset) {
  return `${DATA_CACHE_PREFIX}/${getResolvedVersion()}/platform_visual_coding_ophys/asset_name=${assertAssetName(asset)}/data.pqt`;
}

export function visualCodingOphysFovUrl(asset, kind = 'max') {
  const safeKind = kind === 'max' ? kind : 'max';
  return `${DATA_CACHE_PREFIX}/${getResolvedVersion()}/visual_coding_ophys_fov/${assertAssetName(asset)}/${safeKind}.png`;
}

export async function loadVisualCodingOphysRois(coord, asset) {
  const url = visualCodingOphysRoiUrl(asset).replace(/'/g, "''");
  const rows = await queryRows(
    coord,
    `SELECT plane, roi_id, global_roi_id, structure, depth_um, imaging_rate,
            centroid_x, centroid_y, area_px, contour
     FROM read_parquet('${url}')
     ORDER BY roi_id`,
  );
  return rows.map((row) => {
    let contour = [];
    try { contour = JSON.parse(row.contour); } catch { /* malformed cache row */ }
    return {
      plane: row.plane,
      id: Number(row.roi_id),
      globalId: Number(row.global_roi_id),
      structure: row.structure ?? null,
      depthUm: row.depth_um != null ? Number(row.depth_um) : null,
      imagingRate: row.imaging_rate != null ? Number(row.imaging_rate) : null,
      cx: Number(row.centroid_x),
      cy: Number(row.centroid_y),
      area: Number(row.area_px),
      contour,
    };
  });
}

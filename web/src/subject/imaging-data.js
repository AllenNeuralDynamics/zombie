/**
 * imaging-data.js — Pure extraction of ImagingConfig info from acquisition metadata.
 *
 * Kept free of three.js so the subject details panel can decide whether imaging
 * data exists WITHOUT pulling the heavy 3D viewer (imaging-viz-3d.js) into the
 * page's initial bundle. The 3D viewer imports these helpers and is itself
 * loaded on demand.
 *
 * @module
 */

/**
 * Check whether acquisition data contains at least one Imaging config.
 * @param {object} acquisitionData
 * @returns {boolean}
 */
export function hasImagingConfig(acquisitionData) {
  for (const stream of (acquisitionData?.data_streams ?? [])) {
    for (const cfg of (stream?.configurations ?? [])) {
      if (cfg?.object_type === 'Imaging config') return true;
    }
  }
  return false;
}

/**
 * Extract imaging plane info from an acquisition object's ImagingConfig entries.
 *
 * @param {object} acquisitionData
 * @returns {{ configs: Array, planes: Array, structures: Array }}
 */
export function extractImagingData(acquisitionData) {
  const configs = [];
  const planes = [];
  const structureMap = new Map();

  for (const stream of (acquisitionData?.data_streams ?? [])) {
    for (const cfg of (stream?.configurations ?? [])) {
      if (cfg?.object_type !== 'Imaging config') continue;

      configs.push(cfg);

      for (const img of (cfg.images ?? [])) {
        // Parse dimension from string representation (may be an object or string)
        let dimX = null, dimY = null;
        const rawDim = img.dimensions;
        if (rawDim && typeof rawDim === 'object' && Array.isArray(rawDim.scale)) {
          dimX = rawDim.scale[0];
          dimY = rawDim.scale[1];
        } else {
          const dimStr = typeof rawDim === 'string' ? rawDim : (rawDim != null ? JSON.stringify(rawDim) : '');
          const scaleMatch = dimStr.match(/scale=\[([\d.]+),\s*([\d.]+)\]/);
          if (scaleMatch) {
            dimX = parseFloat(scaleMatch[1]);
            dimY = parseFloat(scaleMatch[2]);
          }
        }

        for (const plane of (img.planes ?? [])) {
          const struct = plane.targeted_structure;
          if (struct?.id) {
            structureMap.set(String(struct.id), struct);
          }

          // relative_position is an optional string (e.g. "left", "right") or
          // array of strings that disambiguates hemisphere when the targeted
          // structure is bilateral. Normalised to lowercase string or null.
          const relPos = plane.relative_position;
          const relativePosition = relPos == null ? null
            : (Array.isArray(relPos) ? relPos[0] : relPos)?.toLowerCase?.() ?? null;

          planes.push({
            channelName: img.channel_name ?? '',
            dimX,
            dimY,
            dimUnit: img.dimensions_unit ?? 'pixel',
            depth: plane.depth ?? 0,
            depthUnit: plane.depth_unit ?? 'micrometer',
            power: plane.power ?? null,
            powerUnit: plane.power_unit ?? '',
            structureId: struct?.id != null ? String(struct.id) : null,
            structureAcronym: struct?.acronym ?? '',
            structureName: struct?.name ?? '',
            relativePosition,
          });
        }
      }
    }
  }

  // Sort planes by depth (shallowest first)
  planes.sort((a, b) => a.depth - b.depth);

  return {
    configs,
    planes,
    structures: [...structureMap.values()],
  };
}

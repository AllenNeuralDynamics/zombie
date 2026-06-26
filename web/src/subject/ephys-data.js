/**
 * ephys-data.js — Pure extraction of ephys probe info from acquisition metadata.
 *
 * Kept free of three.js so the subject details panel can decide whether ephys
 * data exists and render the probe info cards WITHOUT pulling the heavy 3D
 * viewer (ephys-viz-3d.js) into the page's initial bundle. The 3D viewer
 * imports these helpers and is itself loaded on demand.
 *
 * @module
 */

import { parseTranslation, computeProbeDirection, computeProbeDirectionSteps } from '../lib/coord-systems.js';

/**
 * Extract all ephys probes from an acquisition data object.
 * Only processes the first data stream that has an "Ephys assembly config"
 * to avoid showing the same probe twice (some acquisitions have a
 * "surface finding" stream that duplicates the recording stream configs).
 *
 * @param {object} acquisitionData - The raw acquisition object.
 * @returns {Array<object>} Probe info objects.
 */
export function extractEphysProbes(acquisitionData) {
  const probes = [];

  for (const stream of (acquisitionData?.data_streams ?? [])) {
    const cfgs = (stream?.configurations ?? []).filter(
      (c) => c?.object_type === 'Ephys assembly config',
    );
    if (!cfgs.length) continue;

    for (const cfg of cfgs) {
      for (const probe of (cfg?.probes ?? [])) {
        const rawTransforms = probe?.transform ?? [];

        // Annotate the first Translation as intrinsic so it is applied in the
        // probe's local frame (manipulator position) rather than the world frame.
        // The metadata will carry this flag in the future; we inject it here in
        // the meantime to stay ahead of that change.
        let firstTranslationSeen = false;
        const transforms = rawTransforms.map((t) => {
          if (t?.object_type === 'Translation' && !firstTranslationSeen) {
            firstTranslationSeen = true;
            return { ...t, intrinsic: true };
          }
          return t;
        });

        // Full tip position in three.js space from the complete transform chain
        // (rotations pivot around Bregma, first translation is intrinsic, depth
        // moves the tip along −dir).
        const steps = computeProbeDirectionSteps(transforms);
        const tipPos = steps[steps.length - 1].pos;

        // Canonical ap/ml/depth for display: read from the last Translation in
        // the chain using the BREGMA_ARID index convention (v0=AP, v1=ML, v3=depth).
        const allTranslations = transforms.filter((t) => t?.object_type === 'Translation');
        const lastTranslation = allTranslations.at(-1) ?? null;
        const { ap, ml, depth } = parseTranslation(null, lastTranslation?.translation ?? []);

        // Probe direction from cumulative rotations.
        const probeDir = computeProbeDirection(transforms);

        // Targeted structures
        const primary = probe?.primary_targeted_structure ?? null;
        const others  = [].concat(probe?.other_targeted_structure ?? []).filter(Boolean);
        const structureIds = [
          primary?.id != null ? String(primary.id) : null,
          ...others.map((s) => (s?.id != null ? String(s.id) : null)),
        ].filter(Boolean);

        probes.push({
          name:            probe?.device_name ?? cfg?.device_name ?? 'Unknown',
          dye:             probe?.dye ?? null,
          notes:           probe?.notes ?? null,
          ap,
          ml,
          depth:           depth ?? 0,
          tipPos,
          probeDir,
          transforms,
          modules:         cfg?.modules ?? [],
          primaryStructure: primary,
          otherStructures:  others,
          structureIds,
        });
      }
    }

    // Only use the first stream that has ephys configs (skip duplicated surface-finding stream)
    if (probes.length) break;
  }

  return probes;
}

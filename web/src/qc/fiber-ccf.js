import { parseTranslation } from '../lib/coord-systems.js';

const OPEN_DATA_HTTPS = 'https://aind-open-data.s3.amazonaws.com';
const CCF_CONFIG_PATH = 'image_atlas_alignment/ccf_visualization/neuroglancer_config.json';
const SPIM_MODALITY = { name: 'Selective plane illumination microscopy', abbreviation: 'SPIM' };

export const FIBER_CCF_TAG = 'Fiber CCF Location';
export const FIBER_CCF_DESCRIPTION =
  'Location in the CCF-aligned SmartSPIM volume of the fiber probe tip in 25um index units';

export function fiberCcfMetricName(fiberName) {
  return `${fiberName} CCF Location`;
}

function isStitchedSpim(record) {
  const modalities = record?.data_description?.modalities ?? [];
  return /_stitched_/.test(record?.name ?? '') &&
    modalities.some(modality => modality?.abbreviation === 'SPIM');
}

function structureLabel(structure) {
  if (!structure?.name && !structure?.acronym) return null;
  if (structure.name && structure.acronym && structure.name !== structure.acronym) {
    return `${structure.name} (${structure.acronym})`;
  }
  return structure.name ?? structure.acronym;
}

function formatMm(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(3))) : null;
}

/** Targeted implant coordinates relative to the procedures' coordinate system origin. */
function targetedCoordinatesLabel(procedure, coordinateSystem) {
  const translation = (procedure?.device_config?.transform ?? [])
    .find(transform => transform?.object_type === 'Translation')?.translation;
  if (!Array.isArray(translation) || !translation.length) return null;
  const { ap, ml, dv, depth } = parseTranslation(coordinateSystem, translation);
  const parts = [['AP', ap], ['ML', ml], ['DV', dv], ['depth', depth]]
    .map(([axis, value]) => [axis, formatMm(value)])
    .filter(([, value]) => value !== null)
    .map(([axis, value]) => `${axis} ${value}`);
  const unit = coordinateSystem?.axis_unit === 'millimeter' || !coordinateSystem ? 'mm' : coordinateSystem.axis_unit;
  const origin = coordinateSystem?.origin ?? 'Bregma';
  return `${parts.join(', ')} ${unit} from ${origin}`;
}

/** Fiber probes implanted in this record's subject, in procedure order. */
export function fiberProbes(record) {
  const fibers = [];
  for (const surgery of record?.procedures?.subject_procedures ?? []) {
    const coordinateSystem = surgery?.coordinate_system ?? record?.procedures?.coordinate_system ?? null;
    for (const procedure of surgery?.procedures ?? []) {
      const device = procedure?.implanted_device;
      if (procedure?.object_type !== 'Probe implant' || device?.object_type !== 'Fiber probe') continue;
      if (!device.name || fibers.some(fiber => fiber.name === device.name)) continue;
      fibers.push({
        name: device.name,
        targetedStructure: structureLabel(procedure.device_config?.primary_targeted_structure),
        targetedCoordinates: targetedCoordinatesLabel(procedure, coordinateSystem),
      });
    }
  }
  return fibers;
}

/** Fibers still needing a CCF location metric; empty when the record does not qualify. */
export function missingFiberCcfProbes(record, existingNames = new Set()) {
  if (!isStitchedSpim(record)) return [];
  return fiberProbes(record).filter(fiber => !existingNames.has(fiberCcfMetricName(fiber.name)));
}

export function ccfConfigUrl(location) {
  const match = String(location ?? '').match(/^s3:\/\/([^/]+)\/(.+?)\/?$/);
  if (!match) throw new Error('Asset has no S3 location.');
  const base = match[1] === 'aind-open-data' ? OPEN_DATA_HTTPS : `https://${match[1]}.s3.amazonaws.com`;
  return `${base}/${match[2]}/${CCF_CONFIG_PATH}`;
}

export async function fetchCcfNeuroglancerLink(location, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(ccfConfigUrl(location));
  if (!response.ok) throw new Error(`CCF neuroglancer config not found (${response.status}).`);
  const link = (await response.json())?.ng_link;
  if (typeof link !== 'string' || !link) throw new Error('CCF neuroglancer config has no ng_link.');
  return link;
}

/** New-metric payloads for the QC submit API; the server stamps the Pending status. */
export function buildFiberCcfMetrics(fibers, ngLink) {
  return fibers.map(fiber => ({
    name: fiberCcfMetricName(fiber.name),
    modality: SPIM_MODALITY,
    stage: 'Processing',
    value: { AP: null, ML: null, DV: null },
    description: [
      FIBER_CCF_DESCRIPTION,
      `Targeted structure: ${fiber.targetedStructure ?? 'unknown'}`,
      `Targeted coordinates: ${fiber.targetedCoordinates ?? 'unknown'}`,
      'AP (x), DV (y), ML (z)',
    ].join('\n'),
    reference: ngLink,
    tags: { type: FIBER_CCF_TAG },
  }));
}

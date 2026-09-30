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

/** Fiber probe names implanted in this record's subject, in procedure order. */
export function fiberProbeNames(record) {
  const names = [];
  for (const surgery of record?.procedures?.subject_procedures ?? []) {
    for (const procedure of surgery?.procedures ?? []) {
      const device = procedure?.implanted_device;
      if (procedure?.object_type !== 'Probe implant' || device?.object_type !== 'Fiber probe') continue;
      if (device.name && !names.includes(device.name)) names.push(device.name);
    }
  }
  return names;
}

/** Fibers still needing a CCF location metric; empty when the record does not qualify. */
export function missingFiberCcfNames(record, existingNames = new Set()) {
  if (!isStitchedSpim(record)) return [];
  return fiberProbeNames(record).filter(fiber => !existingNames.has(fiberCcfMetricName(fiber)));
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
export function buildFiberCcfMetrics(fiberNames, ngLink) {
  return fiberNames.map(fiber => ({
    name: fiberCcfMetricName(fiber),
    modality: SPIM_MODALITY,
    stage: 'Processing',
    value: { AP: null, ML: null, DV: null },
    description: FIBER_CCF_DESCRIPTION,
    reference: ngLink,
    tags: { type: FIBER_CCF_TAG },
  }));
}

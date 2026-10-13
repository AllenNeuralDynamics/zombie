const SPIM_MODALITY = {
  name: 'Selective plane illumination microscopy',
  abbreviation: 'SPIM',
};

export const SPIM_CHANNEL_FAILURE_TAG = 'channel brightness';

const GOOD_SUFFICIENT_BAD = {
  value: null,
  options: ['Good', 'Sufficient', 'Bad'],
  status: ['Pass', 'Pass', 'Fail'],
  type: 'dropdown',
};

const PASS_FAIL = {
  value: null,
  options: ['Pass', 'Fail'],
  status: ['Pass', 'Fail'],
  type: 'dropdown',
};

const BASE_METRICS = [
  {
    name: 'Image and tissue quality',
    stage: 'Processing',
    description: [
      'Pass when image is of sufficient quality to meet experimental needs; i.e. tissue is well-cleared and image is in focus.',
      'Good images will have consistent clearing throughout the brain enabling sharp, crisp images of deep as well as superficial structures.',
      'Sufficient images may have clearing inhomogeneities or bubbles obstructing the imaging light path in some portions of the tissue, but remain suitable meeting some or all experimental needs.',
      'Bad images will be blurry, either due to poor tissue clearing or poor image focus.',
    ].join(' '),
    value: GOOD_SUFFICIENT_BAD,
    tags: { type: 'image quality' },
  },
  {
    name: 'Tissue perfusion',
    stage: 'Raw data',
    description: [
      'Pass when tissue is sufficiently well-perfused and extracted to meet experimental needs.',
      'Good tissue perfusion will preserve gross anatomical structures without cracks in tissue, and will be free of perfusion-related artifacts.',
      'Sufficient tissue perfusion will meet experimental needs, but may have some tissue damage or broad-spectrum autofluorescent artifacts (e.g. bright, visible vasculature).',
      'Fail when tissue damage or artifacts render the sample unsuitable for meeting experimental needs.',
    ].join(' '),
    value: GOOD_SUFFICIENT_BAD,
    tags: { type: 'image quality' },
  },
  {
    name: 'Flatfield correction',
    stage: 'Processing',
    description: 'Pass when image tiles appear evenly illuminated around tile corners. ' +
      'Fail when image tiles are non-uniform or show vignetting.' +
      'Note: this QC metric is independent of overall illumination issues.',
    value: PASS_FAIL,
    tags: { type: 'processing' },
  },
  {
    name: 'Image destriping',
    stage: 'Processing',
    description: [
      'Pass when image stripes have been sufficiently mitigated to meet experimental needs.',
      'Good image destriping will have few to no visible striping artifacts.',
      'Sufficient image destriping will meet experimental needs, but may have stripes in some regions.',
      'Bad image destriping will have wide-spread striping artifacts that obstruct experimental analyses.',
    ].join(' '),
    value: GOOD_SUFFICIENT_BAD,
    tags: { type: 'processing' },
  },
  {
    name: 'Image stitching',
    stage: 'Processing',
    description: [
      'Pass when there are no visible stitching artifacts at tile boundaries.',
      'Fail when stitching artifacts are present, e.g. visible misalignments, discontinuities, or doublings of landmarks.',
    ].join(' '),
    value: PASS_FAIL,
    tags: { type: 'processing' },
  },
];

const CHANNEL_DESCRIPTION = [
  'Pass when image channel is of sufficient brightness to meet experimental needs; i.e. signal is neither under nor oversaturated.',
  'Good channel brightness will have dynamic range for signal throughout the imaged volume.',
  'Sufficient channel brightness meets experimental needs but may have some regions of under or oversaturation, e.g. if good dynamic range at the experimental region of interest oversaturates an injection site.',
  'Bad channel brightness will be inappropriate for experimental needs, e.g. an autofluorescent channel that is too dim for atlas alignment.',
].join(' ');

function qualifiesForSpimMetrics(record) {
  return record?.data_description?.data_level === 'derived' &&
    /smart|exa/i.test(record?.instrument?.instrument_id ?? '');
}

function channelName(channel) {
  const name = typeof channel === 'string' ? channel : channel?.channel_name;
  return typeof name === 'string' ? name.trim() : '';
}

function imageChannelName(image) {
  if (typeof image?.file_name !== 'string') return '';
  return image.file_name.split(/[\\/]/).find(name => /^Ex_.+_Em_.+$/i.test(name)) ?? '';
}

function channelNames(record) {
  const acquisition = record?.acquisition;
  const channels = [];

  for (const stream of (Array.isArray(acquisition?.data_streams) ? acquisition.data_streams : [])) {
    for (const configuration of (Array.isArray(stream?.configurations) ? stream.configurations : [])) {
      if (configuration?.object_type !== 'Imaging config') continue;

      const namesWithImageLabels = new Set();
      for (const image of (Array.isArray(configuration.images) ? configuration.images : [])) {
        const declaredName = channelName(image);
        const imageName = imageChannelName(image);
        if (imageName) {
          channels.push(imageName);
          if (declaredName) namesWithImageLabels.add(declaredName);
        } else if (declaredName) {
          channels.push(declaredName);
        }
      }

      for (const channel of (Array.isArray(configuration.channels) ? configuration.channels : [])) {
        const name = channelName(channel);
        if (name && !namesWithImageLabels.has(name)) channels.push(name);
      }
    }
  }

  if (!channels.length && Array.isArray(acquisition?.channels)) {
    channels.push(...acquisition.channels.map(channelName));
  }

  return [...new Set(channels.filter(Boolean))];
}

export async function fetchSpimNeuroglancerLink(location, { fetchImpl = fetch } = {}) {
  const match = String(location ?? '').match(/^s3:\/\/([^/]+)\/(.+?)\/?$/);
  if (!match) throw new Error('Asset has no S3 location.');
  const response = await fetchImpl(`https://${match[1]}.s3.amazonaws.com/${match[2]}/neuroglancer_config.json`);
  if (!response.ok) throw new Error(`SPIM neuroglancer config not found (${response.status}).`);
  const link = (await response.json())?.ng_link;
  if (typeof link !== 'string' || !link.trim()) throw new Error('SPIM neuroglancer config has no ng_link.');
  return link;
}

/** Build the standard SPIM QC metrics used by qc_utils.spim.spim_utils.spim_qc. */
export function buildSpimQcMetrics(record, reference = null) {
  if (!qualifiesForSpimMetrics(record)) return [];

  const metrics = BASE_METRICS.map(metric => ({
    ...metric,
    modality: SPIM_MODALITY,
    reference,
  }));

  for (const channel of channelNames(record)) {
    metrics.splice(1 + metrics.filter(metric => metric.tags.channel).length, 0, {
      name: `${channel} brightness`,
      modality: SPIM_MODALITY,
      stage: 'Raw data',
      description: CHANNEL_DESCRIPTION,
      value: GOOD_SUFFICIENT_BAD,
      reference,
      tags: { type: SPIM_CHANNEL_FAILURE_TAG, channel },
    });
  }
  return metrics;
}

/** Return allowed-failure tag values carried by newly added SPIM metrics. */
export function allowedTagFailuresForSpimMetrics(metrics = []) {
  return metrics.some(metric => metric?.tags?.type === SPIM_CHANNEL_FAILURE_TAG)
    ? [SPIM_CHANNEL_FAILURE_TAG]
    : [];
}

/** Initialize grouping when adding SPIM metrics to QC without a hierarchy. */
export function defaultGroupingForSpimMetrics(record, metrics = []) {
  return !record?.quality_control?.default_grouping?.length &&
    metrics.some(metric => metric?.modality?.abbreviation === 'SPIM')
    ? ['type']
    : undefined;
}

/** Return standard SPIM metrics that are not present or already queued. */
export function missingSpimQcMetrics(record, existingNames = new Set(), reference = null) {
  return buildSpimQcMetrics(record, reference).filter(metric => !existingNames.has(metric.name));
}

/** Repair queued SPIM metrics saved before the current definitions were added. */
export function normalizeSavedSpimQcMetrics(record, metrics) {
  const standardMetrics = new Map(buildSpimQcMetrics(record).map(metric => [metric.name, metric]));
  return metrics.map(metric => {
    if (metric.modality?.abbreviation !== 'SPIM') return metric;
    const standard = standardMetrics.get(metric.name);
    if (!standard) return metric;

    let normalized = metric;
    if (metric.stage === 'Raw' && standard.stage === 'Raw data') {
      normalized = { ...normalized, stage: standard.stage };
    }
    if (
      standard.tags?.type === SPIM_CHANNEL_FAILURE_TAG &&
      metric.tags?.type === 'image quality' &&
      metric.tags?.channel === standard.tags.channel
    ) {
      normalized = { ...normalized, tags: standard.tags };
    }
    return normalized;
  });
}

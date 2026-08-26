/**
 * Shared behavior-event timing for event-aligned views.
 *
 * Every source is adapted to the same small contract:
 *
 *   {
 *     source: string,
 *     referenceTime: number|null, // hardware/session clock at relative t=0
 *     streams: [{ key, label, times, occurrences }]
 *   }
 *
 * `times` are always relative to the behavior session origin. `occurrences`
 * retain a stable row id for consumers that need one event per trial. A
 * photometry trace can therefore align events with
 * `referenceTime + occurrence.t`, while a session-clock spike trace can use
 * `occurrence.t` directly.
 */

import { DATA_CACHE_PREFIX } from '../../constants.js';
import { queryRows } from '../arrow.js';
import { getResolvedVersion } from '../metadata.js';
import { resolveLatestDerived } from '../raw-to-derived.js';

const DEFAULT_EVENT_ORDER = [
  'go_cue',
  'odor_onset',
  'choice_cue',
  'stimulus',
  'change',
  'reward_onset',
  'reward',
  'lick',
  'trial_start',
  'trial_stop',
];

const DF_EVENT_SPECS = [
  { key: 'trial_start',    label: 'Trial start',    column: 'bonsai_start_time_in_session' },
  { key: 'delay_start',    label: 'Delay start',    column: 'delay_start_time_in_session' },
  { key: 'go_cue',         label: 'Go cue',         column: 'goCue_start_time_in_session' },
  { key: 'choice',         label: 'Choice',         column: 'choice_time_in_session' },
  { key: 'reward',         label: 'Reward',         column: 'reward_time_in_session' },
  { key: 'reward_outcome', label: 'Reward outcome', column: 'reward_outcome_time_in_session' },
  { key: 'trial_stop',     label: 'Trial stop',     column: 'bonsai_stop_time_in_session' },
];

const DF_REFERENCE_COLUMN = 'goCue_start_time_raw';

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function esc(s) {
  return String(s).replace(/'/g, "''");
}

function sessionDate(rawAssetName) {
  const match = String(rawAssetName ?? '').match(/\d{4}-\d{2}-\d{2}/);
  return match?.[0] ?? null;
}

function sessionSuffix(rawAssetName) {
  const match = String(rawAssetName ?? '').match(/\d{4}-\d{2}-\d{2}_([\d:-]+)/);
  if (!match) return null;
  const digits = match[1].replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : null;
}

function sqlString(value) {
  return `'${esc(value)}'`;
}

/**
 * Convert a row-oriented event source into the shared timing contract.
 * Exported so source-specific loaders can be tested without a coordinator.
 */
export function buildEventTimingFromRows(
  rows,
  specs,
  { source = 'unknown', referenceTime = null, idColumn = 'trial' } = {},
) {
  const streams = specs.map(({ key, label, column }) => {
    const occurrences = [];
    for (let i = 0; i < rows.length; i++) {
      const t = finite(rows[i]?.[column]);
      if (t == null) continue;
      const rowId = finite(rows[i]?.[idColumn]);
      occurrences.push({ id: rowId ?? i, t });
    }
    occurrences.sort((a, b) => a.t - b.t || a.id - b.id);
    return { key, label, times: occurrences.map((event) => event.t), occurrences };
  }).filter((stream) => stream.occurrences.length > 0);

  const ref = finite(referenceTime);
  return { source, referenceTime: ref, streams };
}

/** Build a stream from a plain time array (NWB adapters use this form). */
export function makeEventStream(key, label, times) {
  const occurrences = [];
  for (const value of times ?? []) {
    const t = finite(value);
    if (t != null) occurrences.push({ id: occurrences.length, t });
  }
  occurrences.sort((a, b) => a.t - b.t || a.id - b.id);
  return { key, label, times: occurrences.map((event) => event.t), occurrences };
}

/** Return the preferred default event, falling back to the first stream. */
export function chooseDefaultEventStream(streams) {
  return DEFAULT_EVENT_ORDER
    .map((key) => streams.find((stream) => stream.key === key))
    .find(Boolean) ?? streams[0] ?? null;
}

/** Return the event timing source most likely to match a timeline event. */
function inferPlatform({ platform, rawAssetName } = {}) {
  if (platform) return platform;
  const raw = String(rawAssetName ?? '');
  if (/^behavior_\d{6}_\d{4}-\d{2}-\d{2}/.test(raw)) return 'dynamic_foraging';
  return null;
}

function dfTrialsUrl(subjectId) {
  return `${DATA_CACHE_PREFIX}/${getResolvedVersion()}/platform_dynamic_foraging_trials`
    + `/subject_id=${esc(subjectId)}/data.pqt`;
}

async function loadDynamicForagingTiming(coord, subjectId, rawAssetName) {
  const date = sessionDate(rawAssetName);
  if (!subjectId || !date) return null;

  const suffix = sessionSuffix(rawAssetName);
  const where = [
    `session_date = ${sqlString(date)}`,
    suffix == null ? null : `nwb_suffix = ${suffix}`,
  ].filter(Boolean).join(' AND ');
  const rows = await queryRows(coord, `
    SELECT *
    FROM read_parquet(${sqlString(dfTrialsUrl(subjectId))})
    WHERE ${where}
    ORDER BY trial
  `);
  if (!rows.length) return null;

  const referenceTime = rows
    .map((row) => finite(row[DF_REFERENCE_COLUMN]))
    .filter((value) => value != null)
    .sort((a, b) => a - b)[0] ?? null;
  return buildEventTimingFromRows(rows, DF_EVENT_SPECS, {
    source: 'dynamic_foraging',
    referenceTime,
  });
}

async function loadVrfTiming(coord, rawAssetName, signal) {
  const derived = await resolveLatestDerived(coord, rawAssetName, { modality: 'behavior' });
  if (!derived?.name) return null;
  const { loadVrfEventTiming } = await import('../../vr_foraging/nwb-loader.js');
  return loadVrfEventTiming(derived.name, { signal });
}

async function loadMfishTiming(coord, rawAssetName, signal) {
  const { loadBehaviorEvents } = await import('../../mfish/behavior-events.js');
  const data = await loadBehaviorEvents(coord, rawAssetName, { signal });
  if (!data) return null;
  return {
    source: 'mfish',
    referenceTime: null,
    streams: [
      makeEventStream('stimulus', 'Stimulus', (data.stimuli ?? []).map((event) => event.t)),
      makeEventStream('change', 'Change', data.changes),
      makeEventStream('reward', 'Reward', data.rewards),
      makeEventStream('lick', 'Lick', data.licks),
    ].filter((stream) => stream.occurrences.length),
  };
}

async function loadBciTiming(coord, rawAssetName, signal) {
  const derived = await resolveLatestDerived(coord, rawAssetName, { modality: 'behavior' });
  if (!derived?.name) return null;
  const { loadBciSession } = await import('../../bci/data.js');
  const data = await loadBciSession(derived.name, { signal });
  return {
    source: 'bci',
    referenceTime: data.sessionClockStart,
    streams: [
      makeEventStream('trial_start', 'Trial start', (data.trials ?? []).map((event) => event.start)),
      makeEventStream('go_cue', 'Go cue', (data.goCues ?? []).map((event) => event.t)),
      makeEventStream('threshold', 'Threshold crossing', (data.thresholdCrossings ?? []).map((event) => event.t)),
      makeEventStream('lick', 'Lick', (data.licks ?? []).map((event) => event.t)),
      makeEventStream('reward', 'Reward', (data.rewards ?? []).map((event) => event.t)),
    ].filter((stream) => stream.occurrences.length),
  };
}

async function loadDynamicRoutingTiming(coord, subjectId, rawAssetName, signal) {
  const date = sessionDate(rawAssetName);
  if (!subjectId || !date) return null;
  const { loadDrSession } = await import('../../dynamic_routing/data-loader.js');
  const data = await loadDrSession(coord, { sessionId: `${subjectId}_${date}`, signal });
  return {
    source: 'dynamic_routing',
    referenceTime: data.sessionClockStart,
    streams: [
      makeEventStream('trial_start', 'Trial start', (data.trials ?? []).map((event) => event.start_t)),
      makeEventStream('stimulus', 'Stimulus', (data.stims ?? []).map((event) => event.t)),
      makeEventStream('response', 'Response', data.responses?.t),
      makeEventStream('reward', 'Reward', data.rewards?.t),
      makeEventStream('trial_stop', 'Trial stop', (data.trials ?? []).map((event) => event.stop_t)),
    ].filter((stream) => stream.occurrences.length),
  };
}

/**
 * Load behavior timing for any supported playback platform.
 *
 * The PSTH consumers only depend on this contract; platform-specific storage
 * and clock normalization stay inside the adapters above.
 */
export async function loadBehaviorEventTiming(
  coord,
  { subjectId, rawAssetName, platform = null, signal } = {},
) {
  const source = inferPlatform({ platform, rawAssetName });
  if (source === 'dynamic_foraging') return loadDynamicForagingTiming(coord, subjectId, rawAssetName);
  if (source === 'vr_foraging') return loadVrfTiming(coord, rawAssetName, signal);
  if (source === 'mfish') return loadMfishTiming(coord, rawAssetName, signal);
  if (source === 'bci') return loadBciTiming(coord, rawAssetName, signal);
  if (source === 'dynamic_routing') return loadDynamicRoutingTiming(coord, subjectId, rawAssetName, signal);
  return null;
}

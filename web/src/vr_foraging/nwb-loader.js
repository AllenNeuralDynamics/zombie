/**
 * vr_foraging/nwb-loader.js — stream VRF session data from S3 NWB.zarr.
 *
 * Loads exactly what `VrfAnimation` needs: the per-site trial table and the
 * encoder + lick traces. Everything is fetched directly from the public
 * `aind-open-data` S3 bucket using `zarrita` (which handles the blosc-lz4
 * chunk decompression).
 *
 * Public API:
 *   loadVrfSession(assetName, { signal }) →
 *     { sites: [...], traces: { pos_t, pos_cm, lick_t } }
 */

import * as zarr from 'zarrita';

const S3_BASE = 'https://aind-open-data.s3.amazonaws.com';

// Trial-table columns we need from `intervals/trials/<col>`. The shape mirrors
// the keys consumed by VrfAnimation and the depletion chart.
const TRIAL_COLS = [
  'site_index',
  'start_time',           // → start_time_s
  'stop_time',            // → stop_time_s
  'start_position',       // → start_position_cm
  'length',               // → length_cm
  'site_label',
  'patch_label',
  'patch_index',
  'block_index',
  'site_in_patch_index',
  'site_by_type_in_patch_index',
  'reward_probability',
  'has_choice',
  'choice_cue_time',      // → choice_cue_time_s
  'has_reward',
  'reward_onset_time',    // → reward_onset_time_s
  'reward_delay_duration',// → reward_delay_duration_s
  'has_waited_reward_delay',
  'odor_onset_time',      // → odor_onset_time_s
  'reward_amount',        // → reward_amount_ul
];

// Trial columns whose names get a "_s" / "_cm" / "_ul" suffix in the output
// rows (matches the schema VrfAnimation was originally built against).
const RENAME = {
  start_time:            'start_time_s',
  stop_time:             'stop_time_s',
  start_position:        'start_position_cm',
  length:                'length_cm',
  choice_cue_time:       'choice_cue_time_s',
  reward_onset_time:     'reward_onset_time_s',
  reward_delay_duration: 'reward_delay_duration_s',
  odor_onset_time:       'odor_onset_time_s',
  reward_amount:         'reward_amount_ul',
};

// Output keys that are *absolute Harp timestamps* and therefore need t0
// subtraction. The "_s" suffix alone isn't sufficient — e.g.
// reward_delay_duration_s is a duration, not a timestamp.
const TIMESTAMP_KEYS = new Set([
  'start_time_s',
  'stop_time_s',
  'choice_cue_time_s',
  'reward_onset_time_s',
  'odor_onset_time_s',
]);

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Fetch trial table + encoder + lick traces for a derived behavior session.
 *
 * @param {string} assetName - DocDB asset name, used verbatim as the S3 key
 *                             prefix (e.g. "841314_2026-…_processed_…").
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - Aborts in-flight fetches.
 * @returns {Promise<{sites:object[], traces:object}>}
 */
export async function loadVrfSession(assetName, { signal } = {}) {
  const baseUrl = `${S3_BASE}/${assetName}/behavior.nwb.zarr`;
  const store = new zarr.FetchStore(baseUrl);
  const root = zarr.root(store);

  // Issue all fetches in parallel. zarrita handles the blosc decompression
  // and dtype interpretation so we receive typed arrays / boxed-string arrays.
  const trialPromises = TRIAL_COLS.map((col) =>
    zarr.open(root.resolve(`intervals/trials/${col}`), { kind: 'array' })
      .then((arr) => zarr.get(arr))
      .then((chunk) => [col, chunk.data]),
  );

  const posPosP  = zarr.open(root.resolve('acquisition/Behavior.OperationControl.CurrentPosition/Position'), { kind: 'array' }).then((a) => zarr.get(a));
  const posTP    = zarr.open(root.resolve('acquisition/Behavior.OperationControl.CurrentPosition/Seconds'),  { kind: 'array' }).then((a) => zarr.get(a));
  const lickChP  = zarr.open(root.resolve('acquisition/Behavior.HarpLickometer.LickState/Channel0'),         { kind: 'array' }).then((a) => zarr.get(a));
  const lickTP   = zarr.open(root.resolve('acquisition/Behavior.HarpLickometer.LickState/Time'),             { kind: 'array' }).then((a) => zarr.get(a));

  const [trialEntries, pos, posT, lickCh, lickT] = await Promise.all([
    Promise.all(trialPromises),
    posPosP, posTP, lickChP, lickTP,
  ]);
  if (signal?.aborted) throw new Error('aborted');

  const trial = Object.fromEntries(trialEntries);

  // BoolArray and BigInt64Array don't index with `[i]` ergonomically; convert
  // boxed/special arrays to plain JS arrays for uniform downstream access.
  for (const col of Object.keys(trial)) {
    trial[col] = Array.from(trial[col]);
  }

  // ---- t0 normalisation -------------------------------------------------
  // All event timestamps in this file share the global Harp epoch; subtract
  // the first trial start_time so the animation starts at t=0. (The
  // CurrentPosition Seconds[0] is a 0-sentinel for the pre-recording state.)
  const t0 = trial.start_time[0];

  // ---- Build per-site rows ---------------------------------------------
  const n = trial.site_index.length;
  const sites = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = {};
    for (const col of TRIAL_COLS) {
      const key = RENAME[col] ?? col;
      let v = trial[col][i];
      if (typeof v === 'bigint') v = Number(v);
      if (TIMESTAMP_KEYS.has(key) && Number.isFinite(v)) {
        row[key] = +(v - t0).toFixed(4);
      } else if (typeof v === 'number') {
        // NaN sentinels → null for missing values in zarr float cols.
        row[key] = Number.isFinite(v) ? +v.toFixed(4) : null;
      } else {
        row[key] = v;
      }
    }
    sites[i] = row;
  }

  // ---- Position trace ---------------------------------------------------
  // Both Position and Seconds have a leading 0-sentinel sample; skip it so
  // the trace is monotonic and on the Harp clock.
  const rawSec = Array.from(posT.data);
  const rawPos = Array.from(pos.data);
  const start  = rawSec[0] === 0 ? 1 : 0;
  const posLen = Math.min(rawSec.length, rawPos.length) - start;
  const pos_t  = new Float64Array(posLen);
  const pos_cm = new Float64Array(posLen);
  for (let i = 0; i < posLen; i++) {
    pos_t[i]  = rawSec[i + start] - t0;
    pos_cm[i] = rawPos[i + start];
  }

  // ---- Lick trace -------------------------------------------------------
  // Rising edges of Channel0 (boolean) → onset times.
  const ch  = Array.from(lickCh.data);
  const lkt = Array.from(lickT.data);
  const lick_t = [];
  let prev = 0;
  const chLen = Math.min(ch.length, lkt.length);
  for (let i = 0; i < chLen; i++) {
    const v = ch[i] ? 1 : 0;
    if (v && !prev) lick_t.push(+(lkt[i] - t0).toFixed(4));
    prev = v;
  }

  return {
    sites,
    traces: { t0_offset: t0, pos_t, pos_cm, lick_t },
  };
}

/**
 * dynamic_foraging/data-loader.js — DuckDB queries against the AIND
 * dynamic-foraging-database (s3://aind-scratch-data/aind-dynamic-foraging-cache).
 *
 * Each subject has exactly one coalesced parquet under
 *   <base>/{trial,event}_table/subject_id=<id>/<id>.parquet
 * so we can construct the URL directly — no hive globbing required.
 *
 * Public API:
 *   loadDfSession(coord, { subjectId, sessionDate, nwbSuffix, signal })
 *     → { trials, licks, rewards, goCues, sessionEndS }
 */

import { queryRows } from '../lib/arrow.js';

const DF_BASE =
  'https://aind-scratch-data.s3.us-west-2.amazonaws.com/aind-dynamic-foraging-cache';

/** Session-level metadata parquet — the canonical list of "playable" sessions. */
export const SESSION_TABLE_URL = `${DF_BASE}/session_table.parquet`;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function trialTableUrl(subjectId) {
  const sid = String(subjectId);
  return `${DF_BASE}/trial_table/subject_id=${sid}/${sid}.parquet`;
}

export function eventTableUrl(subjectId) {
  const sid = String(subjectId);
  return `${DF_BASE}/event_table/subject_id=${sid}/${sid}.parquet`;
}

// ---------------------------------------------------------------------------
// SQL escaping
// ---------------------------------------------------------------------------

function sqlStr(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Public loader
// ---------------------------------------------------------------------------

/**
 * Fetch trials + behavioral events for one dynamic-foraging session.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {object} opts
 * @param {string|number} opts.subjectId
 * @param {string} opts.sessionDate  YYYY-MM-DD
 * @param {number|string} opts.nwbSuffix  session start HHMMSS as integer
 * @param {AbortSignal} [opts.signal]  honored only between awaits
 * @returns {Promise<object>}
 */
export async function loadDfSession(coord, { subjectId, sessionDate, nwbSuffix, signal } = {}) {
  if (subjectId == null || !sessionDate || nwbSuffix == null) {
    throw new Error('loadDfSession requires subjectId, sessionDate, nwbSuffix');
  }

  const tUrl = trialTableUrl(subjectId);
  const eUrl = eventTableUrl(subjectId);
  const suffix = Number(nwbSuffix);
  const dateStr = sqlStr(sessionDate);

  const trialSql = `
    SELECT
      trial,
      goCue_start_time_in_session AS goCue_t,
      choice_time_in_session AS choice_t,
      reward_time_in_session AS reward_t,
      animal_response AS response,
      earned_reward AS earned,
      reward_probabilityL AS pL,
      reward_probabilityR AS pR,
      rewarded_historyL AS rewardedL,
      rewarded_historyR AS rewardedR,
      auto_waterL AS autoL,
      auto_waterR AS autoR
    FROM read_parquet(${sqlStr(tUrl)})
    WHERE session_date = ${dateStr} AND nwb_suffix = ${suffix}
    ORDER BY trial
  `;

  const eventSql = `
    SELECT timestamps AS t, event
    FROM read_parquet(${sqlStr(eUrl)})
    WHERE session_date = ${dateStr} AND nwb_suffix = ${suffix}
      AND event IN (
        'left_lick_time', 'right_lick_time',
        'left_reward_delivery_time', 'right_reward_delivery_time',
        'goCue_start_time'
      )
    ORDER BY timestamps
  `;

  const [trialRows, eventRows] = await Promise.all([
    queryRows(coord, trialSql),
    queryRows(coord, eventSql),
  ]);
  if (signal?.aborted) throw new Error('aborted');

  if (trialRows.length === 0) {
    throw new Error(
      `No trials found in DF database for subject ${subjectId}, ${sessionDate}, nwb_suffix=${suffix}`,
    );
  }

  const trials = trialRows.map(_normalizeTrial);
  const buckets = _bucketEvents(eventRows);

  // Session duration: latest of (last lick, last reward, last go-cue+10s, last choice+10s)
  let endS = 0;
  for (const t of trials) {
    if (Number.isFinite(t.choice_t)) endS = Math.max(endS, t.choice_t + 10);
    if (Number.isFinite(t.goCue_t)) endS = Math.max(endS, t.goCue_t + 10);
  }
  const lastLick = buckets.licks.t.length > 0 ? buckets.licks.t[buckets.licks.t.length - 1] : 0;
  endS = Math.max(endS, lastLick + 2);

  return {
    trials,
    licks: buckets.licks,
    rewards: buckets.rewards,
    goCues: buckets.goCues,
    sessionEndS: endS,
  };
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw trial-table row to plain JS numeric values.
 * Exported for unit testing.
 */
export function _normalizeTrial(r) {
  const toNum = (v) => {
    if (v == null) return null;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    trial:     toNum(r.trial),
    goCue_t:   toNum(r.goCue_t),
    choice_t:  toNum(r.choice_t),
    reward_t:  toNum(r.reward_t),
    response:  toNum(r.response),     // 0=L 1=R 2=ignore
    earned:    toNum(r.earned),
    pL:        toNum(r.pL),
    pR:        toNum(r.pR),
    rewardedL: toNum(r.rewardedL),
    rewardedR: toNum(r.rewardedR),
    autoL:     toNum(r.autoL),
    autoR:     toNum(r.autoR),
  };
}

/**
 * Bucket the raw event rows into typed-array arrays per event kind.
 * Exported for unit testing.
 *
 * @param {object[]} rows - rows of { t: number, event: string }
 * @returns {{licks:{t:Float64Array,side:Uint8Array}, rewards:{t:Float64Array,side:Uint8Array}, goCues:Float64Array}}
 */
export function _bucketEvents(rows) {
  const lickT = [];
  const lickSide = []; // 0=L, 1=R
  const rewT = [];
  const rewSide = [];
  const goCues = [];

  for (const r of rows) {
    const t = Number(r.t);
    if (!Number.isFinite(t)) continue;
    switch (r.event) {
      case 'left_lick_time':  lickT.push(t); lickSide.push(0); break;
      case 'right_lick_time': lickT.push(t); lickSide.push(1); break;
      case 'left_reward_delivery_time':  rewT.push(t); rewSide.push(0); break;
      case 'right_reward_delivery_time': rewT.push(t); rewSide.push(1); break;
      case 'goCue_start_time': goCues.push(t); break;
      default: break;
    }
  }

  return {
    licks:   { t: Float64Array.from(lickT),  side: Uint8Array.from(lickSide) },
    rewards: { t: Float64Array.from(rewT),   side: Uint8Array.from(rewSide) },
    goCues:  Float64Array.from(goCues),
  };
}

// ---------------------------------------------------------------------------
// Binary-search helpers used by the animation
// ---------------------------------------------------------------------------

/** Largest index `i` such that arr[i] ≤ t. Returns -1 if t < arr[0]. */
export function lastLE(arr, t) {
  const n = arr.length;
  if (n === 0 || t < arr[0]) return -1;
  if (t >= arr[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Smallest index `i` such that arr[i] ≥ t. Returns arr.length if all < t. */
export function firstGE(arr, t) {
  const n = arr.length;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Last trial whose goCue_t ≤ t. Returns -1 if t is before the first cue. */
export function findTrialAt(trials, t) {
  if (trials.length === 0) return -1;
  let lo = 0, hi = trials.length - 1;
  if (t < trials[0].goCue_t) return -1;
  if (t >= trials[hi].goCue_t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (trials[mid].goCue_t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

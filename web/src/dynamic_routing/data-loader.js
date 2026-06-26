/**
 * dynamic_routing/data-loader.js — DuckDB queries against the public
 * dynamic-routing nwb-components cache
 *   s3://aind-scratch-data/dynamic-routing/cache/nwb_components/v0.0.272/
 *
 * The cache is partitioned per-session as `<subject_id>_<YYYY-MM-DD>.parquet`
 * under each table folder (trials, performance, session, …). We use the
 * `consolidated/performance.parquet` (~90 KB) as the source-of-truth for the
 * session dropdown — it has per-block hit rates, modality sequence, and
 * response counts in one tiny file. Per-session trial detail is read on
 * demand from `trials/<session>.parquet`.
 *
 * NOTE on "licks" vs "responses". This parquet cache (v0.0.272) ships
 * per-trial intervals + units but does NOT include the raw lick TimeSeries
 * (those live only inside the 2.7 GB raw .nwb files at
 * processing/behavior/licks/timestamps). What we expose as the
 * `responses` event stream is one event per trial that had `is_response`,
 * timestamped at `response_time` (= the first lick inside the response
 * window). For a typical session this is ~5× fewer events than the real
 * lick stream (spontaneous + multi-lick activity is invisible here). Adding
 * real licks would require either a per-session sidecar parquet or an
 * in-browser HDF5 reader — see GitHub issue / future iteration.
 *
 * Public API:
 *   PERFORMANCE_TABLE_URL — for the session-list query
 *   trialsUrl(sessionId)  — per-session trials parquet
 *   loadDrSession(coord, { sessionId, signal }) →
 *     { trials, blocks, responses, rewards, stims, sessionEndS, meta }
 */

import { queryRows } from '../lib/arrow.js';

const DR_BASE =
  'https://aind-scratch-data.s3.us-west-2.amazonaws.com/dynamic-routing/cache/nwb_components/v0.0.272';

/** Consolidated per-block performance — the canonical "session catalog". */
export const PERFORMANCE_TABLE_URL = `${DR_BASE}/consolidated/performance.parquet`;

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function trialsUrl(sessionId) {
  return `${DR_BASE}/trials/${sessionId}.parquet`;
}

export function sessionUrl(sessionId) {
  return `${DR_BASE}/session/${sessionId}.parquet`;
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
 * Fetch trials + derived behavioral events for one dynamic-routing session.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {object} opts
 * @param {string} opts.sessionId   e.g. "762526_2025-03-20"
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>}
 */
export async function loadDrSession(coord, { sessionId, signal } = {}) {
  if (!sessionId) throw new Error('loadDrSession requires sessionId');

  const url = trialsUrl(sessionId);
  const sql = `
    SELECT
      trial_index, block_index, rewarded_modality, stim_name,
      start_time, stop_time,
      stim_start_time, stim_stop_time,
      response_window_start_time, response_window_stop_time,
      response_time, reward_time,
      is_response, is_correct, is_hit, is_miss,
      is_false_alarm, is_correct_reject,
      is_target, is_nontarget, is_catch,
      is_aud_target, is_vis_target, is_aud_nontarget, is_vis_nontarget,
      is_rewarded, is_noncontingent_reward
    FROM read_parquet(${sqlStr(url)})
    ORDER BY trial_index
  `;

  const rows = await queryRows(coord, sql);
  if (signal?.aborted) throw new Error('aborted');
  if (rows.length === 0) {
    throw new Error(`No trials found for session ${sessionId}`);
  }

  const rawTrials = rows.map(_normalizeTrial);

  // Shift origin so the first trial starts at t=0. The raw cache stores
  // absolute session-clock times that typically begin several hundred seconds
  // into the recording (acquisition warm-up), which would render as a large
  // empty gap at the start of playback. Subtract a constant offset from every
  // time field so callers can treat t=0 as "start of first trial".
  const firstStart = rawTrials.reduce(
    (mn, t) =>
      Number.isFinite(t.start_t) && (mn == null || t.start_t < mn) ? t.start_t : mn,
    null,
  );
  const t0 = Number.isFinite(firstStart) ? firstStart : 0;
  const trials = rawTrials.map((tr) => _shiftTrial(tr, t0));

  const blocks = _buildBlocks(trials);
  const stims  = _buildStimEvents(trials);
  const responses = _buildResponseEvents(trials);
  const rewards = _buildRewardEvents(trials);

  const lastStop = trials.reduce(
    (mx, t) => (Number.isFinite(t.stop_t) ? Math.max(mx, t.stop_t) : mx),
    0,
  );
  const sessionEndS = lastStop + 5; // small pad

  return {
    sessionId,
    trials,
    blocks,
    stims,
    responses,
    rewards,
    sessionEndS,
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function _toNum(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize one raw trial row to plain JS numbers + a string stim/modality.
 * Exported for tests.
 */
export function _normalizeTrial(r) {
  return {
    trial:        _toNum(r.trial_index),
    block:        _toNum(r.block_index),
    rewardedMod:  r.rewarded_modality ?? null,         // 'vis' | 'aud'
    stim:         r.stim_name ?? null,                 // 'vis1'|'vis2'|'sound1'|'sound2'|'catch'
    start_t:      _toNum(r.start_time),
    stop_t:       _toNum(r.stop_time),
    stim_t:       _toNum(r.stim_start_time),
    stim_end_t:   _toNum(r.stim_stop_time),
    rw_start_t:   _toNum(r.response_window_start_time),
    rw_stop_t:    _toNum(r.response_window_stop_time),
    response_t:   _toNum(r.response_time),
    reward_t:     _toNum(r.reward_time),
    isResp:       _toNum(r.is_response) ?? 0,
    isCorrect:    _toNum(r.is_correct) ?? 0,
    isHit:        _toNum(r.is_hit) ?? 0,
    isMiss:       _toNum(r.is_miss) ?? 0,
    isFA:         _toNum(r.is_false_alarm) ?? 0,
    isCR:         _toNum(r.is_correct_reject) ?? 0,
    isTarget:     _toNum(r.is_target) ?? 0,
    isNontarget:  _toNum(r.is_nontarget) ?? 0,
    isCatch:      _toNum(r.is_catch) ?? 0,
    isAudTarget:  _toNum(r.is_aud_target) ?? 0,
    isVisTarget:  _toNum(r.is_vis_target) ?? 0,
    isAudNontg:   _toNum(r.is_aud_nontarget) ?? 0,
    isVisNontg:   _toNum(r.is_vis_nontarget) ?? 0,
    isRewarded:   _toNum(r.is_rewarded) ?? 0,
    isAutoRew:    _toNum(r.is_noncontingent_reward) ?? 0,
  };
}

/**
 * Subtract a constant t0 from every time field on a normalized trial.
 * Exported for tests.
 */
export function _shiftTrial(tr, t0) {
  const sub = (v) => (Number.isFinite(v) ? v - t0 : v);
  return {
    ...tr,
    start_t:    sub(tr.start_t),
    stop_t:     sub(tr.stop_t),
    stim_t:     sub(tr.stim_t),
    stim_end_t: sub(tr.stim_end_t),
    rw_start_t: sub(tr.rw_start_t),
    rw_stop_t:  sub(tr.rw_stop_t),
    response_t: sub(tr.response_t),
    reward_t:   sub(tr.reward_t),
  };
}

/**
 * Build per-block summary intervals.
 * Exported for tests.
 */
export function _buildBlocks(trials) {
  if (trials.length === 0) return [];
  const map = new Map();
  for (const tr of trials) {
    if (tr.block == null) continue;
    let b = map.get(tr.block);
    if (!b) {
      b = {
        block: tr.block,
        rewardedMod: tr.rewardedMod,
        start_t: tr.start_t,
        stop_t: tr.stop_t,
        n: 0,
        n_resp: 0,
        n_rew: 0,
        n_hit: 0,
        n_miss: 0,
        n_fa: 0,
        n_cr: 0,
        n_target: 0,
        n_nontarget: 0,
      };
      map.set(tr.block, b);
    }
    if (Number.isFinite(tr.start_t)) b.start_t = Math.min(b.start_t ?? tr.start_t, tr.start_t);
    if (Number.isFinite(tr.stop_t))  b.stop_t  = Math.max(b.stop_t  ?? tr.stop_t,  tr.stop_t);
    b.n          += 1;
    b.n_resp     += tr.isResp;
    b.n_rew      += tr.isRewarded;
    b.n_hit      += tr.isHit;
    b.n_miss     += tr.isMiss;
    b.n_fa       += tr.isFA;
    b.n_cr       += tr.isCR;
    b.n_target   += tr.isTarget;
    b.n_nontarget+= tr.isNontarget;
  }
  return [...map.values()].sort((a, b) => a.block - b.block);
}

/**
 * Stimulus-onset events (one per trial that has a stim). Used for the raster
 * row and the animation cue trigger.
 * Exported for tests.
 */
export function _buildStimEvents(trials) {
  const out = [];
  for (const tr of trials) {
    if (!Number.isFinite(tr.stim_t)) continue;
    const kind = _stimKind(tr);
    out.push({
      t: tr.stim_t,
      stim: tr.stim,
      kind,                        // 'vis_target'|'vis_nontarget'|'aud_target'|'aud_nontarget'|'catch'
      rewardedMod: tr.rewardedMod,
      block: tr.block,
      trial: tr.trial,
      duration: Number.isFinite(tr.stim_end_t) ? tr.stim_end_t - tr.stim_t : 0.5,
    });
  }
  return out;
}

export function _stimKind(tr) {
  if (tr.isCatch)        return 'catch';
  if (tr.isVisTarget)    return 'vis_target';
  if (tr.isVisNontg)     return 'vis_nontarget';
  if (tr.isAudTarget)    return 'aud_target';
  if (tr.isAudNontg)     return 'aud_nontarget';
  // Fallback by stim name (training sessions may have missing target flags).
  if (tr.stim === 'vis1')   return 'vis_target';
  if (tr.stim === 'vis2')   return 'vis_nontarget';
  if (tr.stim === 'sound1') return 'aud_target';
  if (tr.stim === 'sound2') return 'aud_nontarget';
  return 'unknown';
}

/**
 * Build trial-response events from per-trial response_time. Each entry is
 * the time of the FIRST lick within the response window of a trial where
 * the mouse responded — this is NOT the full lick stream (see header).
 * Returns the typed-array shape the animation expects.
 * Exported for tests.
 */
export function _buildResponseEvents(trials) {
  const ts = [];
  for (const tr of trials) {
    if (Number.isFinite(tr.response_t)) ts.push(tr.response_t);
  }
  ts.sort((a, b) => a - b);
  return { t: Float64Array.from(ts) };
}

/**
 * Reward events. Single spout, so only timestamps.
 * Exported for tests.
 */
export function _buildRewardEvents(trials) {
  const ts = [];
  const auto = [];
  for (const tr of trials) {
    if (!Number.isFinite(tr.reward_t)) continue;
    ts.push(tr.reward_t);
    auto.push(tr.isAutoRew ? 1 : 0);
  }
  // ts is already in trial order, which is monotonically non-decreasing for
  // reward_time, but sort defensively.
  const idx = ts.map((_, i) => i).sort((a, b) => ts[a] - ts[b]);
  return {
    t:    Float64Array.from(idx.map((i) => ts[i])),
    auto: Uint8Array.from(idx.map((i) => auto[i])),
  };
}

// ---------------------------------------------------------------------------
// Binary-search helpers (used by the animation; exported for tests)
// ---------------------------------------------------------------------------

/** Largest index i such that arr[i] ≤ t. Returns -1 if t < arr[0]. */
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

/** Find the most-recent stim event with t ≤ now; returns null if none. */
export function findStimAt(stims, now) {
  if (stims.length === 0 || now < stims[0].t) return null;
  let lo = 0, hi = stims.length - 1;
  if (now >= stims[hi].t) return stims[hi];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (stims[mid].t <= now) lo = mid;
    else hi = mid - 1;
  }
  return stims[lo];
}

/** Most-recent trial with start_t ≤ now; returns -1 if before the first. */
export function findTrialAt(trials, now) {
  if (trials.length === 0 || now < trials[0].start_t) return -1;
  let lo = 0, hi = trials.length - 1;
  if (now >= trials[hi].start_t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (trials[mid].start_t <= now) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Most-recent block with start_t ≤ now. */
export function findBlockAt(blocks, now) {
  if (blocks.length === 0 || now < blocks[0].start_t) return -1;
  let lo = 0, hi = blocks.length - 1;
  if (now >= blocks[hi].start_t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].start_t <= now) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

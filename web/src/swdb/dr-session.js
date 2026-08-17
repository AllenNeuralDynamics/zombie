/**
 * swdb/dr-session.js — adapt cached SWDB tables to the Dynamic Routing session shape.
 *
 * The SWDB set *is* the Dynamic Routing task, and `dynamic_routing/` already owns a
 * complete viewer for it: `DrAnimation` (head-fixed mouse, gabor/speaker stimuli,
 * reward droplet) and `createEventPlot` (block spans, stim raster, response-rate
 * lines). Both are driven purely by a plain data object, so the whole SWDB behavior
 * viewer reduces to producing that object from the SWDB parquet tables — no forked
 * animation or plot code.
 *
 * The trial columns cached by the `swdb` job match `_normalizeTrial`'s expectations
 * one-to-one, so normalisation, origin shifting, block summarising, stim events and
 * reward events all reuse the exported helpers from
 * `dynamic_routing/data-loader.js` rather than being reimplemented.
 *
 * One genuine upgrade over the parquet-cache-backed DR viewer: that cache ships no
 * lick stream, so it substitutes one synthetic "response" per responding trial
 * (see the note at `dynamic_routing/data-loader.js:20`). The merged NWBs *do* carry
 * `processing/behavior/licks`, so here `responses` is the real lick stream —
 * typically ~20x more events, including spontaneous and multi-lick bouts.
 */

import {
  _normalizeTrial,
  _shiftTrial,
  _buildBlocks,
  _buildStimEvents,
  _buildRewardEvents,
} from '../dynamic_routing/data-loader.js';
import { loadTrials, loadEvents } from './data.js';

/** Seconds of padding after the last trial, matching the DR loader. */
const END_PAD_S = 5;

/**
 * Build the lick event stream the animation consumes.
 *
 * The cached `licks` events carry `is_likely_lick` in `value`; contact events that
 * failed that check are hardware noise rather than licks, so they are dropped when
 * the flag is present. Licks are shifted onto the trial-relative clock and clamped
 * to the playable window — a session records licks during pre-task spontaneous
 * reward blocks, which would otherwise land at negative times.
 *
 * @param {object[]} lickEvents - Rows from the events table with kind='lick'.
 * @param {number} t0 - Session-clock time that becomes t=0.
 * @param {number} sessionEndS
 * @returns {{t: Float64Array}}
 */
export function buildLickResponses(lickEvents, t0, sessionEndS) {
  const hasFlag = lickEvents.some((e) => e.value != null);
  const times = [];
  for (const ev of lickEvents) {
    if (hasFlag && !Number(ev.value)) continue;
    const t = Number(ev.t) - t0;
    if (!Number.isFinite(t) || t < 0 || t > sessionEndS) continue;
    times.push(t);
  }
  times.sort((a, b) => a - b);
  return { t: Float64Array.from(times) };
}

/**
 * Collapse epoch events into labelled spans on the trial-relative clock.
 *
 * Epochs (RFMapping, OptoTagging, DynamicRouting1, …) describe the whole session,
 * so they are kept unclamped — a viewer uses them to show what surrounds the task,
 * and negative starts are meaningful there.
 *
 * @param {object[]} epochEvents - Rows from the events table with kind='epoch'.
 * @param {number} t0
 * @returns {{label: string, start_t: number, stop_t: number}[]}
 */
export function buildEpochSpans(epochEvents, t0) {
  return epochEvents
    .map((ev) => ({
      label: ev.label ?? 'epoch',
      start_t: Number(ev.t) - t0,
      stop_t: Number(ev.t_stop ?? ev.t) - t0,
    }))
    .filter((e) => Number.isFinite(e.start_t) && Number.isFinite(e.stop_t))
    .sort((a, b) => a.start_t - b.start_t);
}

/**
 * Assemble the Dynamic Routing session object for one SWDB asset.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {object} opts
 * @param {string} opts.assetName
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object>} `{ sessionId, trials, blocks, stims, responses, rewards,
 *   sessionEndS, epochs, t0 }` — the shape `DrAnimation`/`createEventPlot` consume,
 *   plus the epoch spans and origin offset SWDB adds.
 */
export async function loadSwdbDrSession(coord, { assetName, signal } = {}) {
  if (!assetName) throw new Error('loadSwdbDrSession requires assetName');

  const [trialRows, eventRows] = await Promise.all([
    loadTrials(coord, assetName),
    loadEvents(coord, assetName, ['lick', 'epoch']),
  ]);
  if (signal?.aborted) throw new Error('aborted');
  if (trialRows.length === 0) throw new Error(`No trials cached for ${assetName}`);

  // `_normalizeTrial` covers the DR parquet cache's column set. The merged NWB adds
  // a few flags beyond it, so they are attached here rather than by widening the
  // shared normaliser (which other pages depend on).
  const rawTrials = trialRows.map((row) => ({
    ..._normalizeTrial(row),
    isOpto: row.is_opto ? 1 : 0,
    isInstruction: row.is_instruction ? 1 : 0,
    isRepeat: row.is_repeat ? 1 : 0,
  }));

  // Shift so the first trial starts at t=0. The merged NWB's clock starts at
  // acquisition onset, and the task typically begins ~3000 s in (after RF mapping,
  // optotagging and spontaneous blocks), which would otherwise render as a huge
  // empty gap before the first trial.
  const firstStart = rawTrials.reduce(
    (mn, t) => (Number.isFinite(t.start_t) && (mn == null || t.start_t < mn) ? t.start_t : mn),
    null,
  );
  const t0 = Number.isFinite(firstStart) ? firstStart : 0;
  const trials = rawTrials.map((tr) => _shiftTrial(tr, t0));

  const lastStop = trials.reduce((mx, t) => (Number.isFinite(t.stop_t) ? Math.max(mx, t.stop_t) : mx), 0);
  const sessionEndS = lastStop + END_PAD_S;

  const lickEvents = eventRows.filter((e) => e.kind === 'lick');
  const epochEvents = eventRows.filter((e) => e.kind === 'epoch');

  return {
    sessionId: assetName,
    trials,
    blocks: _buildBlocks(trials),
    stims: _buildStimEvents(trials),
    responses: buildLickResponses(lickEvents, t0, sessionEndS),
    rewards: _buildRewardEvents(trials),
    sessionEndS,
    epochs: buildEpochSpans(epochEvents, t0),
    t0,
  };
}

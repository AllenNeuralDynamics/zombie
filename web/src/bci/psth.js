/** Event-aligned calcium PSTHs for the BCI playback panel. */

import { bciTraceTime } from './pophys-data.js';

export const BCI_PSTH_PRE = 2;
export const BCI_PSTH_POST = 4;
export const BCI_PSTH_BINS = 120;

/** Return the NWB event streams that can be used as PSTH anchors. */
export function bciPsthEvents(data) {
  return [
    { key: 'trial_start', label: 'trial start', times: (data.trials ?? []).map((d) => d.start) },
    { key: 'go_cue', label: 'go cue', times: (data.goCues ?? []).map((d) => d.t) },
    { key: 'spout_step', label: 'spout step', times: (data.zaberSteps ?? []).map((d) => d.t) },
    { key: 'threshold', label: 'threshold crossing', times: (data.thresholdCrossings ?? []).map((d) => d.t) },
    { key: 'lick', label: 'lick', times: (data.licks ?? []).map((d) => d.t) },
    { key: 'reward', label: 'reward', times: (data.rewards ?? []).map((d) => d.t) },
  ].filter((stream) => stream.times.some((t) => Number.isFinite(Number(t))));
}

/**
 * Compute an event-triggered average from one BCI calcium trace.
 *
 * The output uses the shared PSTH plot contract: {t, mean, lo, hi}. Events
 * whose full window is outside the trace are skipped, and the shaded band is
 * the standard error of the mean across usable events.
 */
export function computeBciPsth(
  trace,
  meta,
  sessionClockStart,
  eventTimes,
  { pre = BCI_PSTH_PRE, post = BCI_PSTH_POST, bins = BCI_PSTH_BINS } = {},
) {
  const values = trace ?? [];
  const frameRate = Number(meta?.frameRate);
  const nBins = Math.max(2, Math.floor(Number(bins) || BCI_PSTH_BINS));
  const binWidth = (Number(pre) + Number(post)) / nBins;
  if (!values.length || !(frameRate > 0) || !(binWidth > 0)) return null;

  const dt = 1 / frameRate;
  const traceStart = bciTraceTime(meta, 0, sessionClockStart);
  const sums = new Float64Array(nBins);
  const sumSquares = new Float64Array(nBins);
  const counts = new Uint32Array(nBins);
  let usableEvents = 0;

  for (const rawEvent of eventTimes ?? []) {
    const event = Number(rawEvent);
    if (!Number.isFinite(event)) continue;
    const windowStart = event - Number(pre);
    const windowEnd = event + Number(post);
    const first = Math.floor((windowStart - traceStart) / dt);
    const last = Math.ceil((windowEnd - traceStart) / dt);
    if (first < 0 || last > values.length) continue;
    usableEvents++;

    for (let bin = 0; bin < nBins; bin++) {
      const binStart = Math.max(first, Math.floor((windowStart + bin * binWidth - traceStart) / dt));
      const binEnd = Math.min(last, Math.ceil((windowStart + (bin + 1) * binWidth - traceStart) / dt));
      for (let frame = binStart; frame < binEnd; frame++) {
        const value = Number(values[frame]);
        if (!Number.isFinite(value)) continue;
        sums[bin] += value;
        sumSquares[bin] += value * value;
        counts[bin]++;
      }
    }
  }

  if (!usableEvents) return null;
  const rows = [];
  for (let bin = 0; bin < nBins; bin++) {
    if (!counts[bin]) continue;
    const mean = sums[bin] / counts[bin];
    const variance = Math.max(0, sumSquares[bin] / counts[bin] - mean * mean);
    const sem = Math.sqrt(variance / usableEvents);
    rows.push({
      t: -Number(pre) + (bin + 0.5) * binWidth,
      mean,
      lo: mean - sem,
      hi: mean + sem,
    });
  }
  return rows.length ? { rows, usableEvents } : null;
}

/**
 * mfish/nwb-loader.js — small lookup helpers over the normalized behavior
 * events (see behavior-events.js). Kept as a separate module so the animation
 * and player share the same binary-search logic.
 *
 * The actual behavior-NWB reading + variant routing now lives in
 * behavior-events.js (which handles both the "gratings" and "images" NWB
 * layouts). This module only provides time lookups over the normalized shape.
 */

/** Index of the stimulus presentation covering (or most recently before) t. */
export function findStimAt(stimuli, t) {
  let lo = 0, hi = stimuli.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stimuli[mid].t <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** Running-speed value at or before time t (running = { t, v } typed arrays). */
export function runningSpeedAt(running, t) {
  const arr = running?.t;
  if (!arr || !arr.length) return 0;
  let lo = 0, hi = arr.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= t) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return running.v[ans];
}

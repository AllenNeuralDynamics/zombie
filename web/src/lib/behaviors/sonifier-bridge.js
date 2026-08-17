/**
 * sonifier-bridge.js — thin coupling between the ecephys playback panel (which
 * owns the 🎹 "Spike Jukebox" button + mapping modal) and the corridor player
 * (which owns the transport clock and the DOM slot for the unit-lane strip).
 *
 * The two are siblings mounted by createSessionPlayback, so neither imports the
 * other. The VR-foraging player registers its animation + a view-insertion
 * callback here; the ecephys panel subscribes to transport ticks and injects
 * the spike-raster view. Only the corridor (VRF) player registers, so the
 * button only appears when a corridor is present.
 */

export function createSonifierBridge() {
  let anim = null;
  let insertViewFn = null;
  let tickCbs = [];
  let readyCbs = [];

  return {
    /** Called by the corridor player once its animation is live. */
    registerCorridor({ anim: a, insertView }) {
      anim = a;
      insertViewFn = insertView;
      const cbs = readyCbs;
      readyCbs = [];
      for (const cb of cbs) cb();
    },

    hasCorridor() { return !!anim; },
    getAnim() { return anim; },

    /** Insert the unit-lane strip element between behavior and videos. */
    insertView(el) { insertViewFn?.(el); },

    /** Run `cb` now if the corridor is ready, else when it registers. */
    onReady(cb) { if (anim) cb(); else readyCbs.push(cb); },

    /** Corridor player calls this from its per-frame onFrame. */
    emitTick(t, prevT, state) { for (const cb of tickCbs) cb(t, prevT, state); },

    /** Subscribe to transport ticks. Returns an unsubscribe fn. */
    onTick(cb) {
      tickCbs.push(cb);
      return () => { tickCbs = tickCbs.filter((c) => c !== cb); };
    },
  };
}

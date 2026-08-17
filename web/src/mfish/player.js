/**
 * mfish/player.js — session-playback widget for Learning mFISH
 * (multiplane-ophys) orientation-change-detection sessions.
 *
 * Embedded in the subject viewer's Event Details panel when an acquisition's
 * project name contains "mFISH" (see lib/behaviors/session-playback.js).
 *
 * The behavioral data is streamed directly from the session's derived
 * *behavior* NWB (Zarr) on S3. That derived asset is resolved from the raw
 * acquisition by name (`<raw>_processed_%`) + the `behavior` modality. Behavior
 * cameras are discovered from the raw asset's `behavior-videos/` folder by the
 * shared harness (approximate sync for now — see CAMSTIM_VIDEO_SYNC_PLAN.md).
 */

import { createPlaybackHarness, fmtTime } from '../lib/behaviors/playback-harness.js';
import { s3LocationToHttps } from '../lib/behaviors/playback-video.js';
import { loadBehaviorEvents } from './behavior-events.js';
import { findStimAt } from './nwb-loader.js';
import {
  MfishAnimation,
  loadMouseSprite,
  loadGaborSprite,
  loadWaterDroplet,
} from './animation.js';
import { createMfishEventPlot } from './event-plot.js';

const SPEED_STEPS = [1, 2, 5, 10, 25, 50];
const DEFAULT_SPEED_IDX = 0;

/**
 * Build the embedded mFISH session player.
 *
 * @param {object} coord - DuckDB coordinator.
 * @param {string} rawAssetName - Raw acquisition asset name.
 * @param {object} [opts]
 * @param {string} [opts.acquisitionType] - Shown in the header row.
 * @param {string} [opts.location]         - Raw asset S3 location (for videos).
 * @returns {HTMLElement}
 */
export function createMfishSessionPlayback(coord, rawAssetName, opts = {}) {
  const harness = createPlaybackHarness({
    taskClass: 'mfish',
    speedSteps: SPEED_STEPS,
    defaultSpeedIdx: DEFAULT_SPEED_IDX,
  });
  const root = harness.root;
  root.classList.add('mfish-player', 'mfish-player--embedded');

  const ctrl = new AbortController();

  (async () => {
    harness.setStatus(`Resolving behavior data for ${rawAssetName}…`);
    try {
      const t0 = performance.now();
      const [data, mouse, gabor, droplet] = await Promise.all([
        loadBehaviorEvents(coord, rawAssetName, { signal: ctrl.signal }),
        loadMouseSprite(),
        loadGaborSprite(),
        loadWaterDroplet(),
      ]);
      if (ctrl.signal.aborted) return;
      if (!data) {
        harness.setStatus('No derived behavior NWB found for this acquisition.', true);
        return;
      }
      const ms = Math.round(performance.now() - t0);
      const stimNoun = data.variant === 'images' ? 'image flashes' : 'gratings';
      const lickTxt = data.counts.licks != null ? `${data.counts.licks} licks · ` : '';
      harness.setStatus(
        `${data.variant} · ${data.counts.stimuli} ${stimNoun} · ${data.counts.changes} changes · ` +
        `${data.counts.rewards} rewards · ${lickTxt}loaded in ${ms} ms`);

      const anim = new MfishAnimation(harness.canvas, data, { mouse, gabor, droplet });
      const plot = createMfishEventPlot(data);

      harness.activate({
        header: {
          count: data.counts.stimuli,
          label: stimNoun,
          acquisitionType: opts.acquisitionType ?? '',
        },
        animation: anim,
        plot: {
          element: plot.element,
          updatePlayhead: plot.updatePlayhead,
          setOnScrub: plot.setOnScrub,
        },
        trialInfo: (el, t) => _updateReadout(el, data, t),
        videos: { base: s3LocationToHttps(opts.location), t0: null, signal: ctrl.signal },
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      harness.setStatus(`Error loading session: ${err.message}`, true);
      console.error('[mFISH] session load failed', err);
    }
  })();

  return root;
}

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------

function _updateReadout(el, data, t) {
  const si = findStimAt(data.stimuli, t);
  const s = si >= 0 ? data.stimuli[si] : null;
  const onNow = s && t >= s.t && t <= s.tEnd && !s.omitted;
  const stimTxt = !onNow ? 'gray (inter-stimulus)'
    : s.ori != null ? `grating ${s.ori}°`
    : `image ${s.label || ''}`;
  el.textContent = `${fmtTime(t)} · stimulus: ${stimTxt}`;
}

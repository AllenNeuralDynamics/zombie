/**
 * bci/player.js — embedded Brain-Computer Interface session playback.
 *
 * This module is intentionally independent from the existing pophys viewer:
 * BCI task data lives in a dedicated behavior NWB-Zarr store with a nested
 * calcium layout. Only the shared playback harness and generic camera/video
 * plumbing are reused.
 */

import { createPlaybackHarness, fmtTime } from '../lib/behaviors/playback-harness.js';
import { s3LocationToHttps } from '../lib/behaviors/playback-video.js';
import { resolveLatestDerived } from '../lib/raw-to-derived.js';
import { findBciTrialAt, loadBciSession } from './data.js';
import { BciAnimation } from './animation.js';
import { createBciEventPlot } from './event-plot.js';
import { createBciPophysViewer } from './pophys.js';
import { loadMouseSprite } from './assets.js';

const SPEED_STEPS = [1, 2, 5, 10, 25, 50];
const DEFAULT_SPEED_IDX = 0;

function loadImage(url, signal) {
  if (!url || typeof Image === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    let onAbort;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    onAbort = () => finish(null);
    image.onload = () => finish(image);
    image.onerror = () => finish(null);
    signal?.addEventListener('abort', onAbort, { once: true });
    image.src = url;
  });
}

/**
 * Build a single BCI playback widget for the subject viewer's Data tab.
 *
 * @param {object} coord - DuckDB coordinator used for raw → derived lookup.
 * @param {string} rawAssetName - Raw acquisition asset name.
 * @param {object} [opts]
 * @param {string} [opts.acquisitionType] - Header label from the acquisition.
 * @param {string} [opts.projectName] - Project name for the header/status.
 * @param {string} [opts.location] - Raw asset S3 location for behavior videos.
 */
export function createBciSessionPlayback(coord, rawAssetName, opts = {}) {
  const harness = createPlaybackHarness({
    taskClass: 'bci',
    speedSteps: SPEED_STEPS,
    defaultSpeedIdx: DEFAULT_SPEED_IDX,
    stepLabel: 'Trial',
  });
  const root = harness.root;
  root.classList.add('bci-player', 'bci-player--embedded');

  const ctrl = new AbortController();

  (async () => {
    harness.setStatus(`Resolving BCI task data for ${rawAssetName}…`);
    try {
      const derived = await resolveLatestDerived(coord, rawAssetName, { modality: 'pophys' });
      if (ctrl.signal.aborted) return;
      if (!derived) {
        harness.setStatus('No derived BCI population-ophys asset found for this acquisition.', true);
        return;
      }

      const [data, mouse] = await Promise.all([
        loadBciSession(derived.name, { signal: ctrl.signal }),
        loadMouseSprite(),
      ]);
      if (ctrl.signal.aborted) return;
      const fov = await loadImage(data.fovUrl, ctrl.signal);
      if (ctrl.signal.aborted) return;

      const anim = new BciAnimation(harness.canvas, data, { mouse, fov });
      const plot = createBciEventPlot(data);

      harness.activate({
        header: {
          count: data.counts.trials,
          label: 'trials',
          acquisitionType: opts.acquisitionType ?? 'BCI single-neuron conditioning',
        },
        animation: anim,
        plot: {
          element: plot.element,
          updatePlayhead: plot.updatePlayhead,
          setOnScrub: plot.setOnScrub,
        },
        trialInfo: (el, t) => updateTrialInfo(el, data, t),
        onStep: (animation, direction) => stepTrial(animation, data, direction),
        videos: { base: s3LocationToHttps(opts.location), t0: null, signal: ctrl.signal },
      });

      // Keep the BCI calcium panel on the same transport clock without adding
      // BCI-specific coupling to the shared playback harness.
      const pophys = createBciPophysViewer(coord, data);
      root.appendChild(pophys.element);
      const harnessOnFrame = anim.onFrame;
      anim.onFrame = (t, ...rest) => {
        harnessOnFrame?.(t, ...rest);
        pophys.updateTime(t);
      };
      pophys.updateTime(anim.t);
      root._dispose = () => {
        ctrl.abort();
        pophys.dispose();
      };
      root.classList.add('bci-player--loaded');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      harness.setStatus(`Error loading BCI session: ${err.message}`, true);
      console.error('[BCI] session load failed', err);
    }
  })();

  return root;
}

function stepTrial(animation, data, direction) {
  const current = findBciTrialAt(data.trials, animation.t);
  const next = current < 0
    ? (direction > 0 ? 0 : data.trials.length - 1)
    : Math.min(data.trials.length - 1, Math.max(0, current + direction));
  animation.seekTo(data.trials[next]?.start ?? 0);
}

function updateTrialInfo(element, data, t) {
  const index = findBciTrialAt(data.trials, t);
  if (index < 0) {
    element.textContent = `${fmtTime(t)} · before first trial`;
    return;
  }
  const trial = data.trials[index];
  const steps = trial.zaberSteps.filter((step) => step <= t).length;
  const roi = trial.roi != null ? `ROI ${trial.roi}` : 'ROI n/a';
  element.textContent =
    `${fmtTime(t)} · trial ${trial.index}/${data.trials.length} · ${trial.hit ? 'HIT' : 'MISS'} · ` +
    `${roi} · steps ${steps}/${trial.zaberSteps.length}`;
}

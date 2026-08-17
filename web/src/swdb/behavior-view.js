/**
 * swdb/behavior-view.js — SWDB behavior playback for one merged-NWB asset.
 *
 * Almost everything here is borrowed: `createPlaybackHarness` supplies the
 * transport, scrubber and layout; `DrAnimation` draws the head-fixed mouse,
 * stimuli and rewards; `createEventPlot` draws the zoomable block/stim/response
 * strip. This module only wires them to the SWDB cache and adds the two readouts
 * that are specific to this data — the trial info line and the session-epoch
 * context strip, which exists because a merged NWB spans far more than the task.
 */

import { createPlaybackHarness } from '../lib/behaviors/playback-harness.js';
import {
  DrAnimation,
  loadMouseSprite,
  loadGaborSprite,
  loadWaterDroplet,
  loadSpeakerIcon,
} from '../dynamic_routing/animation.js';
import { createEventPlot } from '../dynamic_routing/event-plot.js';
import { findTrialAt } from '../dynamic_routing/data-loader.js';
import { escHtml } from '../lib/utils.js';
import { loadSwdbDrSession } from './dr-session.js';

const SPEED_STEPS = [1, 2, 5, 10, 25, 50];

/**
 * Build the behavior playback panel for one SWDB asset.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {string} assetName
 * @param {object} [opts]
 * @param {string} [opts.subjectId] - Shown in the header.
 * @returns {HTMLElement}
 */
export function createSwdbBehaviorView(coord, assetName, opts = {}) {
  const harness = createPlaybackHarness({ taskClass: 'dr', speedSteps: SPEED_STEPS });
  const root = harness.root;
  root.classList.add('dr-player', 'dr-player--embedded', 'swdb-behavior');

  const ctrl = new AbortController();

  (async () => {
    harness.setStatus('Loading behavior from cache…');
    try {
      const t0 = performance.now();
      const [data, [mouse, gabor, droplet, speaker]] = await Promise.all([
        loadSwdbDrSession(coord, { assetName, signal: ctrl.signal }),
        Promise.all([loadMouseSprite(), loadGaborSprite(), loadWaterDroplet(), loadSpeakerIcon()]),
      ]);
      if (ctrl.signal.aborted) return;

      const ms = Math.round(performance.now() - t0);
      harness.setStatus(
        `${data.trials.length} trials · ${data.blocks.length} blocks · `
        + `${data.responses.t.length} licks · ${data.rewards.t.length} rewards · loaded in ${ms} ms`,
      );

      const anim = new DrAnimation(harness.canvas, data, { mouse, gabor, droplet, speaker });
      const plot = createEventPlot(data);

      const plotWrap = document.createElement('div');
      plotWrap.appendChild(plot.element);
      plotWrap.appendChild(buildLegend());
      if (data.epochs.length > 0) plotWrap.appendChild(buildEpochStrip(data));

      harness.activate({
        header: {
          count: data.trials.length,
          label: 'trials',
          acquisitionType: opts.subjectId ? `subject ${opts.subjectId}` : '',
        },
        animation: anim,
        plot: {
          element: plotWrap,
          updatePlayhead: plot.updatePlayhead,
          setOnScrub: plot.setOnScrub,
        },
        trialInfo: (el, t) => updateTrialInfo(el, data, t),
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      harness.setStatus(`Error loading behavior: ${err.message}`, true);
      console.error('[SWDB] behavior load failed', err);
    }
  })();

  root._dispose = () => ctrl.abort();
  return root;
}

/**
 * Session-epoch context strip.
 *
 * A merged NWB holds the whole acquisition — RF mapping, optotagging and
 * spontaneous blocks around the task — while the player's clock starts at the first
 * task trial. This strip shows where the task sits inside that session so a
 * negative or beyond-the-end epoch reads as intentional rather than as a bug.
 *
 * @param {object} data - Session object from `loadSwdbDrSession`.
 * @returns {HTMLElement}
 */
export function buildEpochStrip(data) {
  const el = document.createElement('div');
  el.className = 'swdb-epoch-strip';

  const starts = data.epochs.map((e) => e.start_t);
  const stops = data.epochs.map((e) => e.stop_t);
  const lo = Math.min(0, ...starts);
  const hi = Math.max(data.sessionEndS, ...stops);
  const span = hi - lo || 1;
  const pct = (v) => `${((v - lo) / span) * 100}%`;

  const bar = document.createElement('div');
  bar.className = 'swdb-epoch-bar';
  for (const epoch of data.epochs) {
    const seg = document.createElement('div');
    seg.className = 'swdb-epoch-seg';
    seg.style.left = pct(epoch.start_t);
    seg.style.width = `${((epoch.stop_t - epoch.start_t) / span) * 100}%`;
    seg.title = `${epoch.label} · ${fmtSpan(epoch.start_t, epoch.stop_t)}`;
    seg.textContent = epoch.label;
    bar.appendChild(seg);
  }

  // The playable window (the task) highlighted inside the full session.
  const task = document.createElement('div');
  task.className = 'swdb-epoch-task';
  task.style.left = pct(0);
  task.style.width = `${(data.sessionEndS / span) * 100}%`;
  task.title = 'Task window shown in the player above';
  bar.appendChild(task);

  el.appendChild(Object.assign(document.createElement('div'), {
    className: 'swdb-epoch-label',
    textContent: 'Session epochs',
  }));
  el.appendChild(bar);
  return el;
}

function fmtSpan(a, b) {
  const mins = (v) => `${(v / 60).toFixed(1)} min`;
  return `${mins(a)} → ${mins(b)}`;
}

/**
 * Update the per-trial readout under the animation canvas.
 *
 * @param {HTMLElement} el
 * @param {object} data
 * @param {number} t
 */
export function updateTrialInfo(el, data, t) {
  const idx = findTrialAt(data.trials, t);
  if (idx < 0) {
    el.textContent = 'before first trial';
    return;
  }
  const tr = data.trials[idx];
  const outcome = tr.isHit ? 'hit'
    : tr.isMiss ? 'miss'
      : tr.isFA ? 'false alarm'
        : tr.isCR ? 'correct reject'
          : tr.isCatch ? 'catch'
            : '–';
  const tags = [];
  if (tr.isAutoRew) tags.push('autoreward');
  if (tr.isOpto) tags.push('opto');
  el.innerHTML =
    `trial <strong>${tr.trial + 1}</strong> / ${data.trials.length}`
    + ` · block ${tr.block + 1} (${escHtml(tr.rewardedMod ?? '?')} rewarded)`
    + ` · ${escHtml(tr.stim ?? '?')}`
    + ` · <span class="swdb-outcome swdb-outcome--${outcome.replace(/ /g, '-')}">${outcome}</span>`
    + (tags.length ? ` · ${escHtml(tags.join(', '))}` : '');
}

/** Block / stim colour legend, reusing the Dynamic Routing legend styles. */
function buildLegend() {
  const el = document.createElement('div');
  el.className = 'dr-legend';
  el.innerHTML = `
    <span class="dr-legend-item"><span class="dr-swatch" style="background:#7c3aed"></span>visual block</span>
    <span class="dr-legend-item"><span class="dr-swatch" style="background:#f59e0b"></span>auditory block</span>
    <span class="dr-legend-item"><span class="dr-tick" style="background:#1e40af"></span>vis target</span>
    <span class="dr-legend-item"><span class="dr-tick" style="background:#60a5fa"></span>vis nontarget</span>
    <span class="dr-legend-item"><span class="dr-tick" style="background:#b91c1c"></span>aud target</span>
    <span class="dr-legend-item"><span class="dr-tick" style="background:#fca5a5"></span>aud nontarget</span>
    <span class="dr-legend-item"><span class="dr-tick" style="background:#9ca3af"></span>catch</span>
    <span class="dr-legend-item"><span class="dr-line dr-line-solid"></span>target response rate</span>
    <span class="dr-legend-item"><span class="dr-line dr-line-dashed"></span>cross-modal FA rate</span>
    <span class="dr-legend-item"><span class="dr-tick" style="background:#222"></span>licks (real lick stream)</span>
  `;
  return el;
}

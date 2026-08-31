/**
 * swdb/dr-switch-replay.js — "replay block-switch activity" control bar for the
 * Dynamic Routing neuron overview.
 *
 * Every Dynamic Routing session has exactly 5 block switches (aud_to_vis or
 * vis_to_aud); `platform_swdb_dr_switch` (built once by biodata-cache, see
 * `platform_swdb_dr_switch.py`) already gives each QC-passing unit its own
 * average firing-rate time course across its own session's switches of a given
 * direction, with each of the 5 block-switch trials linearly time-warped onto
 * its own unit-width slot of a shared template (x = 0..5; every integer is a
 * real trial boundary, 2 is the switch trial's own onset) -- never collapsed
 * onto a single real-time axis, which would smear together events that land at
 * different real times in different instances. `platform_swdb_dr_switch_markers`
 * gives the warped stim/response/reward event positions for the same template,
 * so the trial-timing plot (dr-switch-plot.js) can show *where* the clock is
 * within the 5 trials, not just play a number.
 *
 * Off by default: this is an analysis overlay on top of the plain neuron
 * overview, not something every visitor to the page should be forced to load
 * or look at, so it starts collapsed behind a toggle button and every neuron
 * renders at its normal fixed size until the toggle is switched on.
 */

import { loadSwdbDrSwitchActivity, loadSwdbDrSwitchMarkers, DR_SWITCH_DIRECTIONS } from './data.js';
import { createDrSwitchPlot } from './dr-switch-plot.js';

const DIRECTION_LABELS = {
  vis_to_aud: 'visual → auditory',
  aud_to_vis: 'auditory → visual',
};

// Template units advanced per real second. The template runs 0..5 (5
// block-switch trials); at 0.5 units/s one full replay cycle takes 10s.
const PLAYBACK_RATE = 0.5;

// Default cube-scale multiplier at the max-firing cutoff, applied on top of
// the fixed ACTIVITY_MIN_SCALE floor a unit at rate 0 always draws at (see
// unit-viz-3d.js). Not imported from there so this module never pulls in that
// module's eager `three` dependency until the 3D viewer itself is loaded.
const DEFAULT_MAX_SCALE = 7;
const MAX_SCALE_RANGE = { min: 1, max: 15, step: 0.5 };

// Default max-firing cutoff (Hz): a fixed, generously high ceiling rather than
// a data-dependent percentile, so the same slider position means the same
// thing session to session.
const DEFAULT_REF_RATE = 250;

/**
 * Build the replay control bar. Call `attach(viewer, units)` once the 3D
 * viewer and its unit list are ready, and `reset()`/`hide()` when the
 * underlying session set changes or has no units.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @returns {{element: HTMLElement, attach: Function, reset: Function, hide: Function, dispose: Function}}
 */
export function createDrSwitchReplay(coord) {
  const element = document.createElement('div');
  element.className = 'swdb-dr-switch-replay';
  element.hidden = true;
  element.innerHTML = `
    <button type="button" class="swdb-dr-switch-toggle">▶ Show block-switch activity replay</button>
    <div class="swdb-dr-switch-body" hidden>
      <div class="swdb-dr-switch-replay-bar">
        <label class="swdb-dr-switch-replay-direction">
          Block switch
          <select class="swdb-dr-switch-direction">
            ${DR_SWITCH_DIRECTIONS.map((d) => `<option value="${d}">${DIRECTION_LABELS[d] ?? d}</option>`).join('')}
          </select>
        </label>
        <button type="button" class="swdb-dr-switch-play" disabled>▶ Play</button>
        <label class="swdb-dr-switch-size-label" for="swdb-dr-switch-size" title="How big the largest cube gets, relative to a resting neuron">Size</label>
        <input type="range" id="swdb-dr-switch-size" class="swdb-dr-switch-size"
          min="${MAX_SCALE_RANGE.min}" max="${MAX_SCALE_RANGE.max}" step="${MAX_SCALE_RANGE.step}"
          value="${DEFAULT_MAX_SCALE}" />
        <span class="swdb-dr-switch-size-value">${DEFAULT_MAX_SCALE.toFixed(1)}×</span>
        <label class="swdb-dr-switch-size-label" for="swdb-dr-switch-cutoff" title="Firing rate that saturates to the largest cube -- lower it to make lower-firing neurons stand out more">Cutoff</label>
        <input type="range" id="swdb-dr-switch-cutoff" class="swdb-dr-switch-cutoff" min="0" max="${DEFAULT_REF_RATE}" step="1" value="${DEFAULT_REF_RATE}" disabled />
        <span class="swdb-dr-switch-cutoff-value">–</span>
      </div>
      <div class="swdb-dr-switch-plot-mount"></div>
      <p class="swdb-dr-switch-status swdb-panel-caption"></p>
    </div>
  `;

  const toggleBtn = element.querySelector('.swdb-dr-switch-toggle');
  const bodyEl = element.querySelector('.swdb-dr-switch-body');
  const directionSel = element.querySelector('.swdb-dr-switch-direction');
  const playBtn = element.querySelector('.swdb-dr-switch-play');
  const sizeSlider = element.querySelector('.swdb-dr-switch-size');
  const sizeValueEl = element.querySelector('.swdb-dr-switch-size-value');
  const cutoffSlider = element.querySelector('.swdb-dr-switch-cutoff');
  const cutoffValueEl = element.querySelector('.swdb-dr-switch-cutoff-value');
  const plotMount = element.querySelector('.swdb-dr-switch-plot-mount');
  const statusEl = element.querySelector('.swdb-dr-switch-status');

  let viewer = null;
  let units = [];
  let loadCtrl = null;
  let plot = null;
  let domain = null; // [0, 5] template units (always fixed, see dr-switch-plot.js)
  let t = 0;
  let playing = false;
  let rafId = null;
  let lastReal = null;
  let expanded = false;
  let loadedDirection = null; // direction currently held by viewer/plot, or null if never loaded
  let lastByKey = null;

  function stopPlayback() {
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    playBtn.textContent = '▶ Play';
  }

  function seek(nextT) {
    if (!domain) return;
    t = Math.max(domain[0], Math.min(domain[1], nextT));
    plot?.updatePlayhead(t);
    viewer?.setActivityTime(t);
  }

  function loop(real) {
    if (!playing) return;
    const dt = (real - lastReal) / 1000;
    lastReal = real;
    let next = t + dt * PLAYBACK_RATE;
    if (next > domain[1]) next = domain[0]; // loop back to trial -2
    seek(next);
    rafId = requestAnimationFrame(loop);
  }

  function maxObservedRate(byKey) {
    let max = 0;
    for (const series of byKey.values()) {
      for (const rate of series.rates) if (rate > max) max = rate;
    }
    return max;
  }

  /** Configure the cutoff slider's range around DEFAULT_REF_RATE, widening it only if the data actually exceeds that ceiling. */
  function configureCutoffSlider(byKey) {
    const max = Math.max(maxObservedRate(byKey), DEFAULT_REF_RATE);
    cutoffSlider.min = '0';
    cutoffSlider.max = String(max);
    cutoffSlider.step = String(Math.max(1, max / 250));
    cutoffSlider.value = String(DEFAULT_REF_RATE);
    cutoffSlider.disabled = false;
    cutoffValueEl.textContent = `${DEFAULT_REF_RATE.toFixed(1)} Hz`;
  }

  /** Re-key `platform_swdb_dr_switch` rows onto the 3D view's own unit keys. */
  function buildActivityMap(rows) {
    const keyByAcquisitionUnit = new Map(units.map((u) => [`${u.acquisition}::${u.unitName}`, u.key]));
    const byKey = new Map();
    for (const row of rows) {
      const unitKey = keyByAcquisitionUnit.get(`${row.asset_name}::${row.unit_id}`);
      if (!unitKey) continue; // not QC-passing, or not one of the units currently shown
      let series = byKey.get(unitKey);
      if (!series) {
        series = { times: [], rates: [] };
        byKey.set(unitKey, series);
      }
      series.times.push(Number(row.template_x));
      series.rates.push(Number(row.mean_rate_hz));
    }
    for (const series of byKey.values()) {
      series.times = Float64Array.from(series.times);
      series.rates = Float64Array.from(series.rates);
    }
    return byKey;
  }

  function mountPlot(direction, markers, rows) {
    plot?.dispose();
    plot = createDrSwitchPlot({ direction, markers, activityRows: rows });
    plotMount.replaceChildren(plot.element);
    plot.setOnScrub((nextT) => { stopPlayback(); seek(nextT); });
    domain = plot.domain;
  }

  async function loadDirection(direction) {
    stopPlayback();
    domain = null;
    playBtn.disabled = true;
    statusEl.textContent = 'Loading block-switch activity…';

    loadCtrl?.abort();
    const ctrl = new AbortController();
    loadCtrl = ctrl;
    try {
      const [rows, markers] = await Promise.all([
        loadSwdbDrSwitchActivity(coord, direction, { signal: ctrl.signal }),
        loadSwdbDrSwitchMarkers(coord, direction),
      ]);
      if (ctrl.signal.aborted) return;
      const byKey = buildActivityMap(rows);
      lastByKey = byKey;
      loadedDirection = direction;
      if (byKey.size === 0) {
        statusEl.textContent = 'No block-switch activity matched these neurons.';
        viewer?.clearActivityData();
        plot?.dispose();
        plot = null;
        plotMount.replaceChildren();
        cutoffSlider.disabled = true;
        cutoffValueEl.textContent = '–';
        return;
      }
      configureCutoffSlider(byKey);
      mountPlot(direction, markers, rows);
      if (expanded) {
        viewer?.setActivityData(byKey, { maxScale: Number(sizeSlider.value), refRate: Number(cutoffSlider.value) });
      }
      playBtn.disabled = false;
      seek(domain[0]);
      statusEl.textContent = `${byKey.size.toLocaleString()} QC-passing neurons with activity around this switch. `
        + 'Cube size = firing rate, averaged across every matching block switch in each neuron’s own session.';
    } catch (error) {
      if (ctrl.signal.aborted) return;
      statusEl.textContent = `Could not load block-switch activity: ${error.message}`;
      console.error('[SWDB] block-switch activity load failed', error);
    }
  }

  function expand() {
    expanded = true;
    bodyEl.hidden = false;
    toggleBtn.textContent = '✕ Hide block-switch activity replay';
    if (loadedDirection === directionSel.value && lastByKey) {
      // already loaded — just re-apply, no refetch
      viewer?.setActivityData(lastByKey, {
        maxScale: Number(sizeSlider.value),
        refRate: Number(cutoffSlider.value),
      });
    } else {
      loadDirection(directionSel.value);
    }
  }

  function collapse() {
    expanded = false;
    stopPlayback();
    bodyEl.hidden = true;
    toggleBtn.textContent = '▶ Show block-switch activity replay';
    viewer?.clearActivityData(); // back to normal fixed-size neurons
  }

  toggleBtn.addEventListener('click', () => (expanded ? collapse() : expand()));
  directionSel.addEventListener('change', () => loadDirection(directionSel.value));
  sizeSlider.addEventListener('input', () => {
    const maxScale = Number(sizeSlider.value);
    sizeValueEl.textContent = `${maxScale.toFixed(1)}×`;
    viewer?.setActivityMaxScale(maxScale);
  });
  cutoffSlider.addEventListener('input', () => {
    const refRate = Number(cutoffSlider.value);
    cutoffValueEl.textContent = `${refRate.toFixed(1)} Hz`;
    viewer?.setActivityRefRate(refRate);
  });
  playBtn.addEventListener('click', () => {
    if (!domain) return;
    if (playing) { stopPlayback(); return; }
    playing = true;
    lastReal = performance.now();
    playBtn.textContent = '⏸ Pause';
    rafId = requestAnimationFrame(loop);
  });

  return {
    element,
    /** Call once the 3D viewer and its unit list are ready. Starts collapsed. */
    attach(nextViewer, nextUnits) {
      viewer = nextViewer;
      units = nextUnits;
      element.hidden = false;
    },
    /** Call when the underlying session set is about to reload. */
    reset() {
      stopPlayback();
      loadCtrl?.abort();
      plot?.dispose();
      plot = null;
      plotMount.replaceChildren();
      viewer = null;
      units = [];
      domain = null;
      loadedDirection = null;
      lastByKey = null;
      expanded = false;
      bodyEl.hidden = true;
      toggleBtn.textContent = '▶ Show block-switch activity replay';
      cutoffSlider.disabled = true;
      cutoffValueEl.textContent = '–';
      element.hidden = true;
      statusEl.textContent = '';
    },
    hide() {
      element.hidden = true;
    },
    dispose() {
      stopPlayback();
      loadCtrl?.abort();
      plot?.dispose();
    },
  };
}

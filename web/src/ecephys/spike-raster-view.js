/**
 * spike-raster-view.js — the "unit lanes" playback strip.
 *
 * Rendered between the behavior plot and the camera videos while the Spike
 * Jukebox is active. One horizontal lane per mapped unit; each spike is a tick.
 *
 * The strip scrolls by REAL transport time (not corridor position): a fixed
 * RASTER_VIEW.windowS-second window scrolls steadily left as playback advances,
 * with the playhead fixed at MOUSE_X (matching the corridor's mouse position so
 * the two views read similarly). Ticks to the RIGHT of the playhead are spikes
 * that will fire soon; when a tick reaches the playhead the note sounds and the
 * lane briefly flashes.
 */

import { MOUSE_X } from '../vr_foraging/animation.js';
import { isDarkMode } from '../vr_foraging/theme.js';
import { midiName } from './midi-sonifier.js';
import { RASTER_VIEW } from './midi-config.js';

const LABEL_W = 92;   // left gutter for the unit label + note name

function colors() {
  return isDarkMode()
    ? { bg: '#1e1e1e', lane: '#262626', laneAlt: '#222', edge: '#3a3a3a',
        playhead: '#e74c3c', text: '#bbb', future: 0.5 }
    : { bg: '#ffffff', lane: '#f6f6f6', laneAlt: '#efefef', edge: '#dcdcdc',
        playhead: '#c0392b', text: '#555', future: 0.5 };
}

/** Binary search: index of first element >= v. */
function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * @param {object} opts
 * @param {object} opts.anim - VrfAnimation (provides t and logicalW).
 * @param {Array<{unitName:string, times:Float64Array, note:number,
 *   color:string}>} opts.units - mapped units.
 * @returns {{ element:HTMLElement, render:()=>void, flash:(unitName:string)=>void,
 *   destroy:()=>void }}
 */
export function createSpikeRasterView({ anim, units, onToggleMute }) {
  const laneH = RASTER_VIEW.laneHeightPx;
  const laneGap = RASTER_VIEW.laneGapPx;
  const pad = RASTER_VIEW.padPx;
  const rowH = laneH + laneGap;
  const height = pad * 2 + rowH * units.length;

  const element = document.createElement('div');
  element.className = 'midi-raster';
  element.innerHTML = `
    <div class="midi-raster-label">
      <span>Spike jukebox — mapped units firing (${RASTER_VIEW.windowS}s window) →</span>
      <button class="midi-raster-mute" type="button" title="Mute / unmute spike sounds"><span class="material-icons">volume_up</span></button>
    </div>
    <canvas class="midi-raster-canvas"></canvas>
  `;
  const canvas = element.querySelector('.midi-raster-canvas');
  const ctx = canvas.getContext('2d');

  const muteBtn = element.querySelector('.midi-raster-mute');
  const muteIcon = muteBtn.querySelector('.material-icons');
  muteBtn.onclick = () => {
    const on = onToggleMute ? onToggleMute() : true;
    muteIcon.textContent = on ? 'volume_up' : 'volume_off';
  };

  const flashUntil = new Map();   // unit_name -> performance.now ms

  function sizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max((anim && anim.logicalW) || 480, 480);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return w;
  }

  function render() {
    const W = sizeCanvas();
    const C = colors();
    const nowT = anim ? anim.t : 0;
    const plotW = W - LABEL_W;
    // Steady time→pixel scale: the whole strip spans windowS transport seconds.
    const pxPerSec = plotW / RASTER_VIEW.windowS;
    // Playhead fixed at MOUSE_X: window = [westT (past) .. eastT (future)].
    const westT = nowT - MOUSE_X / pxPerSec;
    const eastT = nowT + (plotW - MOUSE_X) / pxPerSec;
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : 0);

    const timeToX = (ts) => LABEL_W + MOUSE_X + (ts - nowT) * pxPerSec;

    ctx.clearRect(0, 0, W, height);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, height);

    units.forEach((u, row) => {
      const y = pad + row * rowH;
      const flashing = (flashUntil.get(u.unitName) ?? 0) > nowMs;
      ctx.fillStyle = flashing ? u.color : (row % 2 ? C.laneAlt : C.lane);
      ctx.globalAlpha = flashing ? 0.35 : 1;
      ctx.fillRect(LABEL_W, y, plotW, laneH);
      ctx.globalAlpha = 1;

      ctx.fillStyle = C.text;
      ctx.font = '10px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${u.unitName.slice(0, 6)} ${midiName(u.note)}`, 4, y + laneH / 2);

      const times = u.times;
      let i = lowerBound(times, westT);
      ctx.fillStyle = u.color;
      for (; i < times.length; i++) {
        const ts = times[i];
        if (ts > eastT) break;
        const x = timeToX(ts);
        ctx.globalAlpha = ts > nowT ? C.future : 1;   // upcoming spikes dimmer
        ctx.fillRect(x - RASTER_VIEW.tickWidthPx / 2, y + 1, RASTER_VIEW.tickWidthPx, laneH - 2);
      }
      ctx.globalAlpha = 1;
    });

    // Playhead line at MOUSE_X.
    ctx.fillStyle = C.playhead;
    ctx.fillRect(LABEL_W + MOUSE_X - 1, 0, 2, height);
    // Gutter edge.
    ctx.fillStyle = C.edge;
    ctx.fillRect(LABEL_W, 0, 1, height);
  }

  return {
    element,
    render,
    flash(unitName) {
      const nowMs = (typeof performance !== 'undefined' ? performance.now() : 0);
      flashUntil.set(unitName, nowMs + RASTER_VIEW.flashS * 1000);
    },
    destroy() { element.remove(); },
  };
}

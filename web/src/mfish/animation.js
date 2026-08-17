/**
 * mfish/animation.js — head-fixed mouse animation for the Learning mFISH
 * orientation-change-detection session player.
 *
 * Layout mirrors the Dynamic Routing player (single central lick spout under
 * the mouse), but the stimulus is a full-field grating whose orientation
 * changes over the session:
 *
 *   - a gabor/grating patch is shown above the mouse, rotated to the current
 *     orientation (0 / 90 / 180 / 270°);
 *   - each orientation change briefly pulses the patch;
 *   - auto-rewards drop a water droplet under the spout;
 *   - licks dart a tongue up toward the spout;
 *   - running speed is shown as a small gauge at the bottom.
 */

import { findStimAt } from './nwb-loader.js';

// ---------------------------------------------------------------------------
// Layout constants (shared visual language with dynamic_routing/animation.js)
// ---------------------------------------------------------------------------

export const CW = 320;
export const CH = 360;

const MOUSE_IMG_W = 240;
const MOUSE_IMG_H = MOUSE_IMG_W * (1068 / 1324);
const MOUSE_CX    = CW / 2;
const MOUSE_TOP   = 130;
const NOSE_X      = MOUSE_CX;
const NOSE_Y      = MOUSE_TOP + 18;

const SPOUT_W = 18;
const SPOUT_H = 70;
const SPOUT_X        = NOSE_X - SPOUT_W / 2;
const SPOUT_REST_Y   = NOSE_Y - SPOUT_H + 28;
const SPOUT_COLOR    = '#4b5563';

const TONGUE_COLOR  = '#ff7faa';
const TONGUE_STROKE = '#c14d7a';

const STIM_AREA_CX = CW / 2;
const STIM_AREA_CY = 62;
const STIM_AREA_R  = 52;

const LICK_DECAY_S   = 0.14;
const REWARD_DECAY_S = 0.5;
const CHANGE_DECAY_S = 0.6;

// Orientation → hue (also used by the event plot).
export const ORI_COLORS = {
  0:   '#2563eb',  // blue
  90:  '#16a34a',  // green
  180: '#f59e0b',  // amber
  270: '#db2777',  // magenta
};
export function oriColor(ori) { return ORI_COLORS[((ori % 360) + 360) % 360] ?? '#6b7280'; }

// ---------------------------------------------------------------------------
// Sprite loaders (reuse the existing DR / DF sprite assets)
// ---------------------------------------------------------------------------

export function loadMouseSprite(url = '/images/df/mouse_head_dorsal.png') {
  return _loadImage(url, 'mouse');
}
export function loadGaborSprite(url = '/images/dr/gabor.png') {
  return _loadImage(url, 'gabor');
}
export function loadWaterDroplet(url = '/images/water-droplet.png') {
  return _loadImage(url, 'droplet');
}
function _loadImage(url, label) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => { console.warn(`[mFISH] ${label} sprite failed to load`); resolve(null); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// MfishAnimation
// ---------------------------------------------------------------------------

export class MfishAnimation {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} data    from loadMfishSession
   * @param {object} sprites { mouse, gabor, droplet }
   */
  constructor(canvas, data, sprites = {}) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.data    = data;
    this.sprites = sprites;
    this.duration = data.sessionEndS;

    canvas.width  = CW;
    canvas.height = CH;

    this.t       = 0;
    this.playing = false;
    this.speed   = 1;
    this.onFrame = null;

    this._changeTimes = data.changes ?? new Float64Array();

    this._rafId    = null;
    this._lastReal = null;
    this._loop = this._loop.bind(this);
  }

  // ---- Public API -------------------------------------------------------

  play() {
    if (this.playing) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing   = true;
    this._lastReal = performance.now();
    this._rafId    = requestAnimationFrame(this._loop);
  }

  pause() {
    this.playing = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  seekTo(t) {
    this.t = Math.max(0, Math.min(this.duration, t));
    this._render();
    if (this.onFrame) this.onFrame(this.t);
  }

  setSpeed(s) { this.speed = Math.max(0.1, s); }

  // ---- Internal ---------------------------------------------------------

  _loop(realNow) {
    if (!this.playing) return;
    const dt = (realNow - this._lastReal) / 1000;
    this._lastReal = realNow;
    this.t = Math.min(this.duration, this.t + dt * this.speed);

    this._render();
    if (this.onFrame) this.onFrame(this.t);

    if (this.t >= this.duration) { this.pause(); return; }
    this._rafId = requestAnimationFrame(this._loop);
  }

  /** Decaying activity (0..1) for the most-recent event in a sorted array. */
  _recentActivity(times, decayS, scaleWithSpeed = false) {
    if (!times || times.length === 0) return 0;
    const t = this.t;
    let lo = 0, hi = times.length - 1, i = -1;
    if (t >= times[0]) {
      if (t >= times[hi]) i = hi;
      else {
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (times[mid] <= t) lo = mid; else hi = mid - 1;
        }
        i = lo;
      }
    }
    if (i < 0) return 0;
    const decay = scaleWithSpeed ? decayS * Math.sqrt(Math.max(1, this.speed)) : decayS;
    const age = t - times[i];
    if (age > decay) return 0;
    return 1 - age / decay;
  }

  _currentStim() {
    const idx = findStimAt(this.data.stimuli, this.t);
    if (idx < 0) return null;
    const s = this.data.stimuli[idx];
    if (this.t < s.t || this.t > s.tEnd) return null;
    return s;
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CW, CH);

    this._drawHeaderBanner(ctx);

    const stim = this._currentStim();
    if (stim && !stim.omitted) {
      const change = this._recentActivity(this._changeTimes, CHANGE_DECAY_S);
      this._drawStim(ctx, stim, change);
    }

    this._drawSpout(ctx);

    if (this.sprites.mouse) {
      ctx.drawImage(this.sprites.mouse, MOUSE_CX - MOUSE_IMG_W / 2, MOUSE_TOP, MOUSE_IMG_W, MOUSE_IMG_H);
    } else {
      ctx.fillStyle = '#bbb';
      ctx.beginPath();
      ctx.ellipse(MOUSE_CX, MOUSE_TOP + 90, 90, 110, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const lick = this.data.licks ? this._recentActivity(this.data.licks, LICK_DECAY_S) : 0;
    if (lick > 0) this._drawTongue(ctx, lick);

    const rew = this._recentActivity(this.data.rewards, REWARD_DECAY_S, true);
    if (rew > 0) this._drawDroplet(ctx, rew);
  }

  // ---- Drawers ----------------------------------------------------------

  _drawHeaderBanner(ctx) {
    const s = this._currentStim();
    const color = s && s.ori != null ? oriColor(s.ori) : (s ? '#6366f1' : '#9ca3af');
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, CW, 26);
    ctx.restore();
    ctx.fillStyle = color;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const txt = !s ? 'inter-stimulus (gray screen)'
      : s.omitted ? 'omitted flash'
      : s.ori != null ? `grating ${s.ori}°`
      : `image ${s.label}`;
    ctx.fillText(txt, CW / 2, 13);
  }

  _drawStim(ctx, stim, change) {
    const isGrating = stim.ori != null;
    const color = isGrating ? oriColor(stim.ori) : '#6366f1';
    const pulse = 1 + 0.12 * change;

    ctx.save();
    ctx.translate(STIM_AREA_CX, STIM_AREA_CY);

    // Change-onset halo.
    if (change > 0) {
      ctx.save();
      ctx.globalAlpha = 0.22 * change;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, (STIM_AREA_R + 8) * pulse, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Circular clip so the stimulus reads as a patch.
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, STIM_AREA_R * pulse, 0, Math.PI * 2);
    ctx.clip();
    const sz = STIM_AREA_R * 2 * pulse;
    if (isGrating && this.sprites.gabor) {
      ctx.rotate((stim.ori * Math.PI) / 180);
      ctx.drawImage(this.sprites.gabor, -sz / 2, -sz / 2, sz, sz);
    } else {
      // Natural-image variant: no sprite available, so show a neutral patch
      // with the image name (drawn after unclipping, below).
      ctx.fillStyle = isGrating ? color : '#e5e7eb';
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
    }
    ctx.restore();

    // Image label (natural-image variant).
    if (!isGrating) {
      ctx.fillStyle = '#374151';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(stim.label || 'image', 0, 0);
    }

    // Orientation / stimulus ring.
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, STIM_AREA_R * pulse + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  _drawSpout(ctx) {
    const x = SPOUT_X;
    const y = SPOUT_REST_Y;
    ctx.fillStyle   = SPOUT_COLOR;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth   = 1;
    _roundRect(ctx, x, y, SPOUT_W, SPOUT_H, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    _roundRect(ctx, x + 3, y + 4, 4, SPOUT_H - 14, 2);
    ctx.fill();
  }

  _drawDroplet(ctx, activity) {
    const cx = NOSE_X;
    const imgSize = 20;
    const imgY = SPOUT_REST_Y + SPOUT_H - imgSize * 1.4;
    if (this.sprites.droplet) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, 0.45 + 0.55 * activity);
      ctx.drawImage(this.sprites.droplet, cx - imgSize / 2, imgY, imgSize, imgSize);
      ctx.restore();
    }
  }

  _drawTongue(ctx, activity) {
    const reach = 22 * Math.max(0.4, activity);
    const ry    = Math.max(8, reach * 0.7);
    const rx    = 5 + activity * 1.5;

    ctx.save();
    ctx.translate(NOSE_X, NOSE_Y - reach / 2);
    ctx.fillStyle   = TONGUE_COLOR;
    ctx.strokeStyle = TONGUE_STROKE;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(140,60,100,0.5)';
    ctx.beginPath();
    ctx.moveTo(0, -ry * 0.7);
    ctx.lineTo(0,  ry * 0.7);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/**
 * mfish/animation.js — head-fixed mouse animation for the Learning mFISH
 * orientation-change-detection session player.
 *
 * Layout mirrors the Dynamic Routing player (single central lick spout under
 * the mouse), but the stimulus is a full-field grating whose orientation
 * changes over the session:
 *
 *   - a gabor/grating patch is shown above the mouse, rotated to the current
 *     orientation (0 / 90 / 180 / 270°), or the matching NWB stimulus image
 *     is loaded on demand for image stages;
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
   * @param {object} sprites { mouse, gabor, droplet, templateLoader, stageMode }
   */
  constructor(canvas, data, sprites = {}) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.data    = data;
    this.sprites = sprites;
    this.stageMode = sprites.stageMode ?? data.stageMode ?? data.variant;
    this.duration = data.sessionEndS;

    canvas.width  = CW;
    canvas.height = CH;

    this.t       = 0;
    this.playing = false;
    this.speed   = 1;
    this.onFrame = null;

    this._changeTimes = data.changes ?? new Float64Array();
    this._templateCache = new Map();
    this._disposed = false;

    this._rafId    = null;
    this._lastReal = null;
    this._loop = this._loop.bind(this);
  }

  // ---- Public API -------------------------------------------------------

  play() {
    if (this._disposed) return;
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

  dispose() {
    this.pause();
    this._disposed = true;
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
    if (this._disposed) return;
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
    const isGrating = this.stageMode === 'gratings';
    const color = s && isGrating && s.ori != null ? oriColor(s.ori) : (s ? '#6366f1' : '#9ca3af');
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
      : isGrating ? `grating ${s.ori ?? '—'}°`
      : `image ${s.label}`;
    ctx.fillText(txt, CW / 2, 13);
  }

  _drawStim(ctx, stim, change) {
    const isGrating = this.stageMode === 'gratings';
    const color = isGrating && stim.ori != null ? oriColor(stim.ori) : '#6366f1';
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
    const image = !isGrating ? this._getStimulusTemplate(stim.label) : null;
    if (isGrating && this.sprites.gabor) {
      ctx.rotate((stim.ori * Math.PI) / 180);
      ctx.drawImage(this.sprites.gabor, -sz / 2, -sz / 2, sz, sz);
    } else if (image) {
      ctx.drawImage(image, -sz / 2, -sz / 2, sz, sz);
    } else {
      // Keep a useful placeholder while the selected image plane is loading,
      // or when an older behavior derivative has no template pixels.
      ctx.fillStyle = isGrating ? color : '#e5e7eb';
      ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
    }
    ctx.restore();

    // Image label (natural-image variant) remains the fallback for derivatives
    // that do not carry a stimulus template stack.
    if (!isGrating && !image) {
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

  _getStimulusTemplate(label) {
    const key = String(label ?? '').trim();
    const loader = this.sprites.templateLoader;
    if (!key || !loader?.get) return null;

    const cached = this._templateCache.get(key);
    if (cached) return cached.status === 'ready' ? cached.image : null;

    this._templateCache.set(key, { status: 'loading' });
    Promise.resolve()
      .then(() => loader.get(key))
      .then((template) => {
        if (this._disposed) return;
        const image = template ? _templateToCanvas(template) : null;
        this._templateCache.set(key, {
          status: image ? 'ready' : 'missing',
          image,
        });
        this._render();
      })
      .catch(() => {
        if (this._disposed) return;
        this._templateCache.set(key, { status: 'missing', image: null });
        this._render();
      });
    return null;
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

/** Convert one Zarr image plane into a small canvas for repeated drawing. */
function _templateToCanvas(template) {
  const values = template?.data;
  const shape = Array.from(template?.shape ?? [], Number);
  if (!values || shape.length < 2 || shape.some((size) => !(size > 0))) return null;

  let height;
  let width;
  let channels = 1;
  let channelFirst = false;
  if (shape.length === 2) {
    [height, width] = shape;
  } else if (shape.length === 3 && shape[2] <= 4) {
    [height, width, channels] = shape;
  } else if (shape.length === 3 && shape[0] <= 4) {
    [channels, height, width] = shape;
    channelFirst = true;
  } else {
    return null;
  }

  const expected = height * width * channels;
  if (values.length < expected) return null;
  const maxValue = _templateMax(values, expected);
  const scale = maxValue <= 1.01 ? 255 : 1;
  const maxDimension = 256;
  const factor = Math.min(1, maxDimension / Math.max(width, height));
  const outWidth = Math.max(1, Math.round(width * factor));
  const outHeight = Math.max(1, Math.round(height * factor));
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(outWidth, outHeight);

  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor(y / factor));
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor(x / factor));
      const pixel = (y * outWidth + x) * 4;
      const source = (sourceY * width + sourceX) * channels;
      const read = (channel) => {
        const offset = channelFirst
          ? channel * height * width + sourceY * width + sourceX
          : source + channel;
        const value = Number(values[offset]);
        return Number.isFinite(value) ? Math.max(0, Math.min(255, value * scale)) : 127;
      };
      const red = read(0);
      const green = channels >= 3 ? read(1) : red;
      const blue = channels >= 3 ? read(2) : red;
      image.data[pixel] = red;
      image.data[pixel + 1] = green;
      image.data[pixel + 2] = blue;
      image.data[pixel + 3] = channels === 4 ? read(3) : 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

function _templateMax(values, length) {
  let max = 0;
  for (let i = 0; i < length; i++) {
    const value = Number(values[i]);
    if (Number.isFinite(value)) max = Math.max(max, Math.abs(value));
  }
  return max;
}

/**
 * dynamic_routing/animation.js — head-fixed mouse animation for the
 * dynamic-routing session player.
 *
 * Single lick spout, centered under the mouse. Above the mouse we show the
 * currently-playing stimulus:
 *
 *   - visual targets/nontargets → a gabor patch, rotated by orientation
 *     (vis1 vertical, vis2 horizontal)
 *   - auditory targets/nontargets → a speaker icon ringed by a coloured halo
 *     (sound1 saturated, sound2 desaturated)
 *   - catch → nothing
 *
 * Rewards drop a water-droplet under the spout. The currently-rewarded
 * modality (aud / vis) is shown as a small banner at the top of the canvas
 * so it's obvious which "rule" the mouse is operating under.
 */

import { findStimAt, findBlockAt } from './data-loader.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const CW = 320;
export const CH = 360;

const MOUSE_IMG_W = 240;
const MOUSE_IMG_H = MOUSE_IMG_W * (1068 / 1324);
const MOUSE_CX    = CW / 2;
const MOUSE_TOP   = 130;
const NOSE_X      = MOUSE_CX;
const NOSE_Y      = MOUSE_TOP + 18;

// One central spout.
export const SPOUT_W = 18;
export const SPOUT_H = 70;
const SPOUT_X        = NOSE_X - SPOUT_W / 2;
const SPOUT_REST_Y   = NOSE_Y - SPOUT_H + 28;
const SPOUT_COLOR    = '#4b5563';

// Tongue
const TONGUE_COLOR  = '#ff7faa';
const TONGUE_STROKE = '#c14d7a';

// Stimulus display
const STIM_AREA_CX = CW / 2;
const STIM_AREA_CY = 60;
const STIM_AREA_R  = 50;

// Decay envelopes (real seconds)
const RESPONSE_DECAY_S = 0.18;
const REWARD_DECAY_S = 0.5;
const STIM_DECAY_S   = 0.5;       // extra fade-out after stim_end_t

const VIS_COLOR   = '#7c3aed';    // purple — visual rule
const AUD_COLOR   = '#f59e0b';    // amber  — auditory rule
const TARGET_RING = '#16a34a';    // green
const NONTG_RING  = '#dc2626';    // red

// ---------------------------------------------------------------------------
// Sprite loader (reuses the existing dynamic-foraging mouse image)
// ---------------------------------------------------------------------------

export function loadMouseSprite(url = '/images/df/mouse_head_dorsal.png') {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => { console.warn('[DR] mouse sprite failed to load'); resolve(null); };
    img.src = url;
  });
}

export function loadGaborSprite(url = '/images/dr/gabor.png') {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => { console.warn('[DR] gabor sprite failed to load'); resolve(null); };
    img.src = url;
  });
}

export function loadWaterDroplet(url = '/images/water-droplet.png') {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => { console.warn('[DR] droplet sprite failed to load'); resolve(null); };
    img.src = url;
  });
}

export function loadSpeakerIcon(color = AUD_COLOR) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}">` +
    `<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 ` +
    `2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 ` +
    `7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// DrAnimation
// ---------------------------------------------------------------------------

export class DrAnimation {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} data    { trials, blocks, stims, responses, rewards, sessionEndS }
   * @param {object} sprites { mouse, gabor, droplet, speaker }
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

  _responseActivity() {
    const t = this.t;
    const lt = this.data.responses?.t;
    if (!lt || lt.length === 0) return 0;
    // Most-recent response event at or before t.
    let lo = 0, hi = lt.length - 1, i = -1;
    if (t >= lt[0]) {
      if (t >= lt[hi]) i = hi;
      else {
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (lt[mid] <= t) lo = mid; else hi = mid - 1;
        }
        i = lo;
      }
    }
    if (i < 0) return 0;
    const age = t - lt[i];
    if (age > RESPONSE_DECAY_S) return 0;
    return 1 - age / RESPONSE_DECAY_S;
  }

  _rewardActivity() {
    const t = this.t;
    const rt = this.data.rewards?.t;
    if (!rt || rt.length === 0) return 0;
    let lo = 0, hi = rt.length - 1, i = -1;
    if (t >= rt[0]) {
      if (t >= rt[hi]) i = hi;
      else {
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (rt[mid] <= t) lo = mid; else hi = mid - 1;
        }
        i = lo;
      }
    }
    if (i < 0) return 0;
    const decay = REWARD_DECAY_S * Math.sqrt(Math.max(1, this.speed));
    const age = t - rt[i];
    if (age > decay) return 0;
    return 1 - age / decay;
  }

  /** Returns {stim, activity} for the currently-playing stim (or null). */
  _currentStim() {
    const stim = findStimAt(this.data.stims, this.t);
    if (!stim) return null;
    const onset = stim.t;
    const offset = onset + (stim.duration || 0.5);
    const t = this.t;
    if (t < onset) return null;
    let activity = 1;
    if (t > offset) {
      const age = t - offset;
      if (age > STIM_DECAY_S) return null;
      activity = 1 - age / STIM_DECAY_S;
    }
    return { stim, activity };
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CW, CH);

    // ---- Rewarded-modality banner -----------------------------------
    const bi = findBlockAt(this.data.blocks, this.t);
    const block = bi >= 0 ? this.data.blocks[bi] : null;
    this._drawBanner(ctx, block);

    // ---- Stimulus display -------------------------------------------
    const cur = this._currentStim();
    if (cur) this._drawStim(ctx, cur.stim, cur.activity);

    // ---- Spout (behind mouse) ---------------------------------------
    this._drawSpout(ctx);

    // ---- Mouse head -------------------------------------------------
    if (this.sprites.mouse) {
      ctx.drawImage(
        this.sprites.mouse,
        MOUSE_CX - MOUSE_IMG_W / 2,
        MOUSE_TOP,
        MOUSE_IMG_W,
        MOUSE_IMG_H,
      );
    } else {
      ctx.fillStyle = '#bbb';
      ctx.beginPath();
      ctx.ellipse(MOUSE_CX, MOUSE_TOP + 90, 90, 110, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- Tongue (in front of head, behind droplet) ------------------
    const lick = this._responseActivity();
    if (lick > 0) this._drawTongue(ctx, lick);

    // ---- Reward droplet ---------------------------------------------
    const rew = this._rewardActivity();
    if (rew > 0) this._drawDroplet(ctx, rew);
  }

  // ---- Drawers ----------------------------------------------------------

  _drawBanner(ctx, block) {
    if (!block) return;
    const color = block.rewardedMod === 'aud' ? AUD_COLOR : VIS_COLOR;
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, CW, 26);
    ctx.restore();
    ctx.fillStyle = color;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const txt = block.rewardedMod === 'aud'
      ? `auditory block (rewarded: sound1)`
      : `visual block (rewarded: vis1)`;
    ctx.fillText(txt, CW / 2, 13);
  }

  _drawStim(ctx, stim, activity) {
    if (!stim || stim.kind === 'catch' || stim.kind === 'unknown') return;
    const alpha = Math.min(1, 0.5 + activity * 0.5);
    const isVis = stim.kind.startsWith('vis');
    const isTarget = stim.kind.endsWith('_target');
    const ringColor = isTarget ? TARGET_RING : NONTG_RING;

    ctx.save();
    ctx.translate(STIM_AREA_CX, STIM_AREA_CY);
    ctx.globalAlpha = alpha;

    // Halo behind the icon for emphasis
    ctx.globalAlpha = 0.18 * activity;
    ctx.fillStyle = ringColor;
    ctx.beginPath();
    ctx.arc(0, 0, STIM_AREA_R + 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = alpha;
    if (isVis && this.sprites.gabor) {
      // vis2 is a different orientation than vis1 (90deg rotation).
      const rot = stim.stim === 'vis2' ? Math.PI / 2 : 0;
      ctx.rotate(rot);
      const sz = STIM_AREA_R * 2;
      ctx.drawImage(this.sprites.gabor, -sz / 2, -sz / 2, sz, sz);
    } else if (!isVis && this.sprites.speaker) {
      // Auditory: speaker icon, with a colored ring whose hue distinguishes
      // sound1 (saturated amber) from sound2 (paler).
      const sz = STIM_AREA_R * 1.4;
      ctx.globalAlpha = stim.stim === 'sound2' ? alpha * 0.55 : alpha;
      ctx.drawImage(this.sprites.speaker, -sz / 2, -sz / 2, sz, sz);
    } else {
      // Fallback shape if a sprite is missing.
      ctx.fillStyle = isVis ? VIS_COLOR : AUD_COLOR;
      ctx.beginPath();
      ctx.arc(0, 0, STIM_AREA_R * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Outer target/nontarget ring
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.4 + activity);
    ctx.lineWidth   = 2.5;
    ctx.strokeStyle = ringColor;
    ctx.beginPath();
    ctx.arc(STIM_AREA_CX, STIM_AREA_CY, STIM_AREA_R + 4, 0, Math.PI * 2);
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
    const cx   = NOSE_X;
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
    // Vertical tongue darting straight up toward the spout.
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

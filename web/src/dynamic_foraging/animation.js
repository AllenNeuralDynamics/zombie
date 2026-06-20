/**
 * dynamic_foraging/animation.js — head-fixed mouse animation for the
 * dynamic-foraging session player.
 *
 * Layout (canvas-pixel coords, with origin at top-left):
 *
 *   ┌──────────────────────────────┐
 *   │      [L spout]   [R spout]   │   ← spouts above nose, lifted on lick
 *   │           \\\\   ///          │   ← tongue darts toward active spout
 *   │           [ mouse head       │
 *   │             dorsal png ]     │
 *   │                              │
 *   └──────────────────────────────┘
 *
 *  Real lick timing is taken straight from the database event table; we just
 *  decay an "activity" value over a short window so each lick produces a
 *  visible flick of the tongue + lift of the spout.
 */

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------
export const CW = 320;
export const CH = 360;

// Mouse head sprite — sits centred horizontally, nose near the top.
const MOUSE_IMG_W = 240;
const MOUSE_IMG_H = MOUSE_IMG_W * (1068 / 1324);   // preserve aspect ratio
const MOUSE_CX    = CW / 2;
const MOUSE_TOP   = 70;
const NOSE_X      = MOUSE_CX;
const NOSE_Y      = MOUSE_TOP + 18;                // nose tip on the image

// Lick spouts — small vertical rectangles just outside the mouth.
export const SPOUT_W = 18;
export const SPOUT_H = 70;
const SPOUT_OFFSET_X = 38;                         // gap from nose centre
const SPOUT_REST_Y   = NOSE_Y - SPOUT_H + 28;      // tip just touching the nose
const SPOUT_LIFT_PX  = 12;                         // how far the tongue "lifts" it
const SPOUT_COLOR_L  = '#2563eb';                  // blue
const SPOUT_COLOR_R  = '#dc2626';                  // red

// Tongue — short pink ellipse extending from mouth toward the active spout.
const TONGUE_COLOR   = '#ff7faa';
const TONGUE_STROKE  = '#c14d7a';
const TONGUE_REACH   = 26;                         // px outward from nose

// Activity decay (real seconds) — how long each lick is visible.
const LICK_DECAY_S   = 0.18;
// Cue / "beep" indicator — visible for this long after each goCue event.
const CUE_DECAY_S    = 0.45;
const CUE_COLOR      = '#f59e0b';                  // amber

// ---------------------------------------------------------------------------
// Sprite loader
// ---------------------------------------------------------------------------

export function loadMouseSprite(url = '/images/df/mouse_head_dorsal.png') {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => { console.warn('[DF] mouse sprite failed to load'); resolve(null); };
    img.src = url;
  });
}

export function loadWaterDroplet(url = '/images/water-droplet.png') {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => { console.warn('[DF] water-droplet sprite failed to load'); resolve(null); };
    img.src = url;
  });
}

/**
 * Tiny Material-Icons "volume_up" SVG, returned as a pre-loaded Image so the
 * animation can draw it on the canvas. Resolves to `null` if for any reason
 * the data-URL can't be loaded (the cue ring falls back to a circle).
 */
export function loadCueIcon(color = CUE_COLOR) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${color}">` +
    `<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 ` +
    `2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 ` +
    `7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>` +
    `</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// DfAnimation
// ---------------------------------------------------------------------------

export class DfAnimation {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} data - { trials, licks:{t,side}, rewards:{t,side}, goCues, sessionEndS }
   * @param {HTMLImageElement|null} mouseImg
   * @param {HTMLImageElement|null} [cueIcon] - speaker icon shown briefly after each goCue.
   */
  constructor(canvas, data, mouseImg, cueIcon = null, dropletImg = null) {
    this.canvas     = canvas;
    this.ctx        = canvas.getContext('2d');
    this.data       = data;
    this.mouseImg   = mouseImg;
    this.cueIcon    = cueIcon;
    this.dropletImg = dropletImg;
    this.duration = data.sessionEndS;

    canvas.width  = CW;
    canvas.height = CH;

    this.t       = 0;
    this.playing = false;
    this.speed   = 1;

    this.onFrame = null;        // (t) => void

    this._rafId      = null;
    this._lastReal   = null;
    // Pre-bind for cancelAnimationFrame friendliness.
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

  /**
   * Compute the per-side activity (0..1) at the current time `t`, decaying
   * each lick over `LICK_DECAY_S`. Returns { L, R, lastSide }.
   */
  _lickActivity() {
    const t = this.t;
    const { t: lt, side: ls } = this.data.licks;
    let actL = 0, actR = 0, lastSide = -1, lastT = -Infinity;
    // Walk the most recent licks (a tiny window is enough at any sane speed).
    // Binary search forward; iterate backwards while within the decay window.
    const n = lt.length;
    if (n === 0) return { L: 0, R: 0, lastSide };

    // Find largest i with lt[i] <= t
    let lo = 0, hi = n - 1, i = -1;
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
    for (let k = i; k >= 0; k--) {
      const age = t - lt[k];
      if (age > LICK_DECAY_S) break;
      const a = 1 - age / LICK_DECAY_S;
      if (ls[k] === 0) { if (a > actL) actL = a; }
      else             { if (a > actR) actR = a; }
      if (lt[k] > lastT) { lastT = lt[k]; lastSide = ls[k]; }
    }
    return { L: actL, R: actR, lastSide };
  }

  /**
   * Reward "glow" envelope — short bright pulse on each reward delivery.
   */
  _rewardGlow() {
    const t = this.t;
    // Scale decay so droplets linger ~1/√speed as long at high speeds.
    const decay = 0.5 * Math.sqrt(Math.max(1, this.speed));
    const { t: rt, side: rs } = this.data.rewards;
    const n = rt.length;
    if (n === 0) return { L: 0, R: 0 };
    let lo = 0, hi = n - 1, i = -1;
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
    let gL = 0, gR = 0;
    for (let k = i; k >= 0; k--) {
      const age = t - rt[k];
      if (age > decay) break;
      const a = 1 - age / decay;
      if (rs[k] === 0) { if (a > gL) gL = a; }
      else             { if (a > gR) gR = a; }
    }
    return { L: gL, R: gR };
  }

  /**
   * Compute the goCue ("beep") activity (0..1) at the current time.
   * The most recent cue contributes a 1-age/CUE_DECAY_S envelope; older
   * cues are ignored. Returns 0 when no cue has fired yet.
   */
  _cueActivity() {
    const t = this.t;
    const cues = this.data.goCues;
    const n = cues?.length ?? 0;
    if (n === 0 || t < cues[0]) return 0;
    let lo = 0, hi = n - 1;
    if (t >= cues[hi]) {
      // already past the last cue
    } else {
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cues[mid] <= t) lo = mid; else hi = mid - 1;
      }
    }
    const age = t - cues[lo];
    if (age < 0 || age > CUE_DECAY_S) return 0;
    return 1 - age / CUE_DECAY_S;
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CW, CH);

    const { L, R, lastSide } = this._lickActivity();
    const { L: gL, R: gR }   = this._rewardGlow();

    // ---- spouts (behind mouse head, no droplets yet) -------------------
    this._drawSpout(ctx, 'L');
    this._drawSpout(ctx, 'R');

    // ---- mouse head ----------------------------------------------------
    if (this.mouseImg) {
      ctx.drawImage(
        this.mouseImg,
        MOUSE_CX - MOUSE_IMG_W / 2,
        MOUSE_TOP,
        MOUSE_IMG_W,
        MOUSE_IMG_H,
      );
    } else {
      // Fallback: simple grey blob so the rest of the UI is still meaningful.
      ctx.fillStyle = '#bbb';
      ctx.beginPath();
      ctx.ellipse(MOUSE_CX, MOUSE_TOP + 90, 90, 110, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- tongue (in front of mouse, behind spouts) ---------------------
    if (lastSide === 0 && L > 0) this._drawTongue(ctx, -1, L);
    else if (lastSide === 1 && R > 0) this._drawTongue(ctx, +1, R);

    // ---- reward droplets (must be on top of mouse head) ----------------
    if (gL > 0) this._drawDroplet(ctx, 'L', gL);
    if (gR > 0) this._drawDroplet(ctx, 'R', gR);

    // ---- cue / "beep" indicator (speaker icon above the mouse) --------
    const cue = this._cueActivity();
    if (cue > 0) this._drawCue(ctx, cue);
  }

  /**
   * Draw the speaker icon at the top of the canvas, fading out with the cue
   * envelope. Adds a faint amber halo so it reads as "sound playing".
   */
  _drawCue(ctx, activity) {
    const cx = MOUSE_CX;
    const cy = 28;
    const size = 28 + activity * 4;
    const alpha = Math.min(1, 0.4 + activity);

    ctx.save();
    ctx.globalAlpha = 0.35 * activity;
    ctx.fillStyle = CUE_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy + size / 2, size * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (this.cueIcon) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(this.cueIcon, cx - size / 2, cy, size, size);
      ctx.restore();
    } else {
      // Fallback: amber dot if the icon failed to load.
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = CUE_COLOR;
      ctx.beginPath();
      ctx.arc(cx, cy + size / 2, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  _drawSpout(ctx, side) {
    const dir = side === 'L' ? -1 : +1;
    const color = side === 'L' ? SPOUT_COLOR_L : SPOUT_COLOR_R;
    const x = NOSE_X + dir * SPOUT_OFFSET_X - SPOUT_W / 2;
    const y = SPOUT_REST_Y;

    // Body
    ctx.fillStyle   = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth   = 1;
    _roundRect(ctx, x, y, SPOUT_W, SPOUT_H, 4);
    ctx.fill();
    ctx.stroke();

    // Glossy highlight
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    _roundRect(ctx, x + 3, y + 4, 4, SPOUT_H - 14, 2);
    ctx.fill();
  }

  _drawDroplet(ctx, side, rewardGlow) {
    const dir  = side === 'L' ? -1 : +1;
    const x    = NOSE_X + dir * SPOUT_OFFSET_X - SPOUT_W / 2;
    const y    = SPOUT_REST_Y;
    const cx   = x + SPOUT_W / 2;
    // Position the droplet so its pointed top overlaps the spout bottom —
    // like a real water drop forming at the tip.
    const imgSize = 20;
    const imgY = y + SPOUT_H - imgSize * 2;

    if (this.dropletImg) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, 0.45 + 0.55 * rewardGlow);
      ctx.drawImage(this.dropletImg, cx - imgSize / 2, imgY, imgSize, imgSize);
      ctx.restore();
    }
  }

  _drawTongue(ctx, dir, activity) {
    // Tongue is an ellipse rooted at the nose and stretched toward the spout.
    const reach = TONGUE_REACH * Math.max(0.4, activity);
    const tipX  = NOSE_X + dir * (SPOUT_OFFSET_X - 4);
    const tipY  = NOSE_Y - 12 - activity * 6;
    const rootX = NOSE_X;
    const rootY = NOSE_Y;
    const midX  = (rootX + tipX) / 2;
    const midY  = (rootY + tipY) / 2;
    const ang   = Math.atan2(tipY - rootY, tipX - rootX);
    const rx    = Math.max(8, reach * 0.7);
    const ry    = 5 + activity * 1.5;

    ctx.save();
    ctx.translate(midX, midY);
    ctx.rotate(ang);
    ctx.fillStyle   = TONGUE_COLOR;
    ctx.strokeStyle = TONGUE_STROKE;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Centre line on the tongue
    ctx.strokeStyle = 'rgba(140,60,100,0.5)';
    ctx.beginPath();
    ctx.moveTo(-rx * 0.7, 0);
    ctx.lineTo(rx * 0.7, 0);
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

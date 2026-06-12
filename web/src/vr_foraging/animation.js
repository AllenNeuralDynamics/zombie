/**
 * vr_foraging/animation.js — VRF pixel-art session animator (horizontal).
 *
 * Side-view of a mouse running left→right through the VR foraging corridor.
 * Camera follows the mouse: the mouse's current position_cm always maps to
 * MOUSE_X on the canvas. Past sites scroll off to the left, upcoming sites
 * appear on the right.
 *
 * Driven by:
 *   - sites    : per-site rows from the NWB trial table.
 *   - traces   : { pos_t, pos_cm, lick_t } from CurrentPosition + LickState.
 */

// ---------------------------------------------------------------------------
// Layout constants (logical canvas pixels)
// ---------------------------------------------------------------------------
export const CW = 480;
export const CH = 120;
const MOUSE_X      = 140;          // camera anchor (canvas-x of mouse centre)
const CORR_CY      = CH / 2 + 14;
const CORR_H       = 56;           // corridor strip height
const CORR_Y       = CORR_CY - CORR_H / 2;
const PX_PER_CM    = 1.4;
const SPR_SCALE    = 2;
const SPR_W        = 24 * SPR_SCALE;
const SPR_H        = 16 * SPR_SCALE;

// Mouse vertical anchor — feet on the floor of the corridor
const MOUSE_Y      = CORR_Y + CORR_H - 14;

// ---------------------------------------------------------------------------
// Colour palette (light theme — matches the rest of the site)
// ---------------------------------------------------------------------------
const C = {
  bg:                 '#ffffff',
  void:               '#f3f3f3',
  patch:              '#fafafa',
  corridorEdge:       '#dcdcdc',
  rewardSite:         '#f39c12',
  rewardSiteRing:     '#222222',
  rewardBlue:         '#2980b9',
  rewardRed:          '#c0392b',
};

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/** Binary search: last site whose start_time_s ≤ t. */
export function findSiteAt(sites, t) {
  let lo = 0, hi = sites.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sites[mid].start_time_s <= t) lo = mid;
    else hi = mid - 1;
  }
  return sites[lo];
}

function lastLE(arr, t) {
  let lo = 0, hi = arr.length - 1;
  if (hi < 0) return -1;
  if (t <= arr[0]) return 0;
  if (t >= arr[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function firstGE(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function firstSiteReaching(sites, cm) {
  let lo = 0, hi = sites.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const s = sites[mid];
    if (s.start_position_cm + s.length_cm < cm) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Sprite loader
// ---------------------------------------------------------------------------

const SPRITE_NAMES = [
  'mouse_run_a', 'mouse_run_b', 'mouse_idle', 'mouse_lick',
  'reward_drop',
];

export function loadSprites(baseUrl) {
  const imgs = {};
  return Promise.all(SPRITE_NAMES.map(
    (name) => new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => { imgs[name] = img; resolve(); };
      img.onerror = () => { console.warn(`[VRF] sprite not found: ${name}`); resolve(); };
      img.src = `${baseUrl}/${name}.svg`;
    }),
  )).then(() => imgs);
}

// ---------------------------------------------------------------------------
// VrfAnimation
// ---------------------------------------------------------------------------

export class VrfAnimation {
  constructor(canvas, sites, sprites, traces) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.sites    = sites;
    this.sprites  = sprites;
    this.traces   = traces ?? { pos_t: [], pos_cm: [], lick_t: [] };
    this.duration = sites[sites.length - 1].stop_time_s;

    this.t       = 0;
    this.playing = false;
    this.speed   = 10;

    this.onFrame = null;

    this._rafId        = null;
    this._lastReal     = null;
    this._runFrame     = 0;
    this._runTimer     = 0;
    this._particles    = [];
    this._cumRewards   = this._buildCumRewards();
    this._lickHorizon  = 0;
    this._lickCm       = this.traces.lick_t.map(t => this.posAt(t));
    // Precompute the world-space position where each reward was delivered.
    // Using the actual encoder position at reward_onset_time gives a tighter
    // correspondence with the lick cluster than using the site midpoint.
    this._rewardDots   = this.sites
      .filter(s => s.site_label === 'RewardSite' && s.has_reward && s.reward_onset_time_s != null)
      .map(s => ({ t: s.reward_onset_time_s, cm: this.posAt(s.reward_onset_time_s) }));
  }

  // ---- Public API ---------------------------------------------------------

  play() {
    if (this.playing) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing   = true;
    this._lastReal = performance.now();
    this._rafId    = requestAnimationFrame((ts) => this._loop(ts));
  }

  pause() {
    this.playing = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  seekTo(t) {
    this.t            = Math.max(0, Math.min(this.duration, t));
    this._particles   = [];
    this._lickHorizon = firstGE(this.traces.lick_t, this.t);
    this._render();
  }

  draw()      { this._render(); }
  setSpeed(s) { this.speed = s; }

  cumRewardsAt(siteIndex) { return this._cumRewards[Math.min(siteIndex, this._cumRewards.length - 1)]; }
  get totalRewards()      { return this._cumRewards[this.sites.length - 1]; }

  posAt(t) {
    const { pos_t, pos_cm } = this.traces;
    if (pos_t.length === 0) return this._posFromSites(t);
    if (t <= pos_t[0]) return pos_cm[0];
    if (t >= pos_t[pos_t.length - 1]) return pos_cm[pos_cm.length - 1];
    const i = lastLE(pos_t, t);
    if (i === pos_t.length - 1) return pos_cm[i];
    const frac = (t - pos_t[i]) / (pos_t[i + 1] - pos_t[i]);
    return pos_cm[i] + frac * (pos_cm[i + 1] - pos_cm[i]);
  }

  // ---- Internal -----------------------------------------------------------

  _posFromSites(t) {
    if (t <= 0) return 0;
    const last = this.sites[this.sites.length - 1];
    if (t >= last.stop_time_s) return last.start_position_cm + last.length_cm;
    const s   = findSiteAt(this.sites, t);
    const dur = s.stop_time_s - s.start_time_s;
    const frac = dur > 0 ? (t - s.start_time_s) / dur : 1;
    return s.start_position_cm + frac * s.length_cm;
  }

  _buildCumRewards() {
    const arr = new Int32Array(this.sites.length);
    let n = 0;
    for (let i = 0; i < this.sites.length; i++) {
      if (this.sites[i].has_reward) n++;
      arr[i] = n;
    }
    return arr;
  }

  _loop(realNow) {
    if (!this.playing) return;
    const dt = (realNow - this._lastReal) / 1000;
    this._lastReal = realNow;

    const prevT = this.t;
    this.t = Math.min(this.duration, this.t + dt * this.speed);

    this._runTimer += dt * Math.min(this.speed, 12);
    if (this._runTimer > 0.16) { this._runFrame ^= 1; this._runTimer = 0; }

    this._checkEvents(prevT, this.t);

    for (const p of this._particles) {
      p.alpha = Math.max(0, 1 - (this.t - p.born) / p.lifetime);
    }
    this._particles = this._particles.filter((p) => p.alpha > 0);

    this._render();

    if (this.t >= this.duration) { this.pause(); return; }
    this._rafId = requestAnimationFrame((ts) => this._loop(ts));
  }

  _checkEvents(prevT, nowT) {
    // Advance lick horizon (no particle — licks are drawn as world-space ticks).
    const { lick_t } = this.traces;
    while (this._lickHorizon < lick_t.length && lick_t[this._lickHorizon] <= nowT) {
      this._lickHorizon++;
    }
    // Reward drop particle on reward_onset_time crossing.
    const s = findSiteAt(this.sites, nowT);
    if (s.has_reward && s.reward_onset_time_s != null &&
        prevT < s.reward_onset_time_s && nowT >= s.reward_onset_time_s) {
      this._spawnParticle('reward_drop', 16, -14, this._scaledLifetime(1.5));
    }
  }

  _spawnParticle(type, dx, dy, lifetime) {
    this._particles.push({ type, dx, dy, alpha: 1, born: this.t, lifetime });
  }

  _scaledLifetime(baseRealSec) {
    return baseRealSec * Math.sqrt(Math.max(1, this.speed));
  }

  _mouseState(t) {
    const { lick_t } = this.traces;
    if (lick_t.length > 0) {
      const i = lastLE(lick_t, t);
      if (i >= 0 && t - lick_t[i] < 0.25 && t - lick_t[i] >= -1e-6) return 'licking';
    }
    if (this.traces.pos_t.length > 1) {
      const v = this._velocityAt(t);
      if (Math.abs(v) < 2) return 'idle';
    }
    return 'running';
  }

  _velocityAt(t) {
    const { pos_t, pos_cm } = this.traces;
    const i = lastLE(pos_t, t);
    const j = Math.min(pos_t.length - 1, i + 3);
    if (j <= i) return 0;
    return (pos_cm[j] - pos_cm[i]) / (pos_t[j] - pos_t[i]);
  }

  // ---- Render -------------------------------------------------------------

  _render() {
    const ctx        = this.ctx;
    const mousePosCm = this.posAt(this.t);
    const curSite    = findSiteAt(this.sites, this.t);
    const state      = this._mouseState(this.t);

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, CW, CH);

    this._drawCorridor(ctx, mousePosCm);
    this._drawSites(ctx, mousePosCm);
    this._drawLickTicks(ctx, mousePosCm);
    this._drawRewardDots(ctx, mousePosCm);
    this._drawMouse(ctx, state);
    this._drawParticles(ctx);

    if (this.onFrame) this.onFrame(this.t, curSite);
  }

  /** Visible corridor span in cm (west = behind mouse, east = ahead). */
  _visibleRangeCm(mousePosCm) {
    return {
      west: mousePosCm - MOUSE_X / PX_PER_CM,
      east: mousePosCm + (CW - MOUSE_X) / PX_PER_CM,
    };
  }

  /** Map a corridor cm coordinate to canvas-x. */
  _cmToX(cm, mousePosCm) {
    return MOUSE_X + (cm - mousePosCm) * PX_PER_CM;
  }

  _drawCorridor(ctx, mousePosCm) {
    const { west, east } = this._visibleRangeCm(mousePosCm);
    const startIdx = Math.max(0, firstSiteReaching(this.sites, west) - 1);

    for (let i = startIdx; i < this.sites.length; i++) {
      const s = this.sites[i];
      if (s.start_position_cm > east + 60) break;
      const sEast = s.start_position_cm + s.length_cm;
      if (sEast < west - 60) continue;

      const xLeft  = Math.floor(this._cmToX(s.start_position_cm, mousePosCm));
      const xRight = Math.ceil(this._cmToX(sEast, mousePosCm));
      const segW   = Math.max(1, xRight - xLeft);

      ctx.fillStyle = s.site_label === 'InterPatch' ? C.void : C.patch;
      ctx.fillRect(xLeft, CORR_Y, segW, CORR_H);
    }

    // Corridor rails (top + bottom)
    ctx.fillStyle = C.corridorEdge;
    ctx.fillRect(0, CORR_Y - 1, CW, 1);
    ctx.fillRect(0, CORR_Y + CORR_H, CW, 1);
  }

  _drawSites(ctx, mousePosCm) {
    const { west, east } = this._visibleRangeCm(mousePosCm);
    const startIdx = Math.max(0, firstSiteReaching(this.sites, west) - 1);
    const nowT = this.t;

    for (let i = startIdx; i < this.sites.length; i++) {
      const s = this.sites[i];
      if (s.start_position_cm > east + 60) break;
      if (s.site_label !== 'RewardSite') continue;

      const sEast  = s.start_position_cm + s.length_cm;
      const xLeft  = Math.floor(this._cmToX(s.start_position_cm, mousePosCm));
      const xRight = Math.ceil(this._cmToX(sEast, mousePosCm));
      const segW   = Math.max(1, xRight - xLeft);

      const visited = s.has_choice && s.start_time_s < nowT;
      let fill, alpha;
      if (visited) {
        fill  = s.has_reward ? C.rewardBlue : C.rewardRed;
        alpha = 0.85;
      } else {
        fill  = C.rewardSite;
        const rp = s.reward_probability ?? 0.5;
        alpha = 0.35 + rp * 0.6;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      ctx.fillRect(xLeft, CORR_Y + 4, segW, CORR_H - 8);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = C.rewardSiteRing;
      ctx.lineWidth = 1;
      ctx.strokeRect(xLeft + 0.5, CORR_Y + 4 + 0.5, segW - 1, CORR_H - 9);
    }
  }

  /**
   * Small black vertical ticks above the corridor, one per lick event,
   * drawn at the world-space cm position where the lick occurred.
   * Only past licks (up to current time) are drawn.
   */
  _drawLickTicks(ctx, mousePosCm) {
    const { west, east } = this._visibleRangeCm(mousePosCm);
    // Lick ticks: just above the corridor top rail (second row)
    const yTop = CORR_Y - 8;
    const tickH = 6;
    ctx.fillStyle = '#111111';
    for (let i = 0; i < this._lickCm.length; i++) {
      if (this.traces.lick_t[i] > this.t) break;
      const cm = this._lickCm[i];
      if (cm < west) continue;
      if (cm > east) break;
      const x = Math.round(this._cmToX(cm, mousePosCm));
      ctx.fillRect(x, yTop, 1, tickH);
    }
  }

  /**
   * Blue dots below the corridor, one per rewarded trial,
   * drawn at the site's world-space cm midpoint.
   * Only past rewards (already delivered) are shown.
   */
  _drawRewardDots(ctx, mousePosCm) {
    const { west, east } = this._visibleRangeCm(mousePosCm);
    // Reward dots: above the lick tick row (top row)
    const dotY = CORR_Y - 18;
    ctx.fillStyle = '#2980b9';
    for (const dot of this._rewardDots) {
      if (dot.t > this.t) break;       // not yet delivered
      if (dot.cm < west) continue;
      if (dot.cm > east) break;
      const x = Math.round(this._cmToX(dot.cm, mousePosCm));
      ctx.beginPath();
      ctx.arc(x, dotY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawMouse(ctx, state) {
    const name = state === 'licking' ? 'mouse_lick'
      : state === 'idle' ? 'mouse_idle'
      : this._runFrame === 0 ? 'mouse_run_a' : 'mouse_run_b';

    const img = this.sprites[name];
    const mx  = MOUSE_X - SPR_W / 2;
    const my  = MOUSE_Y - SPR_H / 2;

    if (img) {
      ctx.drawImage(img, mx, my, SPR_W, SPR_H);
    } else {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(MOUSE_X - 12, MOUSE_Y - 6, 24, 12);
    }
  }

  _drawParticles(ctx) {
    for (const p of this._particles) {
      const age   = this.t - p.born;
      const rise  = (age / p.lifetime) * 18;
      const px    = MOUSE_X + p.dx;
      const py    = MOUSE_Y + p.dy - rise;
      const img   = this.sprites[p.type];
      if (!img) continue;
      const [sw, sh] = p.type === 'reward_drop'
        ? [8 * SPR_SCALE, 10 * SPR_SCALE]
        : [12 * SPR_SCALE, 12 * SPR_SCALE];
      ctx.globalAlpha = p.alpha;
      ctx.drawImage(img, px - sw / 2, py - sh / 2, sw, sh);
    }
    ctx.globalAlpha = 1;
  }
}

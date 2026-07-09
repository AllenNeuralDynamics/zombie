/**
 * vr_foraging/animation.js — top-down session animator.
 *
 * Renders a horizontal corridor with the mouse vertically centred. A single
 * top-down PNG is rotated 90° CW so the mouse faces the running direction.
 */

import { patchColor } from './theme.js';

export const CW = 480;
export const CH = 120;
const MOUSE_X      = 140;
const CORR_CY      = CH / 2;
const CORR_H       = 56;
const CORR_Y       = CORR_CY - CORR_H / 2;
const PX_PER_CM    = 1.4;
const MOUSE_LEN_PX = 84;

const MOUSE_Y = CORR_CY;

const C = {
  bg:                 '#ffffff',
  void:               '#f3f3f3',
  patch:              '#fafafa',
  corridorEdge:       '#dcdcdc',
  rewardSiteRing:     '#222222',
  rewardBlue:         '#2980b9',
  rewardRed:          '#c0392b',
  siteFillUnknown:    '#ffffff',
};

const ORANGE = '#e67e22';
const GREEN  = '#27ae60';
const PURPLE = '#8e44ad';
const BLUE   = '#2980b9';
const RED    = '#c0392b';

const ODOR_PALETTES = {
  1: [ORANGE],
  2: [ORANGE, PURPLE],
  3: [ORANGE, GREEN, PURPLE],
  4: [ORANGE, GREEN, BLUE, PURPLE],
  5: [ORANGE, GREEN, BLUE, RED, PURPLE],
};
const ODOR_FALLBACK = [ORANGE, GREEN, BLUE, RED, PURPLE, '#16a085', '#d35400'];

function parseOdorProb(label) {
  if (label == null) return null;
  const m = String(label).match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

/**
 * Map<patch_label, color>. Highest odor probability gets orange, lowest gets
 * purple; middle ranks fill in with green, blue, red.
 */
export function buildOdorPalette(sites) {
  const labels = new Set();
  for (const s of sites) {
    if (s.site_label === 'InterPatch') continue;
    if (s.patch_label != null) labels.add(s.patch_label);
  }
  const sorted = [...labels].sort((a, b) => {
    const pa = parseOdorProb(a);
    const pb = parseOdorProb(b);
    if (pa == null && pb == null) return String(a).localeCompare(String(b));
    if (pa == null) return 1;
    if (pb == null) return -1;
    return pb - pa;
  });
  const colors = ODOR_PALETTES[sorted.length] ?? ODOR_FALLBACK;
  const map = new Map();
  sorted.forEach((label, i) => {
    map.set(label, colors[i] ?? ODOR_FALLBACK[i % ODOR_FALLBACK.length]);
  });
  return map;
}

function findOutTime(s) {
  if (s.has_reward && Number.isFinite(s.reward_onset_time_s)) {
    return s.reward_onset_time_s;
  }
  if (Number.isFinite(s.choice_cue_time_s) && Number.isFinite(s.reward_delay_duration_s)) {
    return s.choice_cue_time_s + s.reward_delay_duration_s;
  }
  if (Number.isFinite(s.choice_cue_time_s)) return s.choice_cue_time_s;
  return null;
}

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

const SPRITE_URLS = {
  mouse_top: 'mouse_top.png',
};

export function loadSprites(baseUrl) {
  const imgs = {};
  return Promise.all(Object.entries(SPRITE_URLS).map(
    ([name, file]) => new Promise((resolve) => {
      const img = new Image();
      img.onload  = () => { imgs[name] = img; resolve(); };
      img.onerror = () => { console.warn(`[VRF] sprite not found: ${file}`); resolve(); };
      img.src = `${baseUrl}/${file}`;
    }),
  )).then(() => imgs);
}

export class VrfAnimation {
  constructor(canvas, sites, sprites, traces, opts = {}) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.sites    = sites;
    this.sprites  = sprites;
    this.traces   = traces ?? { pos_t: [], pos_cm: [], lick_t: [] };
    this.duration = sites[sites.length - 1].stop_time_s;
    this.odorPalette = opts.odorPalette ?? buildOdorPalette(sites);

    this._setupHiDpi();

    this._findOut = sites.map(findOutTime);
    this._bgTriangles = this._buildBgTriangles();

    this.t       = 0;
    this.playing = false;
    this.speed   = 10;

    this.onFrame = null;

    this._rafId        = null;
    this._lastReal     = null;
    this._cumRewards   = this._buildCumRewards();
    this._lickHorizon  = 0;
    this._lickCm       = this.traces.lick_t.map(t => this.posAt(t));
    this._rewardDots   = this.sites
      .filter(s => s.site_label === 'RewardSite' && s.has_reward && s.reward_onset_time_s != null)
      .map(s => ({ t: s.reward_onset_time_s, cm: this.posAt(s.reward_onset_time_s) }));
  }

  _setupHiDpi() {
    const dpr  = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    // Use the container's actual CSS width as the logical draw width so the
    // corridor fills the available space by showing more of the track, not by
    // scaling up the existing pixels. Height stays fixed at CH.
    this._logicalW = Math.max(CW, this.canvas.clientWidth || CW);
    this.canvas.width  = Math.round(this._logicalW * dpr);
    this.canvas.height = Math.round(CH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

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
    this._lickHorizon = firstGE(this.traces.lick_t, this.t);
    this._render();
  }

  draw()      { this._render(); }
  setSpeed(s) { this.speed = s; }

  /**
   * Re-measure the canvas and redraw. Call this after the canvas has been laid
   * out (it starts with clientWidth 0 while hidden) and whenever its width
   * changes, so the corridor fills the available width by showing more track
   * instead of horizontally stretching a fixed-width backing store.
   */
  resize() { this._setupHiDpi(); this._render(); }

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

  _posFromSites(t) {
    if (t <= 0) return 0;
    const last = this.sites[this.sites.length - 1];
    if (t >= last.stop_time_s) return last.start_position_cm + last.length_cm;
    const s   = findSiteAt(this.sites, t);
    const dur = s.stop_time_s - s.start_time_s;
    const frac = dur > 0 ? (t - s.start_time_s) / dur : 1;
    return s.start_position_cm + frac * s.length_cm;
  }

  _buildBgTriangles() {
    const tris = [];
    let seed = 42;
    const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xffffffff; };
    for (const s of this.sites) {
      if (s.site_label === 'InterPatch') continue;
      const n = Math.max(2, Math.round(s.length_cm * 0.3));
      for (let i = 0; i < n; i++) {
        tris.push({
          cm:     s.start_position_cm + rand() * s.length_cm,
          y_frac: 0.15 + rand() * 0.7,
          angle:  rand() * Math.PI,
        });
      }
    }
    return tris;
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

    this.t = Math.min(this.duration, this.t + dt * this.speed);

    const { lick_t } = this.traces;
    while (this._lickHorizon < lick_t.length && lick_t[this._lickHorizon] <= this.t) {
      this._lickHorizon++;
    }

    this._render();

    if (this.t >= this.duration) { this.pause(); return; }
    this._rafId = requestAnimationFrame((ts) => this._loop(ts));
  }

  _mouseState(t) {
    const { lick_t } = this.traces;
    if (lick_t.length > 0) {
      const i = lastLE(lick_t, t);
      if (i >= 0 && t - lick_t[i] < 0.25 && t - lick_t[i] >= -1e-6) return 'licking';
    }
    return 'running';
  }

  _render() {
    const ctx        = this.ctx;
    const mousePosCm = this.posAt(this.t);
    const curSite    = findSiteAt(this.sites, this.t);
    const state      = this._mouseState(this.t);

    const W = this._logicalW;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, CH);

    this._drawCorridor(ctx, mousePosCm);
    this._drawSites(ctx, mousePosCm);
    this._drawLickTicks(ctx, mousePosCm);
    this._drawRewardDots(ctx, mousePosCm);
    this._drawMouse(ctx, state);

    if (this.onFrame) this.onFrame(this.t, curSite);
  }

  _visibleRangeCm(mousePosCm) {
    return {
      west: mousePosCm - MOUSE_X / PX_PER_CM,
      east: mousePosCm + (this._logicalW - MOUSE_X) / PX_PER_CM,
    };
  }

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

      if (s.site_label === 'InterPatch') {
        ctx.fillStyle = C.void;
      } else {
        ctx.fillStyle = '#efefef';
      }
      ctx.fillRect(xLeft, CORR_Y, segW, CORR_H);
    }

    ctx.fillStyle = '#cccccc';
    for (const tri of this._bgTriangles) {
      if (tri.cm < west - 6 || tri.cm > east + 6) continue;
      const tx = this._cmToX(tri.cm, mousePosCm);
      const ty = CORR_Y + CORR_H * tri.y_frac;
      const r = 4;
      ctx.save();
      ctx.translate(tx, ty);
      ctx.rotate(tri.angle);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.866, r * 0.5);
      ctx.lineTo(-r * 0.866, r * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = C.corridorEdge;
    ctx.fillRect(0, CORR_Y - 1, this._logicalW, 1);
    ctx.fillRect(0, CORR_Y + CORR_H, this._logicalW, 1);
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

      const odorColor   = patchColor(s.patch_index);
      const outcomeColor = s.has_reward ? C.rewardBlue : C.rewardRed;
      const foT  = this._findOut[i];
      const known = foT != null && nowT >= foT;

      ctx.fillStyle   = odorColor;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(xLeft, CORR_Y + 4, segW, CORR_H - 8);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = known ? outcomeColor : odorColor;
      ctx.lineWidth   = 2;
      ctx.strokeRect(xLeft + 1, CORR_Y + 4 + 1, segW - 2, CORR_H - 8 - 2);
      ctx.lineWidth   = 1;
    }
  }

  _drawLickTicks(ctx, mousePosCm) {
    const { west, east } = this._visibleRangeCm(mousePosCm);
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

  _drawRewardDots(ctx, mousePosCm) {
    const { west, east } = this._visibleRangeCm(mousePosCm);
    const dotY = CORR_Y + CORR_H + 10;
    ctx.fillStyle = '#2980b9';
    for (const dot of this._rewardDots) {
      if (dot.t > this.t) break;
      if (dot.cm < west) continue;
      if (dot.cm > east) break;
      const x = Math.round(this._cmToX(dot.cm, mousePosCm));
      ctx.beginPath();
      ctx.arc(x, dotY, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawMouse(ctx, state) {
    const img = this.sprites?.mouse_top;
    if (!img) {
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(MOUSE_X - 18, MOUSE_Y - 8, 36, 16);
      return;
    }

    const srcW = img.naturalWidth  || img.width  || 287;
    const srcH = img.naturalHeight || img.height || 945;
    const scale = MOUSE_LEN_PX / srcH;
    const drawW = srcW * scale;
    const drawH = srcH * scale;
    const headX = MOUSE_X;

    ctx.save();
    ctx.translate(headX, MOUSE_Y);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(img, -drawW / 2, 0, drawW, drawH);
    ctx.restore();

    if (state === 'licking') {
      const tongueLen = 3;
      const tongueW   = 2;
      const cx = headX + tongueLen * 0.45;
      const cy = MOUSE_Y;
      ctx.save();
      ctx.fillStyle = '#ee8aa3';
      ctx.strokeStyle = '#b35a73';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(cx, cy, tongueLen, tongueW / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

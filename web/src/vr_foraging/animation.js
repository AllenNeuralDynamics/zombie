/**
 * vr_foraging/animation.js — VRF pixel-art session animator.
 *
 * Renders a top-down pixel-art view of a mouse running through the VR
 * foraging corridor. Driven by a sites array derived from the NWB trial table.
 *
 * Canvas coordinate system
 * ─────────────────────────
 *   Logical size: CW × CH pixels (rendered large via CSS + image-rendering:pixelated).
 *   North = up = smaller canvas-y. The mouse runs toward y = 0.
 *   Camera follows mouse: mousePosCm always maps to MOUSE_Y on canvas.
 *   Larger position_cm → further north → smaller canvas-y.
 */

// ---------------------------------------------------------------------------
// Layout constants (logical canvas pixels)
// ---------------------------------------------------------------------------
export const CW        = 140;   // canvas width
export const CH        = 240;   // canvas height
const MOUSE_CX         = CW / 2; // mouse centre x (70)
const MOUSE_Y          = 168;   // camera anchor: this canvas-y == mousePosCm
const CORR_CX          = CW / 2;
const CORR_W           = 64;    // corridor strip width
const CORR_X           = CORR_CX - CORR_W / 2;
const PX_PER_CM        = 0.7;   // 50 cm reward site ≈ 35 px
const SPR_S            = 2;     // draw 16-px sprites at 2× = 32 px
const SS               = 16 * SPR_S; // sprite draw size in canvas px

// ---------------------------------------------------------------------------
// Colour palette
// ---------------------------------------------------------------------------
const C = {
  void:       '#11111c',
  corridor:   '#1a1a2c',
  ipatch:     '#15152a',
  isite:      '#1c3320',
  rsite:      '#162e16',
  odor60:     '#ffb33a',
  odor90:     '#3aaaff',
  odor0:      '#777788',
  reward:     '#5fb4ff',
  miss:       '#444455',
};

function odorColor(patchLabel) {
  if (patchLabel === 'odor_60') return C.odor60;
  if (patchLabel === 'odor_90') return C.odor90;
  return C.odor0;
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

/** Convert a corridor position (cm) to canvas-y, mouse anchored at MOUSE_Y. */
function cmToY(cm, mousePosCm) {
  return MOUSE_Y - (cm - mousePosCm) * PX_PER_CM;
}

// ---------------------------------------------------------------------------
// Site lookup helpers
// ---------------------------------------------------------------------------

/**
 * Binary search: last site whose start_time_s ≤ t.
 * Returns sites[0] when t < 0.
 */
export function findSiteAt(sites, t) {
  let lo = 0, hi = sites.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sites[mid].start_time_s <= t) lo = mid;
    else hi = mid - 1;
  }
  return sites[lo];
}

/**
 * Binary search: index of first site whose north end (p0+len) >= cm.
 * Used to start the visible-sites scan from a known lower bound.
 */
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
// Time → position / state
// ---------------------------------------------------------------------------

/**
 * Compute mouse corridor position (cm) at session time t.
 * Linearly interpolates through each site; holds at mid-site during lick window.
 *
 * @param {object[]} sites
 * @param {number}   t      Session-relative seconds.
 * @returns {number}        Position in cm.
 */
export function mousePosAt(sites, t) {
  if (t <= 0) return 0;
  const last = sites[sites.length - 1];
  if (t >= last.stop_time_s) return last.start_position_cm + last.length_cm;

  const s   = findSiteAt(sites, t);
  const dur = s.stop_time_s - s.start_time_s;

  // Hold at site centre during the choice/lick window
  if (s.has_choice && s.choice_cue_time_s != null && t >= s.choice_cue_time_s) {
    const holdEnd = s.choice_cue_time_s + (s.reward_delay_duration_s ?? 1.5) + 0.5;
    if (t <= holdEnd) return s.start_position_cm + s.length_cm * 0.5;
  }

  const frac = dur > 0 ? Math.max(0, Math.min(1, (t - s.start_time_s) / dur)) : 1;
  return s.start_position_cm + frac * s.length_cm;
}

/**
 * Determine mouse animation state at time t.
 * @returns {'running'|'stopping'|'licking'}
 */
function mouseStateAt(sites, t) {
  const s = findSiteAt(sites, t);
  if (s.site_label !== 'RewardSite' || !s.has_choice) return 'running';
  if (s.choice_cue_time_s == null || t < s.choice_cue_time_s - 0.4) return 'running';
  if (t < s.choice_cue_time_s) return 'stopping';
  const holdEnd = s.choice_cue_time_s + (s.reward_delay_duration_s ?? 1.5) + 0.5;
  return t <= holdEnd ? 'licking' : 'running';
}

// ---------------------------------------------------------------------------
// Sprite loader
// ---------------------------------------------------------------------------

const SPRITE_NAMES = [
  'mouse_run_a', 'mouse_run_b', 'mouse_idle', 'mouse_lick',
  'reward_drop', 'lick_burst',
  'odor_swirl_0', 'odor_swirl_60', 'odor_swirl_90',
];

/**
 * Load all sprite SVGs into HTMLImageElements.
 *
 * @param {string} baseUrl  URL prefix, e.g. '/images/vrf'.
 * @returns {Promise<Record<string, HTMLImageElement>>}
 */
export function loadSprites(baseUrl) {
  const imgs = {};
  return Promise.all(
    SPRITE_NAMES.map(
      (name) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload  = () => { imgs[name] = img; resolve(); };
          img.onerror = () => { console.warn(`[VRF] sprite not found: ${name}`); resolve(); };
          img.src = `${baseUrl}/${name}.svg`;
        }),
    ),
  ).then(() => imgs);
}

// ---------------------------------------------------------------------------
// VrfAnimation class
// ---------------------------------------------------------------------------

/**
 * Pixel-art VRF session animator.
 *
 * @example
 *   const anim = new VrfAnimation(canvas, sites, sprites);
 *   anim.onFrame = (t, site) => { updateHud(t, site); };
 *   anim.play();
 */
export class VrfAnimation {
  /**
   * @param {HTMLCanvasElement}                   canvas
   * @param {object[]}                            sites   Parsed vrf_841314.json.
   * @param {Record<string, HTMLImageElement>}    sprites Loaded via loadSprites().
   */
  constructor(canvas, sites, sprites) {
    this.canvas   = canvas;
    this.ctx      = canvas.getContext('2d');
    this.sites    = sites;
    this.sprites  = sprites;
    this.duration = sites[sites.length - 1].stop_time_s;

    /** Current session time (seconds, 0 = session start). */
    this.t       = 0;
    this.playing = false;
    this.speed   = 10;

    /**
     * Called every rendered frame: onFrame(t, currentSite).
     * @type {((t: number, site: object) => void)|null}
     */
    this.onFrame = null;

    // Internal state
    this._rafId    = null;
    this._lastReal = null;
    this._runFrame = 0;
    this._runTimer = 0;
    this._particles = [];  // { type, dx, dy, born, lifetime, alpha }

    // Precompute cumulative reward counts indexed by site_index
    this._cumRew = this._buildCumRewards();
  }

  // ---- Private setup -------------------------------------------------------

  _buildCumRewards() {
    const arr = new Int32Array(this.sites.length);
    let n = 0;
    for (let i = 0; i < this.sites.length; i++) {
      if (this.sites[i].has_reward) n++;
      arr[i] = n;
    }
    return arr;
  }

  // ---- Public API ----------------------------------------------------------

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

  /** Jump to session time t and redraw immediately. */
  seekTo(t) {
    this.t          = Math.max(0, Math.min(this.duration, t));
    this._particles = [];
    this._render();
  }

  /** Draw one static frame (for initial render or after seekTo). */
  draw() { this._render(); }

  setSpeed(s) { this.speed = s; }

  // ---- Accessors -----------------------------------------------------------

  /** Cumulative rewards delivered up to and including site_index i. */
  cumRewardsAt(siteIndex) {
    return this._cumRew[Math.min(siteIndex, this._cumRew.length - 1)];
  }

  get totalRewards() { return this._cumRew[this.sites.length - 1]; }

  // ---- Animation loop ------------------------------------------------------

  _loop(realNow) {
    if (!this.playing) return;
    const dt = (realNow - this._lastReal) / 1000;
    this._lastReal = realNow;

    const prevT = this.t;
    this.t = Math.min(this.duration, this.t + dt * this.speed);

    // Run-cycle cadence (independent of speed so it doesn't look frantic at 60×)
    this._runTimer += dt * Math.min(this.speed, 15);
    if (this._runTimer > 0.18) { this._runFrame ^= 1; this._runTimer = 0; }

    // Spawn event particles
    this._checkEvents(prevT, this.t);

    // Age / cull particles
    for (const p of this._particles) {
      p.alpha = Math.max(0, 1 - (this.t - p.born) / p.lifetime);
    }
    this._particles = this._particles.filter((p) => p.alpha > 0);

    this._render();

    if (this.t >= this.duration) { this.pause(); return; }
    this._rafId = requestAnimationFrame((ts) => this._loop(ts));
  }

  _checkEvents(prevT, nowT) {
    const s = findSiteAt(this.sites, nowT);

    // Lick burst at choice moment
    if (s.has_choice && s.choice_cue_time_s != null &&
        prevT < s.choice_cue_time_s && nowT >= s.choice_cue_time_s) {
      this._spawnParticle('lick_burst', 0, -6, 0.5);
    }
    // Reward drop when water is delivered
    if (s.has_reward && s.reward_onset_time_s != null &&
        prevT < s.reward_onset_time_s && nowT >= s.reward_onset_time_s) {
      this._spawnParticle('reward_drop', 0, -4, 0.9);
    }
  }

  _spawnParticle(type, dx, dy, lifetime) {
    this._particles.push({ type, dx, dy, alpha: 1, born: this.t, lifetime });
  }

  // ---- Rendering -----------------------------------------------------------

  _render() {
    const ctx         = this.ctx;
    const sites       = this.sites;
    const mousePosCm  = mousePosAt(sites, this.t);
    const state       = mouseStateAt(sites, this.t);
    const currentSite = findSiteAt(sites, this.t);

    // Background void
    ctx.fillStyle = C.void;
    ctx.fillRect(0, 0, CW, CH);

    // Corridor strip (base tone)
    ctx.fillStyle = C.corridor;
    ctx.fillRect(CORR_X, 0, CORR_W, CH);

    // Site segments
    this._drawSites(ctx, mousePosCm);

    // Mouse
    this._drawMouse(ctx, state);

    // Particles
    this._drawParticles(ctx);

    // Callback
    if (this.onFrame) this.onFrame(this.t, currentSite);
  }

  _drawSites(ctx, mousePosCm) {
    const sites = this.sites;

    // Visible corridor range in cm
    const visCmNorth = mousePosCm - MOUSE_Y / PX_PER_CM;
    const visCmSouth = mousePosCm + (CH - MOUSE_Y) / PX_PER_CM;

    // Start scan from the first site that could be visible
    const startIdx = Math.max(0, firstSiteReaching(sites, visCmNorth) - 1);

    for (let i = startIdx; i < sites.length; i++) {
      const s = sites[i];
      if (s.start_position_cm > visCmSouth + 60) break;

      const sNorth = s.start_position_cm + s.length_cm;
      if (sNorth < visCmNorth - 60) continue;

      // Canvas y of north edge (top) and south edge (bottom)
      const yTop = Math.floor(cmToY(sNorth, mousePosCm));
      const yBot = Math.ceil(cmToY(s.start_position_cm, mousePosCm));
      const segH = Math.max(1, yBot - yTop);

      // Segment background
      const bg =
        s.site_label === 'InterPatch' ? C.ipatch :
        s.site_label === 'RewardSite' ? C.rsite  : C.isite;
      ctx.fillStyle = bg;
      ctx.fillRect(CORR_X, yTop, CORR_W, segH);

      // Top edge marker for patch segments
      if (s.site_label !== 'InterPatch') {
        ctx.fillStyle = odorColor(s.patch_label) + '55';
        ctx.fillRect(CORR_X, yTop, CORR_W, 2);
      }

      if (s.site_label === 'RewardSite') {
        this._drawRewardSite(ctx, s, mousePosCm);
      }
    }
  }

  _drawRewardSite(ctx, s, mousePosCm) {
    const spr = this.sprites;
    const centreCm = s.start_position_cm + s.length_cm / 2;
    const cy       = Math.floor(cmToY(centreCm, mousePosCm));
    if (cy < -SS || cy > CH + SS) return;

    // Odor swirl sprite, alpha proportional to reward probability
    const swirlKey = 'odor_swirl_' + (
      s.patch_label === 'odor_60' ? '60' :
      s.patch_label === 'odor_90' ? '90' : '0'
    );
    const rp = s.reward_probability ?? 0;
    ctx.globalAlpha = 0.2 + rp * 0.75;
    const swirl = spr[swirlKey];
    if (swirl) {
      ctx.drawImage(swirl, CORR_CX - SS / 2, cy - SS / 2, SS, SS);
    }
    ctx.globalAlpha = 1;

    // Centre dot
    ctx.fillStyle = odorColor(s.patch_label);
    ctx.beginPath();
    ctx.arc(CORR_CX, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Outcome ring (shown after the mouse visited the site)
    if (s.has_choice) {
      ctx.strokeStyle = s.has_reward ? C.reward : C.miss;
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(CORR_CX, cy, 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  _drawMouse(ctx, state) {
    const spr  = this.sprites;
    const name =
      state === 'licking'  ? 'mouse_lick'  :
      state === 'stopping' ? 'mouse_idle'  :
      this._runFrame === 0 ? 'mouse_run_a' : 'mouse_run_b';

    const img = spr[name];
    const mx  = MOUSE_CX - SS / 2;
    const my  = MOUSE_Y  - SS / 2;

    if (img) {
      ctx.drawImage(img, mx, my, SS, SS);
    } else {
      // Fallback
      ctx.fillStyle = '#f4d6c4';
      ctx.beginPath();
      ctx.arc(MOUSE_CX, MOUSE_Y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawParticles(ctx) {
    const spr = this.sprites;
    for (const p of this._particles) {
      const age  = this.t - p.born;
      const rise = (age / p.lifetime) * 20;
      const px   = MOUSE_CX + p.dx;
      const py   = MOUSE_Y  + p.dy - rise;
      const img  = spr[p.type];
      if (!img) continue;
      const [sw, sh] = p.type === 'reward_drop'
        ? [8 * SPR_S, 10 * SPR_S]
        : [12 * SPR_S, 12 * SPR_S];
      ctx.globalAlpha = p.alpha;
      ctx.drawImage(img, px - sw / 2, py - sh / 2, sw, sh);
    }
    ctx.globalAlpha = 1;
  }
}

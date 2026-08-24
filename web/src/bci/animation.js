/**
 * bci/animation.js — compact 2D task-state animation for BCI conditioning.
 *
 * The public BCI NWB records Zaber step timestamps, not absolute positions.
 * The spout therefore advances across the inferred travel range as recorded
 * steps accumulate.  The canvas labels that interpretation directly.
 */

import { findBciTrialAt } from './data.js';

export const CW = 360;
export const CH = 360;

const MOUSE_X = 108;
const MOUSE_NOSE_Y = 222;
const MOUSE_TOP = 214;
const MOUSE_W = 132;
const MOUSE_H = 106;
const SPOUT_X = MOUSE_X - 9;
const SPOUT_W = 18;
const SPOUT_H = 72;
const SPOUT_START_Y = 62;
const SPOUT_TRAVEL = 82;
const FOV_X = 242;
const FOV_Y = 22;
const FOV_SIZE = 96;

const SPOUT_COLOR = '#4b5563';
const TONGUE_COLOR = '#ff7faa';
const TONGUE_STROKE = '#c14d7a';
const TARGET_COLOR = '#ef4444';
const REWARD_COLOR = '#0ea5e9';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function recentEvent(events, t, decay) {
  if (!events?.length) return 0;
  let latest = null;
  for (const event of events) {
    if (event.t > t) break;
    latest = event.t;
  }
  if (latest == null || t - latest > decay) return 0;
  return 1 - (t - latest) / decay;
}

export class BciAnimation {
  constructor(canvas, data, { mouse = null, fov = null } = {}) {
    this.canvas = canvas;
    this.canvas.width = CW;
    this.canvas.height = CH;
    this.ctx = canvas.getContext('2d');
    this.data = data;
    this.sprites = { mouse, fov };
    this.duration = data.sessionEnd;
    this.t = 0;
    this.playing = false;
    this.speed = 1;
    this.onFrame = null;
    this._rafId = null;
    this._lastReal = null;
    this._loop = this._loop.bind(this);
    this._render();
  }

  play() {
    if (this.playing) return;
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
    this._lastReal = performance.now();
    this._rafId = requestAnimationFrame(this._loop);
  }

  pause() {
    this.playing = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  seekTo(t) {
    this.t = clamp(Number(t) || 0, 0, this.duration);
    this._render();
    this.onFrame?.(this.t);
  }

  setSpeed(speed) {
    this.speed = Math.max(0.1, Number(speed) || 1);
  }

  _loop(realNow) {
    if (!this.playing) return;
    const dt = (realNow - this._lastReal) / 1000;
    this._lastReal = realNow;
    this.t = Math.min(this.duration, this.t + dt * this.speed);
    this._render();
    this.onFrame?.(this.t);
    if (this.t >= this.duration) {
      this.pause();
      return;
    }
    this._rafId = requestAnimationFrame(this._loop);
  }

  _currentTrial() {
    const index = findBciTrialAt(this.data.trials, this.t);
    return index >= 0 ? this.data.trials[index] : null;
  }

  _spoutProgress(trial) {
    if (!trial?.zaberSteps?.length) return 0;
    const completed = trial.zaberSteps.filter((step) => step <= this.t).length;
    return clamp(completed / trial.zaberSteps.length, 0, 1);
  }

  _render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CW, CH);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, CW, CH);

    const trial = this._currentTrial();
    const progress = this._spoutProgress(trial);
    const spoutY = SPOUT_START_Y + progress * SPOUT_TRAVEL;
    const lick = recentEvent(this.data.licks, this.t, 0.16);
    const reward = recentEvent(this.data.rewards, this.t, 0.55);
    const target = trial?.targetX != null && trial?.targetY != null
      ? trial
      : this.data.target;

    this._drawFov(ctx, target);
    this._drawSpoutScene(ctx, spoutY, lick, reward);
  }

  _drawFov(ctx, target) {
    ctx.save();
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(FOV_X, FOV_Y, FOV_SIZE, FOV_SIZE);
    if (this.sprites.fov) {
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.sprites.fov, FOV_X, FOV_Y, FOV_SIZE, FOV_SIZE);
    } else {
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const offset = FOV_SIZE * i / 4;
        ctx.beginPath();
        ctx.moveTo(FOV_X + offset, FOV_Y);
        ctx.lineTo(FOV_X + offset, FOV_Y + FOV_SIZE);
        ctx.moveTo(FOV_X, FOV_Y + offset);
        ctx.lineTo(FOV_X + FOV_SIZE, FOV_Y + offset);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = '#64748b';
    ctx.strokeRect(FOV_X, FOV_Y, FOV_SIZE, FOV_SIZE);
    if (target?.targetX != null && target?.targetY != null) {
      const x = FOV_X + clamp(target.targetX / 512, 0, 1) * FOV_SIZE;
      const y = FOV_Y + clamp(target.targetY / 512, 0, 1) * FOV_SIZE;
      ctx.fillStyle = TARGET_COLOR;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = '#334155';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('target FOV', FOV_X, FOV_Y + FOV_SIZE + 13);
    ctx.restore();
  }

  _drawSpoutScene(ctx, spoutY, lick, reward) {
    // Keep the inferred endpoint outside the mouse silhouette. The public
    // task data has step timestamps, but not an absolute position for each
    // step, so the guide shows the relative travel range and its endpoint at
    // the mouse's nose rather than pretending to be a measured threshold.
    const endpointY = SPOUT_START_Y + SPOUT_TRAVEL;
    ctx.save();
    ctx.strokeStyle = '#94a3b8';
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(210, SPOUT_START_Y + SPOUT_H);
    ctx.lineTo(210, endpointY + SPOUT_H);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#64748b';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.strokeStyle = '#64748b';
    ctx.beginPath();
    ctx.moveTo(196, endpointY + SPOUT_H);
    ctx.lineTo(226, endpointY + SPOUT_H);
    ctx.stroke();

    ctx.fillStyle = SPOUT_COLOR;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    roundRect(ctx, SPOUT_X, spoutY, SPOUT_W, SPOUT_H, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(ctx, SPOUT_X + 3, spoutY + 4, 4, SPOUT_H - 14, 2);
    ctx.fill();

    if (this.sprites.mouse) {
      ctx.drawImage(this.sprites.mouse, MOUSE_X - MOUSE_W / 2, MOUSE_TOP, MOUSE_W, MOUSE_H);
    } else {
      ctx.fillStyle = '#cbd5e1';
      ctx.beginPath();
      ctx.ellipse(MOUSE_X, MOUSE_TOP + 55, 54, 64, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (lick > 0) {
      const tipY = spoutY + SPOUT_H;
      ctx.fillStyle = TONGUE_COLOR;
      ctx.strokeStyle = TONGUE_STROKE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(MOUSE_X, MOUSE_NOSE_Y - Math.max(10, (MOUSE_NOSE_Y - tipY) * 0.45), 5 + lick * 2, 18 * lick, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (reward > 0) {
      ctx.fillStyle = REWARD_COLOR;
      ctx.globalAlpha = 0.6 + reward * 0.4;
      ctx.beginPath();
      ctx.arc(MOUSE_X, spoutY + SPOUT_H + 9, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * playback-harness.js — shared scaffold + transport for the behavior
 * session-playback tools (Dynamic Foraging, Dynamic Routing, Patch/VR
 * Foraging).
 *
 * Every playback tool shares the same outer layout:
 *
 *   ┌ pb-header ──────────────────────────────────────────────┐
 *   │  <N trials>  <acquisition_type>   [tools]   [transport]  │  ← top-right controls
 *   ├ pb-status ──────────────────────────────────────────────┤
 *   ├ pb-body ────────────────────────────────────────────────┤
 *   │  pb-plot     ← the task's "standard plot" (brush + full)  │
 *   │  pb-scrub    ← session playhead scrubber                  │
 *   │  pb-stage    ← task animation (canvas) + small readout    │
 *   │  pb-videos   ← behavior cameras (if available)            │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The harness owns the transport wiring (play / pause / scrub / speed / step
 * buttons / spacebar / auto-pause label) and the video subsystem. Each task
 * supplies its own animation, standard plot, trial-info readout and (optional)
 * step + video behaviour via {@link Harness.activate}.
 *
 * Design goal: task-specific *layout details and plotting* stay in each
 * task module; everything reusable (controls, video load/sync, speed
 * warnings) lives here so all three tools stay in lock-step.
 */

import { mountVideos } from './playback-video.js';

/** mm:ss formatter shared by every transport. */
export function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m   = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/**
 * Build a playback harness scaffold.
 *
 * @param {object} config
 * @param {string}   [config.taskClass]       - CSS modifier, e.g. 'df' → `pb-player--df`.
 * @param {number[]} [config.speedSteps]       - Playback speed multipliers.
 * @param {number}   [config.defaultSpeedIdx]  - Index into speedSteps.
 * @param {string}   [config.stepLabel]        - 'Trial' | 'Patch' → shows ◀/▶ step buttons.
 * @returns {{ root:HTMLElement, canvas:HTMLCanvasElement, setStatus:Function, activate:Function }}
 */
export function createPlaybackHarness(config = {}) {
  const {
    taskClass = '',
    speedSteps = [1, 2, 5, 10, 25, 50],
    defaultSpeedIdx = 0,
    stepLabel = null,
  } = config;

  const root = document.createElement('section');
  root.className = `pb-player${taskClass ? ` pb-player--${taskClass}` : ''}`;
  root.tabIndex = 0;
  root.innerHTML = `
    <div class="pb-header">
      <div class="pb-header-meta">
        <span class="pb-header-count"></span>
        <span class="pb-header-actype"></span>
      </div>
      <div class="pb-header-tools"></div>
      <div class="pb-transport" hidden>
        <button class="pb-play" type="button" title="Play / pause (space)">▶</button>
        ${stepLabel ? `
        <button class="pb-prev" type="button" title="Previous ${stepLabel}">◀</button>
        <button class="pb-next" type="button" title="Next ${stepLabel}">▶</button>
        <span class="pb-step-label">${stepLabel}</span>` : ''}
        <label class="pb-speed-label">Speed
          <select class="pb-speed">
            ${speedSteps.map((s, i) =>
              `<option value="${i}"${i === defaultSpeedIdx ? ' selected' : ''}>${s}×</option>`).join('')}
          </select>
        </label>
        <span class="pb-time">00:00 / 00:00</span>
      </div>
    </div>

    <div class="pb-status">Loading session…</div>

    <div class="pb-body" hidden>
      <div class="pb-main">
        <div class="pb-stage">
          <div class="pb-stage-label" hidden></div>
          <div class="pb-stage-canvas-wrap">
            <canvas class="pb-canvas"></canvas>
          </div>
          <div class="pb-trial-info" hidden>–</div>
        </div>
        <div class="pb-scrub-row" hidden>
          <div class="pb-scrub-wrap" role="slider" aria-label="Session position" tabindex="0">
            <canvas class="pb-scrub-bg" hidden></canvas>
            <div class="pb-scrub-playhead"></div>
          </div>
        </div>
        <div class="pb-plot" hidden></div>
      </div>
      <div class="pb-videos" hidden>
        <div class="pb-videos-label">Behavior cameras</div>
        <div class="pb-videos-speed-warning" hidden>Videos only available at 1× playback</div>
        <div class="pb-videos-row"></div>
      </div>
    </div>
  `;

  const q = (sel) => root.querySelector(sel);
  const canvas   = q('.pb-canvas');
  const statusEl = q('.pb-status');

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('pb-status--error', !!isError);
  }

  let keyHandler = null;

  /**
   * Wire a loaded session into the scaffold.
   *
   * @param {object} opts
   * @param {{count?:number, label?:string, acquisitionType?:string}} [opts.header]
   * @param {object} opts.animation - Instance with { duration, t, playing,
   *   speed, play(), pause(), seekTo(t), setSpeed(s), onFrame, _loop }.
   * @param {{element:HTMLElement, updatePlayhead?:Function, setOnScrub?:Function,
   *   toggleEl?:HTMLElement}|null} [opts.plot] - The task's standard plot.
   * @param {string|null}      [opts.stageLabel]   - Caption above the canvas.
   * @param {HTMLElement|null} [opts.stageOverlay] - Abs-positioned canvas overlay.
   * @param {(el:HTMLElement, t:number)=>void|null} [opts.trialInfo] - Readout updater.
   * @param {(anim:object, dir:number)=>void|null}  [opts.onStep]    - Prev/next handler.
   * @param {(canvas:HTMLCanvasElement, duration:number)=>void|null} [opts.scrubBg]
   * @param {{base:string, t0?:number|null, cameras?:string[], signal?:AbortSignal}|null} [opts.videos]
   * @returns {object} the animation
   */
  function activate(opts = {}) {
    const {
      header = {}, animation: anim, plot = null, stageLabel = null,
      stageOverlay = null, trialInfo = null, onStep = null, scrubBg = null,
      videos = null,
    } = opts;

    const bodyEl       = q('.pb-body');
    const transportEl  = q('.pb-transport');
    const plotSlot     = q('.pb-plot');
    const stageLabelEl = q('.pb-stage-label');
    const canvasWrap   = q('.pb-stage-canvas-wrap');
    const trialInfoEl  = q('.pb-trial-info');
    const scrubRow     = q('.pb-scrub-row');
    const scrubWrap    = q('.pb-scrub-wrap');
    const scrubBgEl    = q('.pb-scrub-bg');
    const playheadEl   = q('.pb-scrub-playhead');
    const timeLbl      = q('.pb-time');
    const playBtn      = q('.pb-play');
    const speedSelect  = q('.pb-speed');
    const toolsEl      = q('.pb-header-tools');
    const videosEl     = q('.pb-videos');
    const videosRow    = q('.pb-videos-row');
    const speedWarnEl  = q('.pb-videos-speed-warning');
    const prevBtn      = q('.pb-prev');
    const nextBtn      = q('.pb-next');

    // ---- Header ----------------------------------------------------------
    q('.pb-header-count').textContent =
      header.count != null ? `${header.count} ${header.label ?? 'trials'}` : '';
    q('.pb-header-actype').textContent = header.acquisitionType ?? '';

    // ---- Standard plot slot ---------------------------------------------
    // A plot that exposes setOnScrub is itself click-to-seek, so the separate
    // scrubber would be redundant — it is only shown for tasks without one.
    let updatePlayhead = null;
    let plotIsSeekable = false;
    if (plot?.element) {
      plotSlot.innerHTML = '';
      plotSlot.appendChild(plot.element);
      plotSlot.hidden = false;
      updatePlayhead = plot.updatePlayhead ?? null;
      if (plot.setOnScrub) { plot.setOnScrub((t) => anim.seekTo(t)); plotIsSeekable = true; }
      if (plot.toggleEl) toolsEl.appendChild(plot.toggleEl);
    } else {
      plotSlot.hidden = true;
    }

    // ---- Stage caption + overlay ----------------------------------------
    if (stageLabel) { stageLabelEl.textContent = stageLabel; stageLabelEl.hidden = false; }
    if (stageOverlay) canvasWrap.appendChild(stageOverlay);
    if (trialInfo) trialInfoEl.hidden = false;

    // ---- Scrubber (only when the plot can't seek) -----------------------
    scrubRow.hidden = plotIsSeekable;
    const placePlayhead = (t) => {
      if (scrubRow.hidden || !(anim.duration > 0)) return;
      const frac = Math.min(1, Math.max(0, t / anim.duration));
      playheadEl.style.left = `${frac * 100}%`;
    };
    if (!scrubRow.hidden) {
      if (scrubBg) {
        scrubBgEl.hidden = false;
        requestAnimationFrame(() => scrubBg(scrubBgEl, anim.duration));
      }
      const seekAt = (clientX) => {
        const r = scrubWrap.getBoundingClientRect();
        if (r.width <= 0) return;
        const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
        anim.seekTo(frac * anim.duration);
      };
      let dragging = false;
      scrubWrap.addEventListener('pointerdown', (e) => {
        dragging = true;
        scrubWrap.setPointerCapture?.(e.pointerId);
        seekAt(e.clientX);
      });
      scrubWrap.addEventListener('pointermove', (e) => { if (dragging) seekAt(e.clientX); });
      const endDrag = (e) => { dragging = false; scrubWrap.releasePointerCapture?.(e.pointerId); };
      scrubWrap.addEventListener('pointerup', endDrag);
      scrubWrap.addEventListener('pointercancel', endDrag);
    }

    // ---- Transport reset -------------------------------------------------
    speedSelect.value = String(defaultSpeedIdx);
    playBtn.textContent = '▶';
    transportEl.hidden = false;

    // ---- Compose per-frame callback -------------------------------------
    anim.onFrame = (t) => {
      timeLbl.textContent = `${fmtTime(t)} / ${fmtTime(anim.duration)}`;
      updatePlayhead?.(t);
      placePlayhead(t);
      trialInfo?.(trialInfoEl, t);
    };

    anim.setSpeed(speedSteps[defaultSpeedIdx] ?? 1);
    anim.seekTo(0);

    // ---- Controls --------------------------------------------------------
    playBtn.onclick = () => {
      if (anim.playing) { anim.pause(); playBtn.textContent = '▶'; }
      else              { anim.play();  playBtn.textContent = '⏸'; }
    };
    speedSelect.onchange = () => {
      anim.setSpeed(speedSteps[Number(speedSelect.value)] ?? 1);
    };
    if (onStep && prevBtn && nextBtn) {
      prevBtn.onclick = () => onStep(anim, -1);
      nextBtn.onclick = () => onStep(anim, +1);
    }

    // Keep the play-button label correct when the animation auto-pauses at
    // the end of the session.
    const origLoop = anim._loop.bind(anim);
    anim._loop = (ts) => { origLoop(ts); if (!anim.playing) playBtn.textContent = '▶'; };

    // Spacebar → play/pause (scoped to the player).
    if (keyHandler) root.removeEventListener('keydown', keyHandler);
    keyHandler = (ev) => {
      if (ev.key === ' ' && !/^(INPUT|SELECT|TEXTAREA)$/.test(ev.target?.tagName ?? '')) {
        ev.preventDefault();
        playBtn.click();
      }
    };
    root.addEventListener('keydown', keyHandler);

    // ---- Videos ----------------------------------------------------------
    if (videos?.base) {
      mountVideos(anim, {
        base: videos.base,
        t0: videos.t0 ?? null,
        cameras: videos.cameras,
        signal: videos.signal,
        videosEl, videosRow, speedWarningEl: speedWarnEl,
      }).catch((err) => console.warn('[playback] video mount failed', err));
    }

    bodyEl.hidden = false;

    // Width-responsive animations (e.g. the VRF corridor) size their canvas
    // backing store from the laid-out width. The canvas has zero width while
    // the body is hidden, so measure once it's visible and keep it in sync on
    // resize. Fixed-size stages (DF / DR) don't expose resize() → no-op.
    if (typeof anim.resize === 'function') {
      requestAnimationFrame(() => anim.resize());
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => anim.resize());
        ro.observe(canvas);
      }
    }

    return anim;
  }

  return { root, canvas, setStatus, activate };
}

/**
 * vr_foraging/player.js — session-playback widget for the VR Foraging page.
 *
 * Renders a card containing:
 *   • a session dropdown (populated from asset_basics on mount)
 *   • a transport (play / pause / scrub / speed)
 *   • the pixel-art animation canvas
 *   • a stats readout + per-patch depletion mini-chart
 *
 * Sessions are listed eagerly from DuckDB (cheap), but the heavy NWB data is
 * streamed from S3 only after the user picks a session.
 */

import { VrfAnimation, loadSprites, findSiteAt } from './animation.js';
import { buildPatchIndex, updateDepletion }       from './depletion.js';
import { loadVrfSession }                         from './nwb-loader.js';
import { arrowTableToRows }                       from '../lib/arrow.js';

const SPRITE_URL = '/images/vrf';
const PROJECT_NAME = 'Cognitive flexibility in patch foraging';

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Create the player DOM and asynchronously populate the session dropdown.
 * @param {object} coord - DuckDB coordinator (from bootstrap).
 * @returns {HTMLElement}
 */
export function createSessionPlayer(coord) {
  const root = document.createElement('section');
  root.className = 'vrf-player';
  root.innerHTML = `
    <div class="vrf-player-header">
      <h2>Session playback</h2>
      <div class="vrf-player-selector">
        <label for="vrf-session-select">Session</label>
        <select id="vrf-session-select" disabled>
          <option>Loading sessions…</option>
        </select>
      </div>
    </div>

    <div id="vrf-player-status" class="vrf-player-status">
      Select a session to begin.
    </div>

    <div class="vrf-player-body" hidden>
      <div class="vrf-top">
        <div class="vrf-card" id="vrf-stats">–</div>

        <div class="vrf-card vrf-card--depletion">
          <div class="vrf-card-label">Patch depletion</div>
          <div id="vrf-depletion"></div>
        </div>

        <div class="vrf-card vrf-card--transport">
          <div class="vrf-transport">
            <button id="vrf-play" type="button">▶</button>
            <span id="vrf-time">00:00 / 00:00</span>
          </div>
          <div class="vrf-scrub-row">
            <input type="range" id="vrf-scrub" min="0" max="1000" step="1" value="0" />
          </div>
          <div class="vrf-speed-row">
            <label for="vrf-speed">Speed</label>
            <select id="vrf-speed">
              <option value="1">1×</option>
              <option value="5">5×</option>
              <option value="10" selected>10×</option>
              <option value="20">20×</option>
              <option value="60">60×</option>
            </select>
          </div>
          <div class="vrf-keys">
            <kbd>Space</kbd> play/pause &nbsp;
            <kbd>←</kbd> <kbd>→</kbd> prev/next patch &nbsp;
            <kbd>,</kbd> <kbd>.</kbd> speed
          </div>
        </div>
      </div>

      <div class="vrf-stage">
        <div class="vrf-stage-label">Mouse running through corridor →</div>
        <canvas id="vrf-canvas" width="480" height="120"></canvas>
      </div>
    </div>
  `;

  const select   = root.querySelector('#vrf-session-select');
  const statusEl = root.querySelector('#vrf-player-status');
  const bodyEl   = root.querySelector('.vrf-player-body');

  let currentLoad = null;            // { signal, abort } for in-flight load
  let animation   = null;

  // ---- Populate the dropdown ----------------------------------------------
  fetchSessionList(coord)
    .then((rows) => {
      select.innerHTML = '';
      if (rows.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No sessions available';
        select.appendChild(opt);
        statusEl.textContent = `No derived behavior sessions found for "${PROJECT_NAME}".`;
        return;
      }
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = `Select a session… (${rows.length} available)`;
      select.appendChild(placeholder);
      for (const r of rows) {
        const opt = document.createElement('option');
        opt.value = r.name;
        opt.textContent = formatSessionLabel(r);
        select.appendChild(opt);
      }
      select.disabled = false;
    })
    .catch((err) => {
      select.innerHTML = '';
      const opt = document.createElement('option');
      opt.textContent = 'Failed to load';
      select.appendChild(opt);
      statusEl.textContent = `Error loading sessions: ${err.message}`;
      console.error('[VRF] session list failed', err);
    });

  // ---- Dropdown change → load + render ------------------------------------
  select.addEventListener('change', async () => {
    const name = select.value;
    if (!name) {
      bodyEl.hidden = true;
      statusEl.textContent = 'Select a session to begin.';
      return;
    }

    if (currentLoad) currentLoad.abort();
    const ctrl = new AbortController();
    currentLoad = ctrl;

    bodyEl.hidden = true;
    statusEl.textContent = `Loading ${name} from S3…`;

    try {
      const t0 = performance.now();
      const [{ sites, traces }, sprites] = await Promise.all([
        loadVrfSession(name, { signal: ctrl.signal }),
        loadSprites(SPRITE_URL),
      ]);
      if (ctrl.signal.aborted) return;
      const ms = Math.round(performance.now() - t0);
      statusEl.textContent = `Loaded ${sites.length} sites · ${traces.lick_t.length} licks (${ms} ms)`;
      bodyEl.hidden = false;

      // Re-init animation against new data.
      animation?.pause();
      animation = wireAnimation(root, sites, sprites, traces);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      statusEl.textContent = `Error loading session: ${err.message}`;
      console.error('[VRF] session load failed', err);
    }
  });

  return root;
}

// ---------------------------------------------------------------------------
// Session list query
// ---------------------------------------------------------------------------

async function fetchSessionList(coord) {
  const result = await coord.query(`
    SELECT name, subject_id, acquisition_start_time
    FROM asset_basics
    WHERE acquisition_type = 'AindVrForaging'
      AND data_level = 'derived'
      AND project_name = '${PROJECT_NAME.replace(/'/g, "''")}'
      AND list_contains(modalities, 'behavior')
    ORDER BY acquisition_start_time DESC
  `);
  return arrowTableToRows(result);
}

function formatSessionLabel(row) {
  const date = row.acquisition_start_time
    ? String(row.acquisition_start_time).slice(0, 19).replace('T', ' ')
    : '';
  return `${row.subject_id ?? '?'} · ${date}`;
}

// ---------------------------------------------------------------------------
// Wire VrfAnimation + transport controls into the DOM
// ---------------------------------------------------------------------------

function wireAnimation(root, sites, sprites, traces) {
  const canvas    = root.querySelector('#vrf-canvas');
  const statsEl   = root.querySelector('#vrf-stats');
  const depEl     = root.querySelector('#vrf-depletion');
  const timeLbl   = root.querySelector('#vrf-time');
  const playBtn   = root.querySelector('#vrf-play');
  const scrubInput = root.querySelector('#vrf-scrub');
  const speedSel  = root.querySelector('#vrf-speed');

  const patchIndex = buildPatchIndex(sites);
  const anim = new VrfAnimation(canvas, sites, sprites, traces);

  let lastSiteIdx = -1;
  anim.onFrame = (t, site) => {
    scrubInput.value = (t / anim.duration) * 1000;
    timeLbl.textContent = `${fmtTime(t)} / ${fmtTime(anim.duration)}`;

    const cumRew = anim.cumRewardsAt(site.site_index);
    let stateHtml;
    if (site.site_label === 'RewardSite') {
      if (!site.has_choice)      stateHtml = '<span class="vrf-state-up">upcoming</span>';
      else if (site.has_reward)  stateHtml = '<span class="vrf-state-rew">✓ reward</span>';
      else                       stateHtml = '<span class="vrf-state-no">✗ no reward</span>';
    } else {
      stateHtml = `<span class="vrf-state-up">${site.site_label}</span>`;
    }

    const totalPatches = sites[sites.length - 1].patch_index + 1;
    statsEl.innerHTML =
      `<b>Patch ${site.patch_index + 1}/${totalPatches}</b> · ${site.patch_label} · ` +
      `site ${site.site_in_patch_index + 1}<br>` +
      `${stateHtml} · rewards <b>${cumRew}/${anim.totalRewards}</b>`;

    if (site.site_index !== lastSiteIdx) {
      lastSiteIdx = site.site_index;
      updateDepletion(depEl, patchIndex, site);
    }
  };

  // ---- Initial render -----------------------------------------------------
  anim.seekTo(0);

  // ---- Controls -----------------------------------------------------------
  const togglePlay = () => {
    if (anim.playing) { anim.pause(); playBtn.textContent = '▶'; }
    else              { anim.play();  playBtn.textContent = '⏸'; }
  };

  playBtn.onclick = togglePlay;
  scrubInput.oninput = () => {
    const t = (scrubInput.value / 1000) * anim.duration;
    lastSiteIdx = -1;
    anim.seekTo(t);
  };
  speedSel.onchange = () => anim.setSpeed(Number(speedSel.value));

  // Keyboard shortcuts (scoped to when canvas is in viewport for sanity, but
  // simple: listen on document and bail if focus is in another widget).
  if (!root._kbHandler) {
    const handler = (e) => {
      // If a different player got swapped in, the latest one wins.
      if (!root.isConnected || root.querySelector('#vrf-canvas') !== canvas) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === ' ')          { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') jumpPatch(anim, sites, +1);
      else if (e.key === 'ArrowLeft')  jumpPatch(anim, sites, -1);
      else if (e.key === ',') anim.setSpeed(Math.max(1, anim.speed - 5));
      else if (e.key === '.') anim.setSpeed(Math.min(60, anim.speed + 5));
    };
    document.addEventListener('keydown', handler);
    root._kbHandler = handler;
  }

  // Keep play-button label in sync when animation auto-pauses at end.
  const origLoop = anim._loop.bind(anim);
  anim._loop = function (ts) {
    origLoop(ts);
    if (!anim.playing) playBtn.textContent = '▶';
  };

  return anim;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(s) {
  const m   = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function jumpPatch(anim, sites, delta) {
  const cur         = findSiteAt(sites, anim.t);
  const targetPatch = Math.max(
    0,
    Math.min(sites[sites.length - 1].patch_index, cur.patch_index + delta),
  );
  const target = sites.find((s) => s.patch_index === targetPatch);
  if (!target) return;
  const wasPlaying = anim.playing;
  if (wasPlaying) anim.pause();
  anim.seekTo(target.start_time_s);
  if (wasPlaying) anim.play();
}

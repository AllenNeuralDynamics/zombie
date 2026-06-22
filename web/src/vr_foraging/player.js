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

import { VrfAnimation, loadSprites, findSiteAt, buildOdorPalette } from './animation.js';
import { buildPatchIndex, updateDepletion }       from './depletion.js';
import { loadVrfSession }                         from './nwb-loader.js';
import { arrowTableToRows }                       from '../lib/arrow.js';

const SPRITE_URL = '/images/vrf';
const PROJECT_NAME = 'Cognitive flexibility in patch foraging';

function sessionDateOf(row) {
  const ts = row.acquisition_start_time;
  if (!ts) return '';
  const ymd = String(ts).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: '2-digit',
    timeZone: 'UTC',
  });
}

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    subject: params.get('vrf_subject') || '',
    session: params.get('vrf_session') || '',
  };
}

function writeUrlState({ subject, session }) {
  const url = new URL(window.location.href);
  if (subject) url.searchParams.set('vrf_subject', subject);
  else         url.searchParams.delete('vrf_subject');
  if (session) url.searchParams.set('vrf_session', session);
  else         url.searchParams.delete('vrf_session');
  history.replaceState({}, '', url);
}

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
        <label for="vrf-subject-select">Subject</label>
        <select id="vrf-subject-select" disabled>
          <option>Loading…</option>
        </select>
        <label for="vrf-date-select">Session</label>
        <select id="vrf-date-select" disabled>
          <option>—</option>
        </select>
      </div>
    </div>

    <div id="vrf-player-status" class="vrf-player-status">
      Select a session to begin.
    </div>

    <div class="vrf-player-body" hidden>
      <div class="vrf-top">
        <div class="vrf-card" id="vrf-stats">
          <div id="vrf-stats-status">–</div>
          <div id="vrf-odor-legend" class="vrf-odor-legend" hidden></div>
        </div>

        <div class="vrf-card vrf-card--depletion">
          <div class="vrf-card-label">Patch depletion</div>
          <div id="vrf-depletion"></div>
        </div>

        <div class="vrf-card vrf-card--transport">
          <div class="vrf-transport">
            <button id="vrf-play" type="button">▶</button>
            <button id="vrf-prev" type="button">◀ Patch</button>
            <button id="vrf-next" type="button">Patch ▶</button>
            <span id="vrf-time">00:00 / 00:00</span>
          </div>
          <div class="vrf-scrub-row">
            <div class="vrf-scrub-wrap">
              <canvas id="vrf-scrub-bg"></canvas>
              <input type="range" id="vrf-scrub" min="0" max="1000" step="1" value="0" />
            </div>
          </div>
          <div class="vrf-speed-row">
            <label>Speed <span id="vrf-speed-label">10×</span></label>
            <input type="range" id="vrf-speed" min="0" max="3" step="1" value="2" />
          </div>
        </div>
      </div>

      <div class="vrf-stage">
        <div class="vrf-stage-label">Top-down view — mouse running through corridor →</div>
        <canvas id="vrf-canvas" width="480" height="120"></canvas>
      </div>
    </div>
  `;

  const subjectSelect = root.querySelector('#vrf-subject-select');
  const dateSelect    = root.querySelector('#vrf-date-select');
  const statusEl      = root.querySelector('#vrf-player-status');
  const bodyEl        = root.querySelector('.vrf-player-body');

  let sessionsBySubject = new Map();

  let currentLoad = null;            // { signal, abort } for in-flight load
  let animation   = null;

  const initialUrl = readUrlState();

  // ---- Populate the dropdowns ---------------------------------------------
  fetchSessionList(coord)
    .then((rows) => {
      subjectSelect.innerHTML = '';
      if (rows.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = 'No sessions available';
        subjectSelect.appendChild(opt);
        statusEl.textContent = `No derived behavior sessions found for "${PROJECT_NAME}".`;
        return;
      }

      sessionsBySubject = new Map();
      for (const r of rows) {
        const sid = r.subject_id ?? '?';
        if (!sessionsBySubject.has(sid)) sessionsBySubject.set(sid, []);
        sessionsBySubject.get(sid).push(r);
      }

      const subjects = [...sessionsBySubject.keys()].sort();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = `Select subject… (${subjects.length})`;
      subjectSelect.appendChild(placeholder);
      for (const sid of subjects) {
        const opt = document.createElement('option');
        opt.value = sid;
        opt.textContent = `${sid} (${sessionsBySubject.get(sid).length})`;
        subjectSelect.appendChild(opt);
      }
      subjectSelect.disabled = false;

      if (initialUrl.subject && sessionsBySubject.has(initialUrl.subject)) {
        subjectSelect.value = initialUrl.subject;
        subjectSelect.dispatchEvent(new Event('change'));
        if (initialUrl.session) {
          const sessions = sessionsBySubject.get(initialUrl.subject) ?? [];
          if (sessions.some((s) => s.name === initialUrl.session)) {
            dateSelect.value = initialUrl.session;
            dateSelect.dispatchEvent(new Event('change'));
          }
        }
      }
    })
    .catch((err) => {
      subjectSelect.innerHTML = '';
      const opt = document.createElement('option');
      opt.textContent = 'Failed to load';
      subjectSelect.appendChild(opt);
      statusEl.textContent = `Error loading sessions: ${err.message}`;
      console.error('[VRF] session list failed', err);
    });

  // ---- Subject change → populate date dropdown ----------------------------
  subjectSelect.addEventListener('change', () => {
    const sid = subjectSelect.value;
    dateSelect.innerHTML = '';
    bodyEl.hidden = true;
    if (currentLoad) { currentLoad.abort(); currentLoad = null; }
    writeUrlState({ subject: sid, session: '' });

    if (!sid) {
      const opt = document.createElement('option');
      opt.textContent = '—';
      dateSelect.appendChild(opt);
      dateSelect.disabled = true;
      statusEl.textContent = 'Select a subject to begin.';
      return;
    }

    const sessions = sessionsBySubject.get(sid) ?? [];
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = `Select session… (${sessions.length})`;
    dateSelect.appendChild(placeholder);
    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.name;
      opt.textContent = sessionDateOf(s);
      dateSelect.appendChild(opt);
    }
    dateSelect.disabled = false;
    statusEl.textContent = 'Select a session to begin.';
  });

  // ---- Date change → load + render ----------------------------------------
  dateSelect.addEventListener('change', async () => {
    const name = dateSelect.value;
    writeUrlState({ subject: subjectSelect.value, session: name });
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



// ---------------------------------------------------------------------------
// Wire VrfAnimation + transport controls into the DOM
// ---------------------------------------------------------------------------

function wireAnimation(root, sites, sprites, traces) {
  const canvas      = root.querySelector('#vrf-canvas');
  const statsEl     = root.querySelector('#vrf-stats-status');
  const legendEl    = root.querySelector('#vrf-odor-legend');
  const depEl       = root.querySelector('#vrf-depletion');
  const timeLbl     = root.querySelector('#vrf-time');
  const playBtn     = root.querySelector('#vrf-play');
  const prevBtn     = root.querySelector('#vrf-prev');
  const nextBtn     = root.querySelector('#vrf-next');
  const scrubInput  = root.querySelector('#vrf-scrub');
  const scrubBg     = root.querySelector('#vrf-scrub-bg');
  const speedSlider = root.querySelector('#vrf-speed');
  const speedLabel  = root.querySelector('#vrf-speed-label');

  const SPEED_STEPS = [1, 5, 10, 20];

  const patchIndex  = buildPatchIndex(sites);
  const odorPalette = buildOdorPalette(sites);
  renderOdorLegend(legendEl, odorPalette);
  const anim = new VrfAnimation(canvas, sites, sprites, traces, { odorPalette });

  requestAnimationFrame(() => drawScrubBg(scrubBg, sites, odorPalette, anim.duration));

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
    const swatch = site.site_label !== 'InterPatch' && odorPalette.has(site.patch_label)
      ? `<span class="vrf-odor-dot" style="background:${odorPalette.get(site.patch_label)}"></span>`
      : '';
    statsEl.innerHTML =
      `<b>Patch ${site.patch_index + 1}/${totalPatches}</b> · ${swatch}${site.patch_label} · ` +
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

  playBtn.onclick  = togglePlay;
  prevBtn.onclick  = () => jumpPatch(anim, sites, -1);
  nextBtn.onclick  = () => jumpPatch(anim, sites, +1);
  scrubInput.oninput = () => {
    const t = (scrubInput.value / 1000) * anim.duration;
    lastSiteIdx = -1;
    anim.seekTo(t);
  };
  speedSlider.oninput = () => {
    const v = SPEED_STEPS[Number(speedSlider.value)] ?? 10;
    speedLabel.textContent = `${v}×`;
    anim.setSpeed(v);
  };

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

function drawScrubBg(canvas, sites, odorPalette, duration) {
  const w = canvas.offsetWidth || canvas.parentElement?.offsetWidth || 400;
  canvas.width  = w;
  canvas.height = canvas.offsetHeight || 12;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, w, canvas.height);
  for (const s of sites) {
    if (s.stop_time_s == null) continue;
    const x1 = (s.start_time_s / duration) * w;
    const x2 = (s.stop_time_s  / duration) * w;
    ctx.fillStyle = s.site_label === 'InterPatch'
      ? '#d8d8d8'
      : (odorPalette.get(s.patch_label) ?? '#ddd');
    ctx.fillRect(x1, 0, Math.max(1, x2 - x1), canvas.height);
  }
}

function fmtTime(s) {
  const m   = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function renderOdorLegend(el, palette) {
  if (!el) return;
  if (palette.size === 0) { el.hidden = true; el.innerHTML = ''; return; }
  const items = [...palette].map(([label, color]) =>
    `<span class="vrf-odor-legend-item">` +
      `<span class="vrf-odor-dot" style="background:${color}"></span>` +
      `${escapeHtml(String(label))}` +
    `</span>`
  ).join('');
  el.innerHTML = `<span class="vrf-odor-legend-label">Odors</span>${items}`;
  el.hidden = false;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
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

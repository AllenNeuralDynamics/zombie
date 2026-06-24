/**
 * dynamic_routing/player.js — session-playback widget for the
 * Dynamic Routing platform page.
 *
 * Renders a card with:
 *   - subject + session selectors (populated from the consolidated
 *     performance table — sessions with ≥2 blocks and both modalities)
 *   - single-spout mouse-head animation with stim indicators (gabor / speaker)
 *   - block-aware event plot with brushable zoom
 *   - transport (play / pause / scrub / speed) + live trial readout
 *
 * Data is loaded on demand from the public nwb-components cache (see
 * data-loader.js).
 */

import { queryRows } from '../lib/arrow.js';
import {
  loadDrSession,
  findTrialAt,
  findBlockAt,
  PERFORMANCE_TABLE_URL,
} from './data-loader.js';
import {
  DrAnimation,
  loadMouseSprite,
  loadGaborSprite,
  loadWaterDroplet,
  loadSpeakerIcon,
} from './animation.js';
import { createEventPlot } from './event-plot.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPEED_STEPS = [1, 2, 5, 10, 25, 50];
const DEFAULT_SPEED_IDX = 0;

// Pre-select something interesting on first load. Falls back to the first
// session in the list.
const PREFERRED_SESSIONS = ['762526_2025-03-20'];

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function createDrSessionPlayer(coord) {
  const root = document.createElement('section');
  root.className = 'dr-player';
  root.innerHTML = `
    <div class="dr-player-header">
      <h3 class="platform-summary-heading">Session playback</h3>
      <div class="dr-player-selector">
        <label for="dr-subject-select">Subject</label>
        <select id="dr-subject-select" disabled>
          <option>Loading…</option>
        </select>
        <label for="dr-session-select">Session</label>
        <select id="dr-session-select" disabled>
          <option>—</option>
        </select>
      </div>
    </div>

    <div id="dr-player-status" class="dr-player-status">
      Loading session list…
    </div>

    <div class="dr-player-body" hidden>
      <div class="dr-player-top">
        <div class="dr-stage">
          <canvas id="dr-canvas"></canvas>
        </div>

        <div class="dr-plot-col">
          <div id="dr-evt-plot"></div>
          <div id="dr-trial-info" class="dr-trial-info">–</div>
          <div class="dr-legend">
            <span class="dr-legend-item"><span class="dr-swatch" style="background:#7c3aed"></span>visual block</span>
            <span class="dr-legend-item"><span class="dr-swatch" style="background:#f59e0b"></span>auditory block</span>
            <span class="dr-legend-item"><span class="dr-tick" style="background:#1e40af"></span>vis target</span>
            <span class="dr-legend-item"><span class="dr-tick" style="background:#60a5fa"></span>vis nontarget</span>
            <span class="dr-legend-item"><span class="dr-tick" style="background:#b91c1c"></span>aud target</span>
            <span class="dr-legend-item"><span class="dr-tick" style="background:#fca5a5"></span>aud nontarget</span>
            <span class="dr-legend-item"><span class="dr-tick" style="background:#9ca3af"></span>catch</span>
            <span class="dr-legend-item"><span class="dr-line dr-line-solid"></span>target response rate</span>
            <span class="dr-legend-item"><span class="dr-line dr-line-dashed"></span>cross-modal FA rate</span>
          </div>
        </div>
      </div>

      <div class="dr-transport">
        <button id="dr-play" type="button" title="Play / pause (space)">▶</button>
        <input type="range" id="dr-scrub" class="dr-scrub" min="0" max="1000" step="1" value="0" />
        <span id="dr-time" class="dr-time">00:00 / 00:00</span>
        <label class="dr-speed-label">
          Speed
          <select id="dr-speed">
            ${SPEED_STEPS.map((s, i) => `<option value="${i}"${i === DEFAULT_SPEED_IDX ? ' selected' : ''}>${s}×</option>`).join('')}
          </select>
        </label>
      </div>
    </div>
  `;

  const subjectSelect = root.querySelector('#dr-subject-select');
  const sessionSelect = root.querySelector('#dr-session-select');
  const statusEl      = root.querySelector('#dr-player-status');
  const bodyEl        = root.querySelector('.dr-player-body');

  let currentLoad = null;
  let animation = null;
  let assetsPromise = null;
  let sessionsBySubject = new Map();

  _populateSessions(coord, statusEl).then((sessions) => {
    if (sessions.length === 0) {
      subjectSelect.innerHTML = '<option>No sessions</option>';
      sessionSelect.innerHTML = '<option>—</option>';
      return;
    }
    sessionsBySubject = _groupBySubject(sessions);
    _fillSubjectSelect(subjectSelect, sessionsBySubject);
    subjectSelect.disabled = false;

    // Try the preferred session.
    let pickedSubject = null;
    let pickedSession = null;
    for (const sid of PREFERRED_SESSIONS) {
      const [subj] = sid.split('_');
      const arr = sessionsBySubject.get(subj);
      if (!arr) continue;
      const found = arr.find((s) => s.session_id === sid);
      if (found) { pickedSubject = subj; pickedSession = found; break; }
    }
    if (!pickedSubject) {
      pickedSubject = subjectSelect.options[1]?.value ?? subjectSelect.options[0]?.value;
      pickedSession = sessionsBySubject.get(pickedSubject)?.[0] ?? null;
    }
    if (pickedSubject) {
      subjectSelect.value = pickedSubject;
      _fillSessionSelect(sessionSelect, sessionsBySubject.get(pickedSubject) ?? []);
      sessionSelect.disabled = false;
      if (pickedSession) {
        sessionSelect.value = pickedSession.session_id;
        sessionSelect.dispatchEvent(new Event('change'));
      }
    }
  });

  subjectSelect.addEventListener('change', () => {
    const subj = subjectSelect.value;
    const arr = sessionsBySubject.get(subj) ?? [];
    _fillSessionSelect(sessionSelect, arr);
    sessionSelect.disabled = arr.length === 0;
    if (arr.length > 0) {
      sessionSelect.value = arr[0].session_id;
      sessionSelect.dispatchEvent(new Event('change'));
    } else {
      bodyEl.hidden = true;
      statusEl.textContent = 'No sessions for this subject.';
    }
  });

  sessionSelect.addEventListener('change', async () => {
    const sid = sessionSelect.value;
    if (!sid) {
      bodyEl.hidden = true;
      statusEl.textContent = 'Select a session to begin.';
      return;
    }

    if (currentLoad) currentLoad.abort();
    const ctrl = new AbortController();
    currentLoad = ctrl;

    bodyEl.hidden = true;
    statusEl.textContent = `Loading ${sid} from S3…`;

    assetsPromise = assetsPromise ?? Promise.all([
      loadMouseSprite(),
      loadGaborSprite(),
      loadWaterDroplet(),
      loadSpeakerIcon(),
    ]);

    try {
      const t0 = performance.now();
      const [data, [mouse, gabor, droplet, speaker]] = await Promise.all([
        loadDrSession(coord, { sessionId: sid, signal: ctrl.signal }),
        assetsPromise,
      ]);
      if (ctrl.signal.aborted) return;
      const ms = Math.round(performance.now() - t0);

      statusEl.textContent =
        `${sid} · ${data.trials.length} trials · ${data.blocks.length} blocks · ` +
        `${data.responses.t.length} responses · ${data.rewards.t.length} rewards · ` +
        `loaded in ${ms} ms`;
      bodyEl.hidden = false;

      animation?.pause();
      animation = _wireAnimation(root, data, { mouse, gabor, droplet, speaker });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      statusEl.textContent = `Error loading session: ${err.message}`;
      console.error('[DR] session load failed', err);
    }
  });

  root.addEventListener('keydown', (ev) => {
    if (ev.key === ' ' && animation) {
      ev.preventDefault();
      root.querySelector('#dr-play').click();
    }
  });

  return root;
}

// ---------------------------------------------------------------------------
// Session list query
// ---------------------------------------------------------------------------

async function _populateSessions(coord, statusEl) {
  try {
    // One row per session, aggregated from the per-block performance table.
    // Filter to "real" task sessions: ≥2 blocks AND both modalities appear
    // AND at least some responses (so the playback is non-trivial).
    const rows = await queryRows(coord, `
      SELECT
        session_id,
        ANY_VALUE(subject_id) AS subject_id,
        ANY_VALUE(date)::VARCHAR AS session_date,
        COUNT(*) AS n_blocks,
        COUNT(DISTINCT rewarded_modality) AS n_mods,
        SUM(n_trials)    AS n_trials,
        SUM(n_responses) AS n_responses,
        SUM(n_contingent_rewards) AS n_rewards,
        STRING_AGG(rewarded_modality, '' ORDER BY block_index) AS mod_seq,
        AVG(cross_modality_dprime) AS mean_dprime
      FROM read_parquet('${PERFORMANCE_TABLE_URL}')
      GROUP BY session_id
      HAVING n_blocks >= 2
         AND n_mods   = 2
         AND n_responses >= 20
      ORDER BY session_date DESC, subject_id ASC
    `);
    if (rows.length === 0) {
      statusEl.textContent = 'No dynamic-routing sessions found.';
      return [];
    }
    const nSubjects = new Set(rows.map((r) => String(r.subject_id))).size;
    statusEl.textContent =
      `${rows.length.toLocaleString()} sessions across ${nSubjects} subjects loaded. ` +
      `Pick a subject and session to begin.`;
    return rows;
  } catch (err) {
    statusEl.textContent = `Error loading session list: ${err.message}`;
    console.error('[DR] session list failed', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dropdown helpers
// ---------------------------------------------------------------------------

/**
 * Group rows by subject_id. Inner arrays preserve "session_date DESC".
 * Exported for tests.
 */
export function _groupBySubject(rows) {
  const map = new Map();
  for (const r of rows) {
    const sid = String(r.subject_id);
    let arr = map.get(sid);
    if (!arr) { arr = []; map.set(sid, arr); }
    arr.push(r);
  }
  return map;
}

function _fillSubjectSelect(select, sessionsBySubject) {
  const subjects = [...sessionsBySubject.entries()].sort(([, a], [, b]) => {
    const da = a[0]?.session_date ?? '';
    const db = b[0]?.session_date ?? '';
    return db.localeCompare(da);
  });
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = `Select a subject… (${subjects.length} subjects)`;
  select.appendChild(placeholder);
  for (const [sid, sessions] of subjects) {
    const opt = document.createElement('option');
    opt.value = sid;
    opt.textContent = `${sid} (${sessions.length} session${sessions.length === 1 ? '' : 's'})`;
    select.appendChild(opt);
  }
}

function _fillSessionSelect(select, sessions) {
  select.innerHTML = '';
  if (sessions.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '—';
    select.appendChild(opt);
    return;
  }
  for (const r of sessions) {
    const opt = document.createElement('option');
    opt.value = r.session_id;
    opt.textContent = _formatSessionLabel(r);
    select.appendChild(opt);
  }
}

function _formatSessionLabel(r) {
  const trials = Number(r.n_trials ?? 0);
  const resp   = Number(r.n_responses ?? 0);
  const dp     = Number(r.mean_dprime);
  const dpStr  = Number.isFinite(dp) ? ` · d′=${dp.toFixed(2)}` : '';
  return `${r.session_date} · ${trials} tr · ${resp} resp${dpStr}`;
}

// ---------------------------------------------------------------------------
// Wire animation + transport + plot
// ---------------------------------------------------------------------------

function _wireAnimation(root, data, sprites) {
  const canvas      = root.querySelector('#dr-canvas');
  const plotMount   = root.querySelector('#dr-evt-plot');
  const trialInfo   = root.querySelector('#dr-trial-info');
  const timeLbl     = root.querySelector('#dr-time');
  const playBtn     = root.querySelector('#dr-play');
  const scrubInput  = root.querySelector('#dr-scrub');
  const speedSelect = root.querySelector('#dr-speed');

  scrubInput.value = 0;
  speedSelect.value = String(DEFAULT_SPEED_IDX);
  playBtn.textContent = '▶';

  plotMount.innerHTML = '';
  const plot = createEventPlot(data);
  plotMount.appendChild(plot.element);

  const anim = new DrAnimation(canvas, data, sprites);
  anim.setSpeed(SPEED_STEPS[DEFAULT_SPEED_IDX]);
  anim.onFrame = (t) => {
    if (data.sessionEndS > 0) {
      scrubInput.value = Math.round((t / data.sessionEndS) * 1000);
    }
    timeLbl.textContent = `${_fmtTime(t)} / ${_fmtTime(data.sessionEndS)}`;
    plot.updatePlayhead(t);
    _updateTrialInfo(trialInfo, data, t);
  };

  anim.seekTo(0);

  playBtn.onclick = () => {
    if (anim.playing) { anim.pause(); playBtn.textContent = '▶'; }
    else              { anim.play();  playBtn.textContent = '⏸'; }
  };
  scrubInput.oninput = () => {
    const t = (Number(scrubInput.value) / 1000) * data.sessionEndS;
    anim.seekTo(t);
  };
  speedSelect.onchange = () => {
    const idx = Number(speedSelect.value);
    anim.setSpeed(SPEED_STEPS[idx] ?? 1);
  };
  plot.setOnScrub((t) => anim.seekTo(t));

  // Keep play button label correct when animation auto-pauses at end.
  const origLoop = anim._loop.bind(anim);
  anim._loop = (ts) => {
    origLoop(ts);
    if (!anim.playing) playBtn.textContent = '▶';
  };

  return anim;
}

// ---------------------------------------------------------------------------
// Trial-info readout
// ---------------------------------------------------------------------------

function _updateTrialInfo(el, data, t) {
  const ti = findTrialAt(data.trials, t);
  if (ti < 0) {
    el.innerHTML = '<span class="dr-trial-pre">before first trial</span>';
    return;
  }
  const tr = data.trials[ti];
  const bi = findBlockAt(data.blocks, t);
  const block = bi >= 0 ? data.blocks[bi] : null;
  const modLbl = block?.rewardedMod === 'aud'
    ? '<span class="dr-mod-aud">AUD</span>'
    : '<span class="dr-mod-vis">VIS</span>';

  const stimColor = {
    vis_target:    '#1e40af',
    vis_nontarget: '#60a5fa',
    aud_target:    '#b91c1c',
    aud_nontarget: '#fca5a5',
    catch:         '#9ca3af',
  };
  const kind = _stimKindOf(tr);
  const stimLbl = `<span style="color:${stimColor[kind] ?? '#000'};font-weight:600">${tr.stim ?? '?'}</span>`;

  const outcome = tr.isHit ? '<span class="dr-out-hit">HIT</span>'
                : tr.isMiss ? '<span class="dr-out-miss">miss</span>'
                : tr.isFA   ? '<span class="dr-out-fa">FA</span>'
                : tr.isCR   ? '<span class="dr-out-cr">CR</span>'
                : '';
  const rew = tr.isRewarded ? ' · <span class="dr-rew-yes">✓ reward</span>' : '';
  const auto = tr.isAutoRew ? ' <span class="dr-auto">(auto)</span>' : '';

  el.innerHTML =
    `<b>Trial ${(tr.trial ?? ti) + 1}</b> · block ${block?.block ?? '?'} ` +
    `(${modLbl} rewarded) · stim ${stimLbl} · ${outcome}${rew}${auto}`;
}

function _stimKindOf(tr) {
  if (tr.isCatch) return 'catch';
  if (tr.isVisTarget) return 'vis_target';
  if (tr.isVisNontg)  return 'vis_nontarget';
  if (tr.isAudTarget) return 'aud_target';
  if (tr.isAudNontg)  return 'aud_nontarget';
  if (tr.stim === 'vis1')   return 'vis_target';
  if (tr.stim === 'vis2')   return 'vis_nontarget';
  if (tr.stim === 'sound1') return 'aud_target';
  if (tr.stim === 'sound2') return 'aud_nontarget';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m   = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

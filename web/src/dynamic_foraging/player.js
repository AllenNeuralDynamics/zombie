/**
 * dynamic_foraging/player.js — session-playback widget for the Dynamic
 * Foraging platform page.
 *
 * Renders a card with:
 *   • session selector (from platform_dynamic_foraging_sessions DuckDB table)
 *   • mouse-head dorsal animation + lick spouts + tongue
 *   • reward-probability trace plot with moving playhead and choice ticks
 *   • transport (play/pause/seek/speed) and live trial readout
 *
 * Data comes from the public `aind-dynamic-foraging-database` (see
 * data-loader.js). Real lick timing drives the animation.
 */

import { queryRows } from '../lib/arrow.js';
import { loadDfSession, findTrialAt, SESSION_TABLE_URL } from './data-loader.js';
import { DfAnimation, loadMouseSprite, loadCueIcon, loadWaterDroplet } from './animation.js';
import { createProbPlot } from './prob-plot.js';
import { createPlaybackHarness } from '../lib/behaviors/playback-harness.js';
import { s3LocationToHttps } from '../lib/behaviors/playback-video.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SPEED_STEPS = [1, 2, 5, 10, 25, 50];   // playback speed multipliers
const DEFAULT_SPEED_IDX = 0;                 // 1× — real timing by default

// Pre-select something reasonable on first load so the user sees the animation
// without having to pick anything. Falls back to "first session in the list".
const PREFERRED_SESSIONS = [
  // [subjectId, sessionDate, nwbSuffix]
  ['754372', '2024-10-21', 133237],
];

// ---------------------------------------------------------------------------
// Shared markup
// ---------------------------------------------------------------------------

// The stage + plot + transport body, shared by the full (dropdown) player and
// the embedded single-session playback widget.
const DF_BODY_HTML = `
    <div class="df-player-body" hidden>
      <div class="df-player-top">
        <div class="df-stage">
          <canvas id="df-canvas"></canvas>
          <div class="df-stage-labels">
            <span class="df-spout-label df-spout-label-l">L</span>
            <span class="df-spout-label df-spout-label-r">R</span>
          </div>
        </div>

        <div class="df-plot-col">
          <div id="df-prob-plot"></div>
          <div id="df-trial-info" class="df-trial-info">–</div>
        </div>
      </div>

      <div class="df-transport">
        <button id="df-play" type="button" title="Play / pause (space)">▶</button>
        <input type="range" id="df-scrub" class="df-scrub" min="0" max="1000" step="1" value="0" />
        <span id="df-time" class="df-time">00:00 / 00:00</span>
        <label class="df-speed-label">
          Speed
          <select id="df-speed">
            ${SPEED_STEPS.map((s, i) => `<option value="${i}"${i === DEFAULT_SPEED_IDX ? ' selected' : ''}>${s}×</option>`).join('')}
          </select>
        </label>
      </div>
    </div>
  `;

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function createDfSessionPlayer(coord) {
  const root = document.createElement('section');
  root.className = 'df-player';
  root.innerHTML = `
    <div class="df-player-header">
      <h3 class="platform-summary-heading">Session playback</h3>
      <div class="df-player-selector">
        <label for="df-subject-select">Subject</label>
        <select id="df-subject-select" disabled>
          <option>Loading…</option>
        </select>
        <label for="df-session-select">Session</label>
        <select id="df-session-select" disabled>
          <option>—</option>
        </select>
      </div>
    </div>

    <div id="df-player-status" class="df-player-status">
      Loading session list…
    </div>
    ${DF_BODY_HTML}
  `;

  const subjectSelect = root.querySelector('#df-subject-select');
  const sessionSelect = root.querySelector('#df-session-select');
  const statusEl      = root.querySelector('#df-player-status');
  const bodyEl        = root.querySelector('.df-player-body');

  let currentLoad = null;
  let animation = null;
  let assetsPromise = null;
  // subject_id (string) -> session rows array
  let sessionsBySubject = new Map();

  // ---- Populate subject dropdown ---------------------------------------
  _populateSessions(coord, statusEl).then((sessions) => {
    if (sessions.length === 0) {
      subjectSelect.innerHTML = '<option>No sessions</option>';
      sessionSelect.innerHTML = '<option>—</option>';
      return;
    }
    sessionsBySubject = _groupBySubject(sessions);
    _fillSubjectSelect(subjectSelect, sessionsBySubject);
    subjectSelect.disabled = false;

    // Pick a preferred (subject, session) if it's present.
    let pickedSubject = null;
    let pickedSession = null;
    for (const [sid, date, suf] of PREFERRED_SESSIONS) {
      const subjSessions = sessionsBySubject.get(String(sid));
      if (!subjSessions) continue;
      const found = subjSessions.find(
        (s) => s.session_date === date && Number(s.nwb_suffix) === suf,
      );
      if (found) { pickedSubject = String(sid); pickedSession = found; break; }
    }
    // Fallback: most-recent subject + their most-recent session.
    if (!pickedSubject) {
      pickedSubject = subjectSelect.options[1]?.value ?? subjectSelect.options[0]?.value;
      pickedSession = sessionsBySubject.get(pickedSubject)?.[0] ?? null;
    }
    if (pickedSubject) {
      subjectSelect.value = pickedSubject;
      _fillSessionSelect(sessionSelect, sessionsBySubject.get(pickedSubject) ?? []);
      sessionSelect.disabled = false;
      if (pickedSession) {
        sessionSelect.value = _sessionKey(pickedSession);
        sessionSelect.dispatchEvent(new Event('change'));
      }
    }
  });

  // ---- Subject change → refill session dropdown -----------------------
  subjectSelect.addEventListener('change', () => {
    const subj = subjectSelect.value;
    const subjSessions = sessionsBySubject.get(subj) ?? [];
    _fillSessionSelect(sessionSelect, subjSessions);
    sessionSelect.disabled = subjSessions.length === 0;
    if (subjSessions.length > 0) {
      sessionSelect.value = _sessionKey(subjSessions[0]);
      sessionSelect.dispatchEvent(new Event('change'));
    } else {
      bodyEl.hidden = true;
      statusEl.textContent = 'No sessions for this subject.';
    }
  });

  // ---- Session change → load + animate ---------------------------------
  sessionSelect.addEventListener('change', async () => {
    const key = sessionSelect.value;
    if (!key) {
      bodyEl.hidden = true;
      statusEl.textContent = 'Select a session to begin.';
      return;
    }
    const session = _parseSessionKey(key);

    if (currentLoad) currentLoad.abort();
    const ctrl = new AbortController();
    currentLoad = ctrl;

    bodyEl.hidden = true;
    statusEl.textContent = `Loading ${session.subject_id} · ${session.session_date} from S3…`;

      assetsPromise = assetsPromise ?? Promise.all([loadMouseSprite(), loadCueIcon(), loadWaterDroplet()]);

    try {
      const t0 = performance.now();
      const [data, [mouseImg, cueIcon, dropletImg]] = await Promise.all([
        loadDfSession(coord, {
          subjectId: session.subject_id,
          sessionDate: session.session_date,
          nwbSuffix: session.nwb_suffix,
          signal: ctrl.signal,
        }),
        assetsPromise,
      ]);
      if (ctrl.signal.aborted) return;
      const ms = Math.round(performance.now() - t0);

      statusEl.textContent =
        `${session.subject_id} · ${session.session_date} · ` +
        `${data.trials.length} trials · ${data.licks.t.length} licks · ` +
        `loaded in ${ms} ms`;
      bodyEl.hidden = false;

      animation?.pause();
      animation = _wireAnimation(root, data, mouseImg, cueIcon, dropletImg);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      statusEl.textContent = `Error loading session: ${err.message}`;
      console.error('[DF] session load failed', err);
    }
  });

  // ---- Keyboard shortcut: space = play/pause ---------------------------
  root.addEventListener('keydown', (ev) => {
    if (ev.key === ' ' && animation) {
      ev.preventDefault();
      const btn = root.querySelector('#df-play');
      btn.click();
    }
  });

  return root;
}

/**
 * Create a single-session DF playback widget (no subject/session dropdowns).
 * Used inside the subject viewer's "Data" tab. Built on the shared playback
 * harness so transport, video loading/sync and speed warnings are common to
 * every behavior platform.
 *
 * @param {object} coord - DuckDB coordinator.
 * @param {{ subject_id: string, session_date: string, nwb_suffix: string|number }} session
 * @param {object} [opts]
 * @param {string} [opts.acquisitionType] - Shown in the header row.
 * @param {string} [opts.location]        - Raw asset S3 location (for videos).
 * @returns {HTMLElement}
 */
export function createDfSessionPlayback(coord, session, opts = {}) {
  const harness = createPlaybackHarness({
    taskClass: 'df',
    speedSteps: SPEED_STEPS,
    defaultSpeedIdx: DEFAULT_SPEED_IDX,
  });
  const root = harness.root;
  root.classList.add('df-player', 'df-player--embedded');

  const ctrl = new AbortController();

  (async () => {
    harness.setStatus(`Loading ${session.subject_id} · ${session.session_date} from S3…`);
    try {
      const t0 = performance.now();
      const [data, [mouseImg, cueIcon, dropletImg]] = await Promise.all([
        loadDfSession(coord, {
          subjectId: session.subject_id,
          sessionDate: session.session_date,
          nwbSuffix: session.nwb_suffix,
          signal: ctrl.signal,
        }),
        Promise.all([loadMouseSprite(), loadCueIcon(), loadWaterDroplet()]),
      ]);
      if (ctrl.signal.aborted) return;
      const ms = Math.round(performance.now() - t0);
      harness.setStatus(
        `${session.subject_id} · ${session.session_date} · ` +
        `${data.trials.length} trials · ${data.licks.t.length} licks · loaded in ${ms} ms`);

      const anim = new DfAnimation(harness.canvas, data, mouseImg, cueIcon, dropletImg);
      const plot = createProbPlot(data);

      harness.activate({
        header: {
          count: data.trials.length,
          label: 'trials',
          acquisitionType: opts.acquisitionType ?? '',
        },
        animation: anim,
        plot,
        stageOverlay: _buildSpoutLabels(),
        trialInfo: (el, t) => _updateTrialInfo(el, data.trials, t),
        videos: { base: s3LocationToHttps(opts.location), t0: null, signal: ctrl.signal },
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      harness.setStatus(`Error loading session: ${err.message}`, true);
      console.error('[DF] embedded session load failed', err);
    }
  })();

  return root;
}

/** L/R spout labels overlaid on the animation canvas. */
function _buildSpoutLabels() {
  const wrap = document.createElement('div');
  wrap.className = 'df-stage-labels';
  wrap.innerHTML =
    '<span class="df-spout-label df-spout-label-l">L</span>' +
    '<span class="df-spout-label df-spout-label-r">R</span>';
  return wrap;
}

// ---------------------------------------------------------------------------
// Session list query
// ---------------------------------------------------------------------------

async function _populateSessions(coord, statusEl) {
  try {
    // Source the dropdown from the DF database's own session_table so every
    // listed session is guaranteed to have backing trial+event data. (The
    // separate `platform_dynamic_foraging_sessions` cache can be days fresher than the DF
    // build, leading to "session found, trials missing" mismatches.)
    const rows = await queryRows(coord, `
      SELECT
        subject_id, session_date, nwb_suffix, task,
        total_trials, finished_trials, foraging_eff,
        current_stage_actual
      FROM read_parquet('${SESSION_TABLE_URL}')
      WHERE total_trials >= 100
        AND nwb_suffix IS NOT NULL
        AND (task LIKE '%Coupled%' OR task LIKE '%Uncoupled%')
      ORDER BY session_date DESC, subject_id
    `);
    if (rows.length === 0) {
      statusEl.textContent = 'No foraging sessions found in the DF database.';
      return [];
    }
    const nSubjects = new Set(rows.map((r) => String(r.subject_id))).size;
    statusEl.textContent =
      `${rows.length.toLocaleString()} sessions across ${nSubjects} subjects loaded from the DF database. ` +
      `Pick a subject and session to begin.`;
    return rows;
  } catch (err) {
    statusEl.textContent = `Error loading session list: ${err.message}`;
    console.error('[DF] session list failed', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Dropdown helpers
// ---------------------------------------------------------------------------

/**
 * Group session rows by subject_id (stringified). The inner arrays preserve
 * the input ordering, which is already "session_date DESC", so each subject's
 * most-recent session lands at index 0.
 *
 * @param {object[]} rows
 * @returns {Map<string, object[]>}
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
  // Sort subjects by most-recent session date (descending) so the freshest
  // mouse is at the top.
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
    opt.value = _sessionKey(r);
    opt.textContent = _formatSessionLabel(r);
    select.appendChild(opt);
  }
}

function _sessionKey(r) {
  return `${r.subject_id}|${r.session_date}|${Number(r.nwb_suffix)}`;
}

function _parseSessionKey(k) {
  const [subject_id, session_date, suf] = k.split('|');
  return { subject_id, session_date, nwb_suffix: Number(suf) };
}

function _formatSessionLabel(r) {
  const eff = r.foraging_eff != null && !isNaN(r.foraging_eff)
    ? ` · η=${Number(r.foraging_eff).toFixed(2)}`
    : '';
  const trials = r.finished_trials ?? r.total_trials ?? '?';
  return `${r.session_date} · ${trials} trials${eff}`;
}

// ---------------------------------------------------------------------------
// Wire animation + transport + plot
// ---------------------------------------------------------------------------

function _wireAnimation(root, data, mouseImg, cueIcon, dropletImg) {
  const canvas      = root.querySelector('#df-canvas');
  const plotMount   = root.querySelector('#df-prob-plot');
  const trialInfo   = root.querySelector('#df-trial-info');
  const timeLbl     = root.querySelector('#df-time');
  const playBtn     = root.querySelector('#df-play');
  const scrubInput  = root.querySelector('#df-scrub');
  const speedSelect = root.querySelector('#df-speed');

  // Reset transport visuals
  scrubInput.value = 0;
  speedSelect.value = String(DEFAULT_SPEED_IDX);
  playBtn.textContent = '▶';

  // Build / replace the probability plot (it self-sizes to its container).
  plotMount.innerHTML = '';
  const plot = createProbPlot(data);
  plotMount.appendChild(plot.element);

  const headerEl = root.querySelector('.df-player-header');
  const existingToggle = headerEl?.querySelector('.df-x-toggle');
  if (existingToggle) existingToggle.remove();
  if (plot.toggleEl && headerEl) headerEl.appendChild(plot.toggleEl);

  const anim = new DfAnimation(canvas, data, mouseImg, cueIcon, dropletImg);
  anim.setSpeed(SPEED_STEPS[DEFAULT_SPEED_IDX]);
  anim.onFrame = (t) => {
    if (data.sessionEndS > 0) {
      scrubInput.value = Math.round((t / data.sessionEndS) * 1000);
    }
    timeLbl.textContent = `${_fmtTime(t)} / ${_fmtTime(data.sessionEndS)}`;
    plot.updatePlayhead(t);
    _updateTrialInfo(trialInfo, data.trials, t);
  };

  // Initial render
  anim.seekTo(0);

  // Controls
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
  plot.setOnScrub((t) => {
    anim.seekTo(t);
  });

  // Keep play-button label correct when animation auto-pauses at end.
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

function _updateTrialInfo(el, trials, t) {
  const i = findTrialAt(trials, t);
  if (i < 0) { el.innerHTML = '<span class="df-trial-pre">before first go-cue</span>'; return; }
  const tr = trials[i];
  const sideLbl  = tr.response === 0 ? '<span class="df-side-l">L</span>'
                 : tr.response === 1 ? '<span class="df-side-r">R</span>'
                 :                     '<span class="df-side-ign">ignored</span>';
  const rewLbl   = tr.earned ? '<span class="df-rew-yes">✓ reward</span>'
                 : tr.response === 2 ? ''
                 :                     '<span class="df-rew-no">✗ no reward</span>';
  const auto     = tr.autoL || tr.autoR ? ' <span class="df-auto">(autowater)</span>' : '';
  const pL = Number.isFinite(tr.pL) ? tr.pL.toFixed(2) : '–';
  const pR = Number.isFinite(tr.pR) ? tr.pR.toFixed(2) : '–';
  el.innerHTML =
    `<b>Trial ${(tr.trial ?? i) + (Number.isInteger(tr.trial) ? 0 : 1)}</b> · ` +
    `choice ${sideLbl} · ` +
    `<span class="df-prob"><span class="df-side-l">pL=${pL}</span> ` +
    `<span class="df-side-r">pR=${pR}</span></span> · ` +
    `${rewLbl}${auto}`;
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

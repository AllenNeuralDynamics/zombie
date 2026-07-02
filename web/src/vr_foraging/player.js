/**
 * vr_foraging/player.js — session-playback widget for the VR Foraging page.
 *
 * Renders a card containing:
 *   • a session dropdown (populated from asset_basics on mount)
 *   • a transport (play / pause / scrub / speed)
 *   • the pixel-art animation canvas
 *   • a stats readout + per-patch depletion mini-chart
 *   • behavior camera videos (FaceCamera, FrontCamera, SideCamera), synced
 *     to the timeline via the Harp ReferenceTime in each camera's metadata.csv
 *
 * Sessions are listed eagerly from DuckDB (cheap), but the heavy NWB data is
 * streamed from S3 only after the user picks a session.
 */

import { VrfAnimation, loadSprites, findSiteAt, buildOdorPalette } from './animation.js';
import { buildPatchIndex, updateDepletion }       from './depletion.js';
import { createVrfTracePlot }                     from './trace-plot.js';
import { patchColor }                             from './theme.js';
import { loadVrfSession }                         from './nwb-loader.js';
import { arrowTableToRows }                       from '../lib/arrow.js';
import { buildS3ConsoleUrl, buildQcLink, buildMetadataLink, buildCoLink } from '../assets/links.js';
import { ensureTable }                            from '../lib/registry.js';
import { withVideoGate }                          from '../lib/video-gate.js';
import { createPlaybackHarness }                  from '../lib/behaviors/playback-harness.js';

const SPRITE_URL = '/images/vrf';
const PROJECT_NAME = 'Cognitive flexibility in patch foraging';
const CAMERAS = ['FaceCamera', 'FrontCamera', 'SideCamera'];

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
// Shared markup
// ---------------------------------------------------------------------------

// The stats + transport + stage + videos body, shared by the full (dropdown)
// player and the embedded single-session playback widget.
const VRF_BODY_HTML = `
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

      <div class="vrf-videos" id="vrf-videos" hidden>
        <div class="vrf-videos-label">Behavior cameras</div>
        <div class="vrf-videos-speed-warning" id="vrf-videos-speed-warning" hidden>
          Videos only available at 1× playback
        </div>
        <div class="vrf-videos-row" id="vrf-videos-row"></div>
      </div>
    </div>
  `;

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
      <div class="vrf-player-links" id="vrf-player-links" hidden>
        <a id="vrf-link-subject" target="_blank" rel="noopener">Subject</a>
        <a id="vrf-link-co" target="_blank" rel="noopener">CO</a>
        <a id="vrf-link-meta" target="_blank" rel="noopener">Meta</a>
        <a id="vrf-link-qc" target="_blank" rel="noopener">QC</a>
        <a id="vrf-link-s3" target="_blank" rel="noopener">S3</a>
      </div>
    </div>

    <div id="vrf-player-status" class="vrf-player-status">
      Select a session to begin.
    </div>
    ${VRF_BODY_HTML}
  `;

  const subjectSelect = root.querySelector('#vrf-subject-select');
  const dateSelect    = root.querySelector('#vrf-date-select');
  const statusEl      = root.querySelector('#vrf-player-status');
  const bodyEl        = root.querySelector('.vrf-player-body');
  const linksEl       = root.querySelector('#vrf-player-links');

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
    linksEl.hidden = true;
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
      linksEl.hidden = true;
      statusEl.textContent = 'Select a session to begin.';
      return;
    }

    const sessions = sessionsBySubject.get(subjectSelect.value) ?? [];
    const sessionRow = sessions.find((s) => s.name === name);
    updateLinks(linksEl, sessionRow);

    if (currentLoad) currentLoad.abort();
    const ctrl = new AbortController();
    currentLoad = ctrl;

    bodyEl.hidden = true;
    statusEl.textContent = `Loading ${name} from S3…`;

    try {
      const t0 = performance.now();
      const [{ sites, traces }, sprites, rawLocation] = await Promise.all([
        loadVrfSession(name, { signal: ctrl.signal }),
        loadSprites(SPRITE_URL),
        fetchRawLocation(coord, name),
      ]);
      if (ctrl.signal.aborted) return;
      const ms = Math.round(performance.now() - t0);
      statusEl.textContent = `Loaded ${sites.length} sites · ${traces.lick_t.length} licks (${ms} ms)`;
      bodyEl.hidden = false;

      // Load camera sync data in the background — don't block playback.
      const videosEl  = root.querySelector('#vrf-videos');
      const videosRow = root.querySelector('#vrf-videos-row');
      videosEl.hidden = true;
      videosRow.innerHTML = '';

      // Re-init animation against new data.
      animation?.pause();
      animation = wireAnimation(root, sites, sprites, traces, null);

      if (rawLocation) {
        const rawBase = s3LocationToHttps(rawLocation);
        loadCameraSync(rawBase, ctrl.signal).then((cameraSyncs) => {
          if (ctrl.signal.aborted) return;
          if (!cameraSyncs.length) return;
          mountGatedVideos(root, animation, videosEl, videosRow, rawBase, cameraSyncs, traces.t0_offset);
        }).catch((err) => {
          console.warn('[VRF] camera video load failed', err);
        });
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      statusEl.textContent = `Error loading session: ${err.message}`;
      console.error('[VRF] session load failed', err);
    }
  });

  return root;
}

/**
 * Resolve the derived VR-foraging session asset name for a given RAW
 * acquisition asset. The subject timeline only carries raw acquisitions, but
 * the player streams from the derived asset, so we reverse-map raw → derived
 * via the source_data table.
 *
 * @param {object} coord - DuckDB coordinator.
 * @param {string} rawName - Raw acquisition asset name.
 * @returns {Promise<string|null>} derived asset name, or null if none found.
 */
export async function resolveVrfDerivedName(coord, rawName) {
  if (!rawName) return null;
  try {
    await ensureTable(coord, 'source_data');
    const safe = rawName.replace(/'/g, "''");
    // source_data.source_data is a comma+space-joined list of raw source names;
    // match the raw acquisition anywhere in that list. Restrict to derived VRF
    // behavior assets so we land on the asset loadVrfSession expects.
    const result = await coord.query(`
      SELECT sd.name
      FROM source_data sd
      JOIN asset_basics ab ON ab.name = sd.name
      WHERE ('; ' || replace(sd.source_data, ', ', '; ') || ';') LIKE '%; ${safe};%'
        AND ab.acquisition_type = 'AindVrForaging'
        AND ab.data_level = 'derived'
        AND list_contains(ab.modalities, 'behavior')
      ORDER BY ab.acquisition_start_time DESC
      LIMIT 1
    `);
    const rows = arrowTableToRows(result);
    return rows[0]?.name ?? null;
  } catch (err) {
    console.warn('[VRF] resolveVrfDerivedName failed', err);
    return null;
  }
}

/**
 * Create a single-session VRF playback widget (no subject/session dropdowns).
 * Used inside the subject viewer's "Data" tab. Accepts the RAW acquisition
 * asset name and resolves the derived session internally. Built on the shared
 * playback harness (common transport + video subsystem).
 *
 * @param {object} coord - DuckDB coordinator.
 * @param {string} rawName - Raw acquisition asset name.
 * @param {object} [opts]
 * @param {string} [opts.acquisitionType] - Shown in the header row.
 * @param {string} [opts.location]        - Raw asset S3 location (for videos).
 * @returns {HTMLElement}
 */
export function createVrfSessionPlayback(coord, rawName, opts = {}) {
  const harness = createPlaybackHarness({
    taskClass: 'vrf',
    speedSteps: VRF_SPEED_STEPS,
    defaultSpeedIdx: VRF_DEFAULT_SPEED_IDX,
    stepLabel: 'Patch',
  });
  const root = harness.root;
  root.classList.add('vrf-player', 'vrf-player--embedded');

  const ctrl = new AbortController();

  (async () => {
    const derivedName = await resolveVrfDerivedName(coord, rawName);
    if (!derivedName) {
      harness.setStatus('No derived VR-foraging session found for this acquisition.', true);
      return;
    }
    harness.setStatus(`Loading ${derivedName} from S3…`);
    try {
      const t0 = performance.now();
      // Prefer the raw location threaded in from the event; fall back to the
      // source_data lookup when it isn't available.
      const [{ sites, traces }, sprites, rawLocation] = await Promise.all([
        loadVrfSession(derivedName, { signal: ctrl.signal }),
        loadSprites(SPRITE_URL),
        opts.location
          ? Promise.resolve(opts.location)
          : fetchRawLocation(coord, derivedName),
      ]);
      if (ctrl.signal.aborted) return;
      const ms = Math.round(performance.now() - t0);

      const totalPatches = sites.length ? sites[sites.length - 1].patch_index + 1 : 0;
      harness.setStatus(`Loaded ${sites.length} sites · ${traces.lick_t.length} licks (${ms} ms)`);

      const odorPalette = buildOdorPalette(sites);
      const anim = new VrfAnimation(harness.canvas, sites, sprites, traces, { odorPalette });

      // Standard patch-foraging figure: running velocity + patch-colour bands
      // with Choices / Rewards / Licks rows above, plus a brushable zoom strip.
      const tracePlot = createVrfTracePlot({ sites, traces });
      const patchIndex = buildPatchIndex(sites);

      let statsLine = null;
      let depEl = null;
      let lastSiteIdx = -1;
      const trialInfo = (el, t) => {
        const site = findSiteAt(sites, t);
        if (!site) return;
        if (!statsLine) {
          el.innerHTML = '';
          statsLine = document.createElement('div');
          statsLine.className = 'vrf-stats-line';
          const card = document.createElement('div');
          card.className = 'vrf-card vrf-card--depletion';
          card.innerHTML = '<div class="vrf-card-label">Patch depletion</div>';
          depEl = document.createElement('div');
          card.appendChild(depEl);
          el.appendChild(statsLine);
          el.appendChild(card);
        }
        _renderVrfStats(statsLine, anim, sites, site, odorPalette, totalPatches);
        if (site.site_index !== lastSiteIdx) {
          lastSiteIdx = site.site_index;
          updateDepletion(depEl, patchIndex, site);
        }
      };

      harness.activate({
        header: {
          count: totalPatches,
          label: 'patches',
          acquisitionType: opts.acquisitionType ?? '',
        },
        animation: anim,
        plot: tracePlot,
        trialInfo,
        onStep: (a, dir) => jumpPatch(a, sites, dir),
        videos: {
          base: s3LocationToHttps(rawLocation),
          t0: traces.t0_offset,
          signal: ctrl.signal,
        },
      });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      harness.setStatus(`Error loading session: ${err.message}`, true);
      console.error('[VRF] embedded session load failed', err);
    }
  })();

  return root;
}

// Speed presets for the shared harness (select-based). Keeps the original VRF
// default of 10×.
const VRF_SPEED_STEPS = [1, 5, 10, 20];
const VRF_DEFAULT_SPEED_IDX = 2;

/** Build the VRF plot-slot content: odor legend + patch-depletion chart. */
function _buildVrfPlotSlot(odorPalette) {
  const plotEl = document.createElement('div');
  plotEl.className = 'vrf-plot-slot';

  const legendEl = document.createElement('div');
  legendEl.className = 'vrf-odor-legend';
  renderOdorLegend(legendEl, odorPalette);
  plotEl.appendChild(legendEl);

  const card = document.createElement('div');
  card.className = 'vrf-card vrf-card--depletion';
  card.innerHTML = '<div class="vrf-card-label">Patch depletion</div>';
  const depletionEl = document.createElement('div');
  card.appendChild(depletionEl);
  plotEl.appendChild(card);

  return { plotEl, depletionEl };
}

/** Render the per-frame patch/site/reward readout into `el`. */
function _renderVrfStats(el, anim, sites, site, odorPalette, totalPatches) {
  const cumRew = anim.cumRewardsAt(site.site_index);
  let stateHtml;
  if (site.site_label === 'RewardSite') {
    if (!site.has_choice)      stateHtml = '<span class="vrf-state-up">upcoming</span>';
    else if (site.has_reward)  stateHtml = '<span class="vrf-state-rew">✓ reward</span>';
    else                       stateHtml = '<span class="vrf-state-no">✗ no reward</span>';
  } else {
    stateHtml = `<span class="vrf-state-up">${site.site_label}</span>`;
  }

  const swatch = site.site_label === 'RewardSite'
    ? `<span class="vrf-odor-dot" style="background:${patchColor(site.patch_index)}"></span>`
    : '';
  el.innerHTML =
    `<b>Patch ${site.patch_index + 1}/${totalPatches}</b> · ${swatch}${site.patch_label} · ` +
    `site ${site.site_in_patch_index + 1} · ` +
    `${stateHtml} · rewards <b>${cumRew}/${anim.totalRewards}</b>`;
}

// ---------------------------------------------------------------------------
// Session list query + raw asset helpers
// ---------------------------------------------------------------------------

/**
 * Look up the raw source asset location for a derived session name.
 * Returns an S3 location string (e.g. "s3://aind-open-data/…") or null.
 */
async function fetchRawLocation(coord, derivedName) {
  try {
    await ensureTable(coord, 'source_data');
    const result = await coord.query(`
      SELECT ab.location
      FROM source_data sd
      JOIN asset_basics ab ON ab.name = sd.source_data
      WHERE sd.name = '${derivedName.replace(/'/g, "''")}'
        AND sd.source_data IS NOT NULL AND sd.source_data != ''
      LIMIT 1
    `);
    const rows = arrowTableToRows(result);
    return rows[0]?.location ?? null;
  } catch (err) {
    console.warn('[VRF] fetchRawLocation failed', err);
    return null;
  }
}

/** Convert an S3 location (s3://bucket/key) to an HTTPS URL base. */
function s3LocationToHttps(location) {
  const m = location.match(/^s3:\/\/([^/]+)\/(.+)/);
  if (!m) return null;
  const [, bucket, key] = m;
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

/**
 * Fetch the first ReferenceTime value from each camera's metadata.csv via
 * HTTP Range request (reads only the first ~200 bytes — header + 1 data row).
 *
 * Returns an array of { camera, refTime } objects for cameras that exist.
 */
async function loadCameraSync(rawBase, signal) {
  const results = await Promise.all(CAMERAS.map(async (camera) => {
    const url = `${rawBase}/behavior-videos/${camera}/metadata.csv`;
    try {
      const resp = await fetch(url, {
        headers: { Range: 'bytes=0-299' },
        signal,
      });
      if (!resp.ok) return null;
      const text = await resp.text();
      const lines = text.split(/\r?\n/);
      // lines[0] = header, lines[1] = first data row
      if (lines.length < 2) return null;
      const refTime = parseFloat(lines[1].split(',')[0]);
      if (!Number.isFinite(refTime)) return null;
      return { camera, refTime };
    } catch {
      return null;
    }
  }));
  return results.filter(Boolean);
}

/**
 * Mount the behavior-camera videos behind the password gate.
 *
 * The actual <video> elements (and their network requests) are only created
 * once the gate is unlocked, so the videos stay hidden until then. When built,
 * the resulting video infos are wired back into the animation for sync.
 *
 * @param {HTMLElement} root - Player root (for the speed-warning element).
 * @param {object} animation - The VrfAnimation instance to attach videos to.
 * @param {HTMLElement} videosEl - The #vrf-videos wrapper.
 * @param {HTMLElement} videosRow - The #vrf-videos-row mount point.
 * @param {string} rawBase - HTTPS base URL for the raw asset.
 * @param {object[]} cameraSyncs - Per-camera ReferenceTime sync info.
 * @param {number} t0Harp - Harp clock at session t=0.
 */
function mountGatedVideos(root, animation, videosEl, videosRow, rawBase, cameraSyncs, t0Harp) {
  videosRow.innerHTML = '';
  videosRow.appendChild(withVideoGate(() => {
    const panel = document.createElement('div');
    panel.className = 'vrf-videos-panel';
    const videos = buildVideoPanel(panel, rawBase, cameraSyncs, t0Harp);
    animation.videos = videos;
    // Show speed warning if already at >1× when videos become available.
    const speedWarningEl = root.querySelector('#vrf-videos-speed-warning');
    if (speedWarningEl) speedWarningEl.hidden = animation.speed === 1;
    return panel;
  }));
  videosEl.hidden = false;
}

/**
 * Build the video panel: one <video> per available camera.
 * Returns array of { camera, video, offsetS } where offsetS is the number of
 * seconds into the video that corresponds to session t=0.
 */
function buildVideoPanel(container, rawBase, cameraSyncs, t0Harp) {
  const videoInfos = [];
  for (const { camera, refTime } of cameraSyncs) {
    const videoUrl = `${rawBase}/behavior-videos/${camera}/video.mp4`;
    // offsetS: how far into the video file we are when session t=0
    // t0Harp is the Harp clock at session t=0; refTime is the Harp clock
    // at the first video frame.
    const offsetS = t0Harp - refTime;

    const wrap = document.createElement('div');
    wrap.className = 'vrf-video-wrap';

    const label = document.createElement('div');
    label.className = 'vrf-video-label';
    label.textContent = camera.replace('Camera', '');
    wrap.appendChild(label);

    const vid = document.createElement('video');
    vid.src = videoUrl;
    vid.muted = true;
    vid.preload = 'metadata';
    vid.playsInline = true;
    vid.className = 'vrf-video';
    wrap.appendChild(vid);

    container.appendChild(wrap);
    videoInfos.push({ camera, video: vid, offsetS });
  }
  return videoInfos;
}

async function fetchSessionList(coord) {
  const result = await coord.query(`
    SELECT name, subject_id, acquisition_start_time, code_ocean, location
    FROM asset_basics
    WHERE acquisition_type = 'AindVrForaging'
      AND data_level = 'derived'
      AND project_name = '${PROJECT_NAME.replace(/'/g, "''")}'
      AND list_contains(modalities, 'behavior')
    ORDER BY acquisition_start_time DESC
  `);
  return arrowTableToRows(result);
}

function updateLinks(linksEl, row) {
  if (!row) { linksEl.hidden = true; return; }

  const setLink = (id, href) => {
    const el = linksEl.querySelector(`#${id}`);
    if (!el) return;
    if (href) {
      el.href = href;
      el.hidden = false;
    } else {
      el.removeAttribute('href');
      el.hidden = true;
    }
  };

  setLink('vrf-link-subject', row.subject_id ? `/subject?subject_id=${encodeURIComponent(row.subject_id)}` : null);
  setLink('vrf-link-co',      buildCoLink(row.code_ocean));
  setLink('vrf-link-meta',    buildMetadataLink(row.name));
  setLink('vrf-link-qc',      buildQcLink(row.name));
  setLink('vrf-link-s3',      buildS3ConsoleUrl(row.location));

  linksEl.hidden = false;
}



// ---------------------------------------------------------------------------
// Wire VrfAnimation + transport controls into the DOM
// ---------------------------------------------------------------------------

function wireAnimation(root, sites, sprites, traces, _unused) {
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
  const speedSlider   = root.querySelector('#vrf-speed');
  const speedLabel    = root.querySelector('#vrf-speed-label');
  const speedWarning  = root.querySelector('#vrf-videos-speed-warning');

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
  const updateSpeed = () => {
    const v = SPEED_STEPS[Number(speedSlider.value)] ?? 10;
    speedLabel.textContent = `${v}×`;
    anim.setSpeed(v);
    const videosAvailable = v === 1 && anim.videos?.length > 0;
    if (speedWarning) speedWarning.hidden = v === 1 || !anim.videos?.length;
    if (anim.videos?.length) {
      if (v === 1) {
        // Re-sync video position; let play state follow the animation.
        syncVideos(anim.videos, anim.t, false);
        if (anim.playing) playVideos(anim.videos, anim.t);
      } else {
        pauseVideos(anim.videos);
      }
    }
  };
  speedSlider.oninput = updateSpeed;

  // Keep play-button label in sync when animation auto-pauses at end.
  const origLoop = anim._loop.bind(anim);
  anim._loop = function (ts) {
    origLoop(ts);
    if (!anim.playing) playBtn.textContent = '▶';
  };

  // ---- Video sync ---------------------------------------------------------
  // anim.videos is set asynchronously after camera CSV headers are fetched.
  // null = no videos yet; [] = no cameras found.
  anim.videos = null;

  const videosActive = () => anim.videos?.length > 0 && anim.speed === 1;

  const origOnFrame = anim.onFrame;
  anim.onFrame = (t, site) => {
    origOnFrame?.(t, site);
    if (videosActive()) syncVideos(anim.videos, t, anim.playing);
  };

  const origSeekTo = anim.seekTo.bind(anim);
  anim.seekTo = function (t) {
    origSeekTo(t);
    if (videosActive()) syncVideos(anim.videos, t, false);
  };

  const origPlay = anim.play.bind(anim);
  anim.play = function () {
    origPlay();
    if (videosActive()) playVideos(anim.videos, anim.t);
  };

  const origPause = anim.pause.bind(anim);
  anim.pause = function () {
    origPause();
    pauseVideos(anim.videos);
  };

  return anim;
}

// ---------------------------------------------------------------------------
// Video sync helpers
// ---------------------------------------------------------------------------

const VIDEO_SEEK_THRESHOLD_S = 0.5; // only hard-seek if we're this far off

function videoTargetTime(info, sessionT) {
  return info.offsetS + sessionT;
}

function syncVideos(videos, sessionT, playing) {
  if (!videos?.length) return;
  for (const info of videos) {
    const target = videoTargetTime(info, sessionT);
    if (target < 0 || target > (info.video.duration || Infinity)) continue;
    if (!playing) {
      // When paused/scrubbing, hard-seek so the frame updates.
      info.video.currentTime = target;
    } else {
      // While playing, only hard-seek if drift exceeds threshold (avoids
      // constant interruption from tiny float imprecision).
      const drift = Math.abs(info.video.currentTime - target);
      if (drift > VIDEO_SEEK_THRESHOLD_S) {
        info.video.currentTime = target;
      }
    }
  }
}

function playVideos(videos, sessionT) {
  if (!videos?.length) return;
  for (const info of videos) {
    const target = videoTargetTime(info, sessionT);
    if (target < 0 || target > (info.video.duration || Infinity)) continue;
    info.video.currentTime = target;
    info.video.play().catch(() => {});
  }
}

function pauseVideos(videos) {
  if (!videos?.length) return;
  for (const { video } of videos) video.pause();
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

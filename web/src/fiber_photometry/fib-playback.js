/**
 * fiber_photometry/fib-playback.js — Fiber trace viewer and PSTH widget
 * for the session playback panel.
 *
 * Appended below the platform-specific behavior player whenever an acquisition
 * has corresponding fiber photometry data in the `platform_fib_traces` table.
 *
 * Fiber trace schema (per-subject Parquet at bdc-v0.36):
 *   subject_id, asset_name, fiber (int), channel (G/Iso/R),
 *   timestamp (hardware-clock seconds), "dff-bright_mc-iso-IRLS" (float32)
 *
 * Timing alignment for PSTH:
 *   session_start_hw = MIN(goCue_start_time_raw) from the trials table
 *   event_hw_time    = session_start_hw + <event>_time_in_session
 *   t_rel            = fiber.timestamp − event_hw_time
 */

import { DATA_CACHE_PREFIX } from '../constants.js';
import { queryRows } from '../lib/arrow.js';
import * as Plot from '@observablehq/plot';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIB_VERSION = 'bdc-v0.36';
const PSTH_PRE    = -2;   // seconds before event
const PSTH_POST   =  5;   // seconds after event
const PSTH_BINS   = 100;
const BIN_WIDTH   = (PSTH_POST - PSTH_PRE) / PSTH_BINS;

// Map display label → trials column name
const PSTH_EVENTS = {
  'Go cue':      'goCue_start_time_in_session',
  'Trial start': 'bonsai_start_time_in_session',
  'Reward':      'reward_time_in_session',
  'Choice':      'choice_time_in_session',
};

// Channel → colour mapping for trace plot
const CHANNEL_COLORS = { G: '#22c55e', Iso: '#a855f7', R: '#ef4444' };

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/** Escape single quotes for SQL string literals (trusted-source data). */
function esc(s) { return String(s).replace(/'/g, "''"); }

function fibUrl(subjectId) {
  return `${DATA_CACHE_PREFIX}/${FIB_VERSION}/platform_fib_traces/subject_id=${esc(subjectId)}/data.pqt`;
}

function trialsUrl(subjectId) {
  return `${DATA_CACHE_PREFIX}/${FIB_VERSION}/platform_dynamic_foraging_trials/subject_id=${esc(subjectId)}/data.pqt`;
}

/** Extract YYYY-MM-DD from an asset name like "behavior_777021_2025-07-21_…" */
function sessionDate(rawAssetName) {
  const parts = rawAssetName.split('_');
  for (const p of parts) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fiber trace plot
// ---------------------------------------------------------------------------

async function loadTraces(coord, subjectId, rawAssetName) {
  const url    = fibUrl(subjectId);
  const prefix = esc(rawAssetName);

  // Downsample to ≤1500 points per (fiber, channel) using window functions.
  const sql = `
    WITH base AS (
      SELECT fiber, channel, timestamp, "dff-bright_mc-iso-IRLS" AS v,
             ROW_NUMBER() OVER (PARTITION BY fiber, channel ORDER BY timestamp) AS rn,
             COUNT(*)     OVER (PARTITION BY fiber, channel)                   AS cnt
      FROM read_parquet('${url}')
      WHERE asset_name LIKE '${prefix}%'
    ),
    t0 AS (SELECT MIN(timestamp) AS min_t FROM base)
    SELECT CAST(base.fiber AS VARCHAR) AS fiber, base.channel,
           CAST(base.timestamp - t0.min_t AS FLOAT) AS t,
           CAST(base.v AS FLOAT) AS v
    FROM base, t0
    WHERE base.rn % GREATEST(1, CAST(base.cnt / 1500 AS INT)) = 0
    ORDER BY base.fiber, base.channel, base.t
  `;
  return queryRows(coord, sql);
}

function buildTracePlot(rows) {
  const fibers   = [...new Set(rows.map(r => r.fiber))].sort();
  const channels = [...new Set(rows.map(r => r.channel))].sort();

  return Plot.plot({
    height: 140 * fibers.length + 40,
    width:  700,
    marginLeft: 60,
    style:  { background: 'transparent', fontFamily: 'inherit', fontSize: 11 },
    color: {
      domain: channels,
      range:  channels.map(c => CHANNEL_COLORS[c] ?? '#888'),
      legend: true,
    },
    fy: { label: 'Fiber', padding: 0.1 },
    x:  { label: 'Session time (s)' },
    y:  { label: 'ΔF/F', grid: true },
    marks: [
      Plot.lineY(rows, {
        x: 't', y: 'v', stroke: 'channel', fy: 'fiber',
        strokeWidth: 0.9, strokeOpacity: 0.85,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// PSTH
// ---------------------------------------------------------------------------

async function loadPsthData(coord, subjectId, rawAssetName, eventCol, fiberIdx, channelName) {
  const url    = fibUrl(subjectId);
  const tUrl   = trialsUrl(subjectId);
  const date   = sessionDate(rawAssetName);
  if (!date) return null;

  const prefix   = esc(rawAssetName);
  const safeDate = esc(date);
  const safeChan = esc(channelName);

  // Align fiber timestamps to the trial event time using goCue_start_time_raw
  // as the hardware-clock session reference:
  //   event_hw_time = MIN(goCue_start_time_raw) + <eventCol>_in_session
  const sql = `
    WITH ref AS (
      SELECT MIN(goCue_start_time_raw) AS t_ref
      FROM read_parquet('${tUrl}')
      WHERE session_date = '${safeDate}'
    ),
    events AS (
      SELECT CAST(trial AS INT) AS trial,
             (SELECT t_ref FROM ref) + tr.${eventCol} AS ev_t
      FROM read_parquet('${tUrl}') tr
      WHERE tr.session_date = '${safeDate}'
        AND tr.${eventCol} IS NOT NULL
        AND NOT isnan(CAST(tr.${eventCol} AS DOUBLE))
    ),
    fib AS (
      SELECT timestamp, "dff-bright_mc-iso-IRLS" AS v
      FROM read_parquet('${url}')
      WHERE asset_name LIKE '${prefix}%'
        AND fiber  = ${Number(fiberIdx)}
        AND channel = '${safeChan}'
    )
    SELECT e.trial,
           CAST(f.timestamp - e.ev_t AS FLOAT) AS t_rel,
           CAST(f.v AS FLOAT) AS v
    FROM fib f
    JOIN events e ON f.timestamp BETWEEN e.ev_t + ${PSTH_PRE} AND e.ev_t + ${PSTH_POST}
    ORDER BY e.trial, t_rel
  `;
  return queryRows(coord, sql);
}

/** Bin raw PSTH rows into a trial × time grid for the raster heatmap. */
function buildRasterData(rawRows) {
  const cellMap = new Map();
  for (const row of rawRows) {
    const binIdx = Math.floor((row.t_rel - PSTH_PRE) / BIN_WIDTH);
    if (binIdx < 0 || binIdx >= PSTH_BINS) continue;
    const key = `${row.trial}_${binIdx}`;
    let c = cellMap.get(key);
    if (!c) { c = { trial: row.trial, binIdx, sum: 0, count: 0 }; cellMap.set(key, c); }
    c.sum += row.v;
    c.count++;
  }
  return Array.from(cellMap.values()).map(c => ({
    trial: c.trial,
    t:     PSTH_PRE + (c.binIdx + 0.5) * BIN_WIDTH,
    v:     c.sum / c.count,
  }));
}

/** Bin raw PSTH rows into mean ± SEM per time bin across all trials. */
function buildMeanData(rawRows) {
  const bins = Array.from({ length: PSTH_BINS }, () => ({ vals: [] }));
  for (const row of rawRows) {
    const i = Math.floor((row.t_rel - PSTH_PRE) / BIN_WIDTH);
    if (i >= 0 && i < PSTH_BINS) bins[i].vals.push(row.v);
  }
  return bins.map((b, i) => {
    if (!b.vals.length) return null;
    const t    = PSTH_PRE + (i + 0.5) * BIN_WIDTH;
    const mean = b.vals.reduce((s, v) => s + v, 0) / b.vals.length;
    const variance = b.vals.reduce((s, v) => s + (v - mean) ** 2, 0) / b.vals.length;
    const sem  = Math.sqrt(variance / b.vals.length);
    return { t, mean, lo: mean - sem, hi: mean + sem };
  }).filter(Boolean);
}

function buildPsthPlots(rawRows) {
  const rasterData = buildRasterData(rawRows);
  const meanData   = buildMeanData(rawRows);

  // Symmetric diverging colour domain centred on 0
  const absMax = Math.max(...rasterData.map(r => Math.abs(r.v)), 1e-9);

  const raster = Plot.plot({
    height: 220,
    width:  700,
    marginLeft: 60,
    style:  { background: 'transparent', fontFamily: 'inherit', fontSize: 11 },
    x: { domain: [PSTH_PRE, PSTH_POST], label: 'Time (s)' },
    y: { label: 'Trial', grid: false },
    color: {
      scheme: 'RdYlGn',
      domain: [-absMax, 0, absMax],
      label:  'ΔF/F',
      legend: true,
    },
    marks: [
      Plot.rect(rasterData, {
        x1: d => d.t - BIN_WIDTH / 2,
        x2: d => d.t + BIN_WIDTH / 2,
        y1: d => d.trial - 0.5,
        y2: d => d.trial + 0.5,
        fill: 'v',
      }),
      Plot.ruleX([0], { stroke: '#888', strokeDasharray: '3,3' }),
    ],
  });

  const mean = Plot.plot({
    height: 160,
    width:  700,
    marginLeft: 60,
    style:  { background: 'transparent', fontFamily: 'inherit', fontSize: 11 },
    x: { domain: [PSTH_PRE, PSTH_POST], label: 'Time rel. event (s)' },
    y: { label: 'Mean ΔF/F', grid: true },
    marks: [
      Plot.areaY(meanData, {
        x: 't', y1: 'lo', y2: 'hi',
        fill: '#22c55e', fillOpacity: 0.25,
      }),
      Plot.lineY(meanData, {
        x: 't', y: 'mean',
        stroke: '#22c55e', strokeWidth: 2,
      }),
      Plot.ruleX([0], { stroke: '#888', strokeDasharray: '3,3' }),
      Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.4 }),
    ],
  });

  const container = document.createElement('div');
  container.className = 'psth-plots';
  container.appendChild(raster);
  container.appendChild(mean);
  return container;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Create the fiber playback section for a session.  Returns an HTMLElement
 * immediately; async data loading fills it in (or removes it if no data).
 *
 * @param {object} coord        - DuckDB coordinator
 * @param {string} subjectId    - Subject ID (numeric string)
 * @param {string} rawAssetName - Raw acquisition asset name (no _processed_ suffix)
 * @returns {HTMLElement}
 */
export function createFibPlayback(coord, subjectId, rawAssetName) {
  const section = document.createElement('section');
  section.className = 'fib-playback-section';
  section.innerHTML = '<p class="fib-loading">Checking for fiber data\u2026</p>';

  (async () => {
    const url    = fibUrl(subjectId);
    const prefix = esc(rawAssetName);

    // Quick existence check — catches 404 (no parquet for this subject) too
    let hasData = false;
    try {
      const rows = await queryRows(coord,
        `SELECT 1 AS n FROM read_parquet('${url}') WHERE asset_name LIKE '${prefix}%' LIMIT 1`
      );
      hasData = rows.length > 0;
    } catch { /* no fiber parquet for this subject */ }

    if (!hasData) { section.remove(); return; }

    section.innerHTML = `
      <h4 class="fib-section-heading">Fiber Photometry Traces</h4>
      <div class="fib-traces-container fib-loading-inner">Loading traces\u2026</div>
      <h4 class="fib-section-heading">PSTH</h4>
      <div class="fib-psth-container">
        <p class="fib-loading">Loading\u2026</p>
      </div>
    `;

    const tracesEl = section.querySelector('.fib-traces-container');
    const psthEl   = section.querySelector('.fib-psth-container');

    // ---- Traces ----
    try {
      const rows = await loadTraces(coord, subjectId, rawAssetName);
      tracesEl.innerHTML = '';
      if (rows.length > 0) tracesEl.appendChild(buildTracePlot(rows));
      else tracesEl.textContent = 'No trace data available.';
    } catch (err) {
      console.error('[fib-playback] trace error', err);
      tracesEl.textContent = 'Error loading fiber traces.';
    }

    // ---- PSTH: check if trial data exists ----
    const date = sessionDate(rawAssetName);
    let hasTrials = false;
    if (date) {
      try {
        const tUrl = trialsUrl(subjectId);
        const rows = await queryRows(coord,
          `SELECT 1 FROM read_parquet('${tUrl}') WHERE session_date = '${esc(date)}' LIMIT 1`
        );
        hasTrials = rows.length > 0;
      } catch { /* no trials parquet */ }
    }

    if (!hasTrials) {
      psthEl.innerHTML = '<p class="fib-no-data">No trial data available for PSTH.</p>';
      return;
    }

    // Get unique fiber / channel combinations
    let combos = [];
    try {
      combos = await queryRows(coord,
        `SELECT DISTINCT CAST(fiber AS INT) AS fiber, channel
         FROM read_parquet('${url}')
         WHERE asset_name LIKE '${prefix}%'
         ORDER BY fiber, channel`
      );
    } catch (err) {
      psthEl.innerHTML = '<p class="fib-no-data">Could not load fiber channel list.</p>';
      return;
    }

    const fibers   = [...new Set(combos.map(r => r.fiber))].sort((a, b) => a - b);
    const channels = [...new Set(combos.map(r => r.channel))].sort();
    const defChan  = channels.includes('G') ? 'G' : channels[0];

    psthEl.innerHTML = `
      <div class="psth-controls">
        <label>Event
          <select class="psth-event-sel">
            ${Object.keys(PSTH_EVENTS).map(e => `<option>${e}</option>`).join('')}
          </select>
        </label>
        <label>Fiber
          <select class="psth-fiber-sel">
            ${fibers.map(f => `<option value="${f}">${f}</option>`).join('')}
          </select>
        </label>
        <label>Channel
          <select class="psth-channel-sel">
            ${channels.map(c => `<option${c === defChan ? ' selected' : ''}>${c}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="psth-plot-area"><p class="fib-loading">Loading\u2026</p></div>
    `;

    const plotArea  = psthEl.querySelector('.psth-plot-area');
    const eventSel  = psthEl.querySelector('.psth-event-sel');
    const fiberSel  = psthEl.querySelector('.psth-fiber-sel');
    const channelSel = psthEl.querySelector('.psth-channel-sel');

    async function refreshPsth() {
      plotArea.innerHTML = '<p class="fib-loading">Loading PSTH\u2026</p>';
      const eventCol   = PSTH_EVENTS[eventSel.value];
      const fiberIdx   = Number(fiberSel.value);
      const channelName = channelSel.value;
      try {
        const rows = await loadPsthData(coord, subjectId, rawAssetName, eventCol, fiberIdx, channelName);
        if (!rows || !rows.length) { plotArea.textContent = 'No data for this selection.'; return; }
        plotArea.innerHTML = '';
        plotArea.appendChild(buildPsthPlots(rows));
      } catch (err) {
        console.error('[fib-playback] psth error', err);
        plotArea.textContent = 'Error loading PSTH data.';
      }
    }

    eventSel.addEventListener('change', refreshPsth);
    fiberSel.addEventListener('change', refreshPsth);
    channelSel.addEventListener('change', refreshPsth);
    await refreshPsth();
  })();

  return section;
}

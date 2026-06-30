/**
 * fiber_photometry/fib-playback.js — Fiber trace viewer and PSTH widget
 * for the session playback panel.
 *
 * Appended below the platform-specific behavior player whenever an acquisition
 * has corresponding fiber photometry data in the `platform_fib_traces` table.
 *
 * Fiber trace schema (per-subject Parquet at bdc-v0.37, split into
 * data_NNNN.pqt shards under each subject_id partition):
 *   subject_id, asset_name, fiber (int), channel (G/Iso/R),
 *   timestamp (hardware-clock seconds), "dff-bright_mc-iso-IRLS" (float32)
 *
 * Timing alignment for PSTH:
 *   session_start_hw = MIN(goCue_start_time_raw) from the trials table
 *   event_hw_time    = session_start_hw + <event>_time_in_session
 *   t_rel            = fiber.timestamp − event_hw_time
 */

import { DATA_CACHE_PREFIX, S3_BUCKET, S3_REGION } from '../constants.js';
import { queryRows } from '../lib/arrow.js';
import * as Plot from '@observablehq/plot';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIB_VERSION = 'bdc-v0.37';
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

// Per-subject fiber-trace shards are stored as multiple data_NNNN.pqt files
// under each subject_id partition. DuckDB-WASM does not expand `*` globs over
// virtual-hosted S3 HTTPS URLs, so the shard list is resolved explicitly via
// an S3 ListObjectsV2 request and passed to read_parquet([...]) as an array.
const _fibFilesCache = new Map();

/** List the per-subject fiber-trace parquet shards via S3 ListObjectsV2. */
async function fibFiles(subjectId) {
  const key = String(subjectId);
  if (_fibFilesCache.has(key)) return _fibFilesCache.get(key);
  const p = (async () => {
    const prefix = `data-asset-cache/${FIB_VERSION}/platform_fib_traces/subject_id=${key}/`;
    const listUrl =
      `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/` +
      `?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    let resp;
    try { resp = await fetch(listUrl); } catch { return []; }
    if (!resp.ok) return [];
    const xml = await resp.text();
    const re = /<Key>([^<]+\.pqt)<\/Key>/g;
    const urls = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      urls.push(`https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${m[1]}`);
    }
    return urls;
  })();
  _fibFilesCache.set(key, p);
  return p;
}

/** Build the read_parquet source argument (SQL array literal) from file URLs. */
function fibSource(urls) {
  return `[${urls.map((u) => `'${esc(u)}'`).join(', ')}]`;
}

function trialsUrl(subjectId) {
  return `${DATA_CACHE_PREFIX}/${FIB_VERSION}/platform_dynamic_foraging_trials/subject_id=${esc(subjectId)}/data.pqt`;
}

function fibMetaUrl() {
  return `${DATA_CACHE_PREFIX}/${FIB_VERSION}/platform_fib.pqt`;
}

// Map platform_fib channel suffix → trace-table channel code.
const CH_SUFFIX = { green: 'G', isosbestic: 'Iso', red: 'R' };
// Fixed channel display order.
const CHANNEL_ORDER = ['G', 'Iso', 'R'];

/**
 * Load per-fiber targeted structure and per-channel intended measurement from
 * platform_fib.pqt for the given asset.
 *
 * @returns {Promise<Map<number, {targetedStructure: string, channels: object}>>}
 */
async function loadFiberMeta(coord, rawAssetName) {
  const prefix = esc(rawAssetName);
  const url    = fibMetaUrl();
  let rows = [];
  try {
    rows = await queryRows(coord,
      `SELECT DISTINCT fiber, channel, targeted_structure, intended_measurement
       FROM read_parquet('${url}')
       WHERE asset_name LIKE '${prefix}%'`
    );
  } catch { return new Map(); }

  const map = new Map();
  for (const r of rows) {
    const fm = String(r.fiber).match(/(\d+)/);
    if (!fm) continue;
    const idx = Number(fm[1]);
    if (!map.has(idx)) map.set(idx, { targetedStructure: '', channels: {} });
    const entry = map.get(idx);
    const ts = r.targeted_structure;
    if (ts && ts !== 'missing' && !entry.targetedStructure) entry.targetedStructure = ts;
    const cm = String(r.channel).match(/_(\w+)$/);
    const ch = cm ? CH_SUFFIX[cm[1].toLowerCase()] : null;
    if (ch) entry.channels[ch] = r.intended_measurement;
  }
  return map;
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

async function loadTraces(coord, fibSrc, rawAssetName, fiberIdx, tRef = null) {
  const prefix = esc(rawAssetName);

  // Origin: when a behavior session reference (first goCue, hardware clock) is
  // available, align traces to behavior session-time so they share the same
  // axis as the trial events; otherwise fall back to the fiber's own start.
  const originExpr = tRef != null ? `${Number(tRef)}` : `(SELECT MIN(timestamp) FROM base)`;

  // Downsample to ≤1500 points per channel for the selected fiber.
  const sql = `
    WITH base AS (
      SELECT channel, timestamp, "dff-bright_mc-iso-IRLS" AS v,
             ROW_NUMBER() OVER (PARTITION BY channel ORDER BY timestamp) AS rn,
             COUNT(*)     OVER (PARTITION BY channel)                   AS cnt
      FROM read_parquet(${fibSrc})
      WHERE asset_name LIKE '${prefix}%'
        AND fiber = ${Number(fiberIdx)}
    ),
    t0 AS (SELECT ${originExpr} AS min_t)
    SELECT base.channel,
           CAST(base.timestamp - t0.min_t AS FLOAT) AS t,
           CAST(base.v AS FLOAT) AS v
    FROM base, t0
    WHERE base.rn % GREATEST(1, CAST(base.cnt / 1500 AS INT)) = 0
    ORDER BY base.channel, base.timestamp
  `;
  return queryRows(coord, sql);
}

/** First-goCue hardware time, used as the shared behavior session-time origin. */
async function loadSessionRef(coord, subjectId, rawAssetName) {
  const date = sessionDate(rawAssetName);
  if (!date) return null;
  const tUrl = trialsUrl(subjectId);
  try {
    const rows = await queryRows(coord,
      `SELECT MIN(goCue_start_time_raw) AS t_ref
       FROM read_parquet('${tUrl}')
       WHERE session_date = '${esc(date)}'`
    );
    const t = rows[0]?.t_ref;
    return t == null ? null : Number(t);
  } catch { return null; }
}

/**
 * Event times (one per trial) in behavior session-time, i.e. directly the
 * `<event>_in_session` column, for drawing vertical rules over the traces.
 */
async function loadEventTimes(coord, subjectId, rawAssetName, eventCol) {
  const tUrl = trialsUrl(subjectId);
  const date = sessionDate(rawAssetName);
  if (!date) return [];
  const safeDate = esc(date);

  const sql = `
    SELECT CAST(tr.${eventCol} AS FLOAT) AS t
    FROM read_parquet('${tUrl}') tr
    WHERE tr.session_date = '${safeDate}'
      AND tr.${eventCol} IS NOT NULL
      AND NOT isnan(CAST(tr.${eventCol} AS DOUBLE))
  `;
  const rows = await queryRows(coord, sql);
  return rows.map((r) => r.t);
}

function buildTracePlot(rows, eventTimes = [], width = 700) {
  const channels = CHANNEL_ORDER.filter((c) => rows.some((r) => r.channel === c));

  return Plot.plot({
    height: 220,
    width:  Math.max(360, width),
    marginLeft: 60,
    style:  { background: 'transparent', fontFamily: 'inherit', fontSize: 11 },
    color: {
      domain: channels,
      range:  channels.map(c => CHANNEL_COLORS[c] ?? '#888'),
      legend: true,
    },
    x:  { label: 'Session time (s)' },
    y:  { label: 'ΔF/F', grid: true },
    marks: [
      Plot.ruleX(eventTimes, { stroke: '#888', strokeOpacity: 0.35, strokeWidth: 0.6 }),
      Plot.lineY(rows, {
        x: 't', y: 'v', stroke: 'channel',
        strokeWidth: 0.9, strokeOpacity: 0.85,
      }),
    ],
  });
}

// ---------------------------------------------------------------------------
// PSTH
// ---------------------------------------------------------------------------

async function loadPsthData(coord, fibSrc, subjectId, rawAssetName, eventCol, fiberIdx) {
  const tUrl   = trialsUrl(subjectId);
  const date   = sessionDate(rawAssetName);
  if (!date) return null;

  const prefix   = esc(rawAssetName);
  const safeDate = esc(date);

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
      SELECT timestamp, channel, "dff-bright_mc-iso-IRLS" AS v
      FROM read_parquet(${fibSrc})
      WHERE asset_name LIKE '${prefix}%'
        AND fiber  = ${Number(fiberIdx)}
    )
    SELECT e.trial, f.channel,
           CAST(f.timestamp - e.ev_t AS FLOAT) AS t_rel,
           CAST(f.v AS FLOAT) AS v
    FROM fib f
    JOIN events e ON f.timestamp BETWEEN e.ev_t + ${PSTH_PRE} AND e.ev_t + ${PSTH_POST}
    ORDER BY f.channel, e.trial, t_rel
  `;
  return queryRows(coord, sql);
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

function buildPsthPlots(rawRows, meta, width = 420) {
  const channels = CHANNEL_ORDER.filter(
    (c) => rawRows.some((r) => r.channel === c),
  );

  const allMean = [];
  for (const ch of channels) {
    const md = buildMeanData(rawRows.filter((r) => r.channel === ch));
    for (const d of md) allMean.push({ ...d, channel: ch });
  }

  const struct = meta?.targetedStructure || '?';
  const legendData = channels.map((ch, i) => {
    const meas = meta?.channels?.[ch];
    const measLabel = meas && meas !== 'missing' ? meas : 'none';
    return { channel: ch, label: `${measLabel}/${struct}`, i };
  });

  const plot = Plot.plot({
    height: 240,
    width:  Math.max(300, width),
    marginLeft: 60,
    marginTop: 14,
    marginRight: 14,
    style:  { background: 'transparent', fontFamily: 'inherit', fontSize: 11 },
    x: { domain: [PSTH_PRE, PSTH_POST], label: 'Time rel. event (s)' },
    y: { label: 'Mean ΔF/F', grid: true },
    color: { domain: channels, range: channels.map((c) => CHANNEL_COLORS[c] ?? '#888') },
    marks: [
      Plot.areaY(allMean, {
        x: 't', y1: 'lo', y2: 'hi',
        fill: 'channel', fillOpacity: 0.15,
      }),
      Plot.lineY(allMean, {
        x: 't', y: 'mean',
        stroke: 'channel', strokeWidth: 2,
      }),
      Plot.ruleX([0], { stroke: '#888', strokeDasharray: '3,3' }),
      Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.4 }),
      ...legendData.map((d) => Plot.text([d.label], {
        frameAnchor: 'top-right',
        text: (x) => x,
        fill: CHANNEL_COLORS[d.channel] ?? '#888',
        textAnchor: 'end',
        fontWeight: 600,
        dx: -4,
        dy: 6 + d.i * 14,
      })),
    ],
  });

  const container = document.createElement('div');
  container.className = 'psth-plots';
  container.appendChild(plot);
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
    const urls   = await fibFiles(subjectId);
    const prefix = esc(rawAssetName);

    if (urls.length === 0) { section.remove(); return; }
    const fibSrc = fibSource(urls);

    // Quick existence check — confirms this asset has rows in the shards
    let hasData = false;
    try {
      const rows = await queryRows(coord,
        `SELECT 1 AS n FROM read_parquet(${fibSrc}) WHERE asset_name LIKE '${prefix}%' LIMIT 1`
      );
      hasData = rows.length > 0;
    } catch { /* no fiber data for this subject */ }

    if (!hasData) { section.remove(); return; }

    section.innerHTML = `
      <div class="fib-row">
        <div class="fib-psth-col">
          <h4 class="fib-section-heading">PSTH</h4>
          <div class="fib-psth-container">
            <p class="fib-loading">Loading\u2026</p>
          </div>
        </div>
        <div class="fib-traces-col">
          <h4 class="fib-section-heading">Fiber Photometry Traces</h4>
          <div class="fib-traces-container fib-loading-inner">Loading traces\u2026</div>
        </div>
      </div>
    `;

    const tracesEl = section.querySelector('.fib-traces-container');
    const psthEl   = section.querySelector('.fib-psth-container');

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
      try {
        const firstFiber = (await queryRows(coord,
          `SELECT MIN(CAST(fiber AS INT)) AS f FROM read_parquet(${fibSrc}) WHERE asset_name LIKE '${prefix}%'`
        ))[0]?.f ?? 0;
        const rows = await loadTraces(coord, fibSrc, rawAssetName, firstFiber);
        tracesEl.innerHTML = '';
        if (rows.length > 0) tracesEl.appendChild(buildTracePlot(rows, [], tracesEl.clientWidth));
        else tracesEl.textContent = 'No trace data available.';
      } catch (err) {
        console.error('[fib-playback] trace error', err);
        tracesEl.textContent = 'Error loading fiber traces.';
      }
      return;
    }

    // Get unique fibers and per-fiber/channel metadata
    let combos = [];
    try {
      combos = await queryRows(coord,
        `SELECT DISTINCT CAST(fiber AS INT) AS fiber
         FROM read_parquet(${fibSrc})
         WHERE asset_name LIKE '${prefix}%'
         ORDER BY fiber`
      );
    } catch (err) {
      psthEl.innerHTML = '<p class="fib-no-data">Could not load fiber list.</p>';
      return;
    }

    const fibers   = [...new Set(combos.map(r => r.fiber))].sort((a, b) => a - b);
    const fiberMeta = await loadFiberMeta(coord, rawAssetName);
    const tRef      = await loadSessionRef(coord, subjectId, rawAssetName);

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
      </div>
      <div class="psth-plot-area"><p class="fib-loading">Loading\u2026</p></div>
    `;

    const plotArea  = psthEl.querySelector('.psth-plot-area');
    const eventSel  = psthEl.querySelector('.psth-event-sel');
    const fiberSel  = psthEl.querySelector('.psth-fiber-sel');

    async function refreshTraces(eventCol, fiberIdx) {
      tracesEl.innerHTML = '<p class="fib-loading">Loading traces\u2026</p>';
      try {
        const [rows, eventTimes] = await Promise.all([
          loadTraces(coord, fibSrc, rawAssetName, fiberIdx, tRef),
          loadEventTimes(coord, subjectId, rawAssetName, eventCol),
        ]);
        tracesEl.innerHTML = '';
        if (rows.length > 0) {
          tracesEl.appendChild(buildTracePlot(rows, eventTimes, tracesEl.clientWidth));
        } else {
          tracesEl.textContent = 'No trace data available.';
        }
      } catch (err) {
        console.error('[fib-playback] trace error', err);
        tracesEl.textContent = 'Error loading fiber traces.';
      }
    }

    async function refreshPsth() {
      plotArea.innerHTML = '<p class="fib-loading">Loading PSTH\u2026</p>';
      const eventCol   = PSTH_EVENTS[eventSel.value];
      const fiberIdx   = Number(fiberSel.value);
      refreshTraces(eventCol, fiberIdx);
      try {
        const rows = await loadPsthData(coord, fibSrc, subjectId, rawAssetName, eventCol, fiberIdx);
        if (!rows || !rows.length) { plotArea.textContent = 'No data for this selection.'; return; }
        plotArea.innerHTML = '';
        plotArea.appendChild(buildPsthPlots(rows, fiberMeta.get(fiberIdx), plotArea.clientWidth));
      } catch (err) {
        console.error('[fib-playback] psth error', err);
        plotArea.textContent = 'Error loading PSTH data.';
      }
    }

    eventSel.addEventListener('change', refreshPsth);
    fiberSel.addEventListener('change', refreshPsth);
    await refreshPsth();
  })();

  return section;
}

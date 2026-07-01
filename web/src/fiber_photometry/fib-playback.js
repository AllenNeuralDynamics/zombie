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
import { queryDocDb } from '../lib/docdb.js';
import { ITEM_COLORS } from '../subject/brain-viz.js';
import * as Plot from '@observablehq/plot';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIB_VERSION = 'bdc-v0.37';
const PSTH_PRE    = -2;   // seconds before event
const PSTH_POST   =  5;   // seconds after event
const PSTH_BINS   = 100;
const BIN_WIDTH   = (PSTH_POST - PSTH_PRE) / PSTH_BINS;

// Map display label → trials column name. Ordered by within-trial progression.
const PSTH_EVENTS = {
  'Trial start':    'bonsai_start_time_in_session',
  'Delay start':    'delay_start_time_in_session',
  'Go cue':         'goCue_start_time_in_session',
  'Choice':         'choice_time_in_session',
  'Reward':         'reward_time_in_session',
  'Reward outcome': 'reward_outcome_time_in_session',
  'Trial stop':     'bonsai_stop_time_in_session',
};

// Event selected by default when the panel opens.
const PSTH_DEFAULT_EVENT = 'Go cue';

// Default pre-event baseline window (milliseconds) when baselining is enabled.
const BASELINE_DEFAULT_MS = 200;

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
// Fiber implant surgery (3D inset + per-fiber colours)
// ---------------------------------------------------------------------------

const _surgeryCache = new Map();

/**
 * Fetch the subject's implant surgery from DocDB and return the Surgery
 * sub-record that contains Probe implant procedures, along with the
 * procedures-level coordinate system.
 *
 * @returns {Promise<{surgeryData: object, proceduresCoordSys: object|null}|null>}
 */
async function loadSurgery(subjectId) {
  const key = String(subjectId);
  if (_surgeryCache.has(key)) return _surgeryCache.get(key);
  const p = (async () => {
    let records = [];
    try {
      records = await queryDocDb(
        { 'subject.subject_id': key },
        { projection: { procedures: 1 }, limit: 50 },
      );
    } catch { return null; }
    for (const rec of records) {
      const coordSys = rec.procedures?.coordinate_system ?? null;
      for (const proc of (rec.procedures?.subject_procedures ?? [])) {
        const hasImplant = (proc?.procedures ?? []).some(
          (sp) => sp?.object_type === 'Probe implant' && sp.device_config,
        );
        if (hasImplant) return { surgeryData: proc, proceduresCoordSys: coordSys };
      }
    }
    return null;
  })();
  _surgeryCache.set(key, p);
  return p;
}

/**
 * Build a per-fiber colour/structure map keyed by numeric fiber index.
 * Colours are assigned in the same probe order used by the 3D brain viewer
 * (ITEM_COLORS[i]) so PSTH/trace borders match the implant view.
 *
 * @returns {Map<number, {color: string, structureName: string, structureAcronym: string}>}
 */
function buildFiberColorInfo(surgery) {
  const map = new Map();
  if (!surgery?.surgeryData) return map;
  const probes = (surgery.surgeryData.procedures ?? []).filter(
    (p) => p?.object_type === 'Probe implant' && p.device_config,
  );
  probes.forEach((p, i) => {
    const cfg = p.device_config ?? {};
    const nameMatch = String(cfg.device_name ?? '').match(/(\d+)/);
    const idx = nameMatch ? Number(nameMatch[1]) : i;
    const struct = cfg.primary_targeted_structure ?? {};
    map.set(idx, {
      color: ITEM_COLORS[i % ITEM_COLORS.length],
      structureName: struct.name ?? '',
      structureAcronym: struct.acronym ?? '',
    });
  });
  return map;
}

/** Colour for a fiber, falling back to the palette by ordinal position. */
function fiberColor(fiberInfoMap, idx, order) {
  return fiberInfoMap.get(idx)?.color ?? ITEM_COLORS[order % ITEM_COLORS.length];
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

function buildTracePlot(rows, eventTimes = [], width = 700, opts = {}) {
  const channels = CHANNEL_ORDER.filter((c) => rows.some((r) => r.channel === c));
  const { yDomain = undefined, height = 220, compact = false } = opts;

  return Plot.plot({
    height,
    width:  Math.max(360, width),
    marginLeft: compact ? 46 : 60,
    marginTop: 8,
    marginBottom: compact ? 22 : 30,
    style:  { background: 'transparent', fontFamily: 'inherit', fontSize: compact ? 9 : 11 },
    color: {
      domain: channels,
      range:  channels.map(c => CHANNEL_COLORS[c] ?? '#888'),
      legend: !compact,
    },
    x:  { label: compact ? null : 'Session time (s)' },
    y:  { label: compact ? null : 'ΔF/F', grid: true, ...(yDomain ? { domain: yDomain } : {}) },
    marks: [
      Plot.ruleX(eventTimes, { stroke: '#888', strokeOpacity: 0.35, strokeWidth: 0.6 }),
      Plot.lineY(rows, {
        x: 't', y: 'v', stroke: 'channel',
        strokeWidth: 0.9, strokeOpacity: 0.85,
      }),
    ],
  });
}

/**
 * Build a small trace card for a single fiber, with a coloured left border
 * matching the fiber implant colour and an equal (shared) Y-axis domain.
 */
function buildTraceCard(rows, eventTimes, yDomain, borderColor, area, width) {
  const card = document.createElement('div');
  card.className = 'fib-trace-card';
  card.style.borderColor = borderColor;

  if (area) {
    const label = document.createElement('div');
    label.className = 'fib-trace-label';
    label.style.color = borderColor;
    label.textContent = area;
    card.appendChild(label);
  }

  card.appendChild(buildTracePlot(rows, eventTimes, width, {
    yDomain, height: 130, compact: true,
  }));
  return card;
}

/** Compute a shared [min, max] Y domain across every fiber's trace rows. */
function sharedYDomain(rowsByFiber) {
  let lo = Infinity, hi = -Infinity;
  for (const rows of rowsByFiber.values()) {
    for (const r of rows) {
      if (r.v < lo) lo = r.v;
      if (r.v > hi) hi = r.v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  if (lo === hi) { lo -= 1; hi += 1; }
  return [lo, hi];
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

/**
 * Subtract a per-trial, per-channel baseline (mean ΔF/F over the pre-event
 * window [-baselineSec, 0)) from each sample.  Returns the rows unchanged when
 * baselineSec is not a positive number.
 */
function applyBaseline(rawRows, baselineSec) {
  if (!(baselineSec > 0)) return rawRows;
  const base = new Map(); // "trial|channel" → { sum, n }
  for (const r of rawRows) {
    if (r.t_rel >= -baselineSec && r.t_rel < 0) {
      const k = `${r.trial}|${r.channel}`;
      const e = base.get(k) ?? { sum: 0, n: 0 };
      e.sum += r.v; e.n += 1;
      base.set(k, e);
    }
  }
  return rawRows.map((r) => {
    const e = base.get(`${r.trial}|${r.channel}`);
    const b = e && e.n ? e.sum / e.n : 0;
    return { ...r, v: r.v - b };
  });
}

/**
 * Compute the binned mean±SEM series (one entry per channel/time-bin) for a
 * fiber, optionally baseline-corrected.  Returns { allMean, channels }.
 */
function computePsthSeries(rawRows, baselineSec = 0) {
  const rows = applyBaseline(rawRows, baselineSec);
  const channels = CHANNEL_ORDER.filter((c) => rows.some((r) => r.channel === c));
  const allMean = [];
  for (const ch of channels) {
    const md = buildMeanData(rows.filter((r) => r.channel === ch));
    for (const d of md) allMean.push({ ...d, channel: ch });
  }
  return { allMean, channels };
}

/** Shared [min, max] Y domain (incl. SEM bands) across several PSTH series. */
function psthYDomain(seriesList) {
  let lo = Infinity, hi = -Infinity;
  for (const s of seriesList) {
    for (const d of s.allMean) {
      if (d.lo < lo) lo = d.lo;
      if (d.hi > hi) hi = d.hi;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return undefined;
  if (lo === hi) { lo -= 1; hi += 1; }
  return [lo, hi];
}

function buildPsthPlot({ allMean, channels }, yDomain, width = 320) {
  return Plot.plot({
    height: 200,
    width:  Math.max(220, width),
    marginLeft: 44,
    marginTop: 8,
    marginRight: 10,
    style:  { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { domain: [PSTH_PRE, PSTH_POST], label: 'Time rel. event (s)' },
    y: { label: 'Mean ΔF/F', grid: true, ...(yDomain ? { domain: yDomain } : {}) },
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
    ],
  });
}

/**
 * Build a PSTH card for a single fiber.  Header shows the targeted area in
 * large text (coloured with the fiber implant colour) and, below it, each
 * channel's intended measurement in the channel colour.  A coloured left
 * border matches the implant colour in the 3D view.  The plot uses the shared
 * `yDomain` so all fibers are on an identical scale.
 */
function buildPsthCard(series, meta, borderColor, area, yDomain, width) {
  const card = document.createElement('div');
  card.className = 'fib-psth-card';
  card.style.borderColor = borderColor;

  const header = document.createElement('div');
  header.className = 'fib-psth-header';

  const areaEl = document.createElement('div');
  areaEl.className = 'fib-psth-area';
  areaEl.style.color = borderColor;
  areaEl.textContent = area || '?';
  header.appendChild(areaEl);

  const measEl = document.createElement('div');
  measEl.className = 'fib-psth-meas';
  for (const ch of series.channels) {
    const meas = meta?.channels?.[ch];
    const measLabel = meas && meas !== 'missing' ? meas : 'none';
    const span = document.createElement('span');
    span.style.color = CHANNEL_COLORS[ch] ?? '#888';
    span.textContent = measLabel;
    measEl.appendChild(span);
  }
  header.appendChild(measEl);
  card.appendChild(header);

  card.appendChild(buildPsthPlot(series, yDomain, width));
  return card;
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

    // Fetch the implant surgery in parallel (drives the 3D inset + colours).
    const surgeryPromise = loadSurgery(subjectId);

    const eventOptions = Object.keys(PSTH_EVENTS)
      .map(e => `<option${e === PSTH_DEFAULT_EVENT ? ' selected' : ''}>${e}</option>`)
      .join('');

    section.innerHTML = `
      <div class="fib-controls">
        <label>Align to
          <select class="psth-event-sel">${eventOptions}</select>
        </label>
        <label class="fib-baseline-toggle">
          <input type="checkbox" class="psth-baseline-chk"> Baseline
        </label>
        <label class="fib-baseline-ms">
          <input type="number" class="psth-baseline-ms" value="${BASELINE_DEFAULT_MS}"
                 min="0" step="50" disabled> ms
        </label>
      </div>
      <div class="fib-top">
        <div class="fib-3d-col">
          <h4 class="fib-section-heading">Implant</h4>
          <div class="fib-3d-inset"><p class="fib-loading">Loading\u2026</p></div>
        </div>
        <div class="fib-psth-col">
          <h4 class="fib-section-heading">PSTH</h4>
          <div class="fib-psth-grid"><p class="fib-loading">Loading\u2026</p></div>
        </div>
      </div>
      <div class="fib-traces-section">
        <h4 class="fib-section-heading">Fiber Photometry Traces</h4>
        <div class="fib-traces-grid fib-loading-inner">Loading traces\u2026</div>
      </div>
    `;

    const inset3dEl  = section.querySelector('.fib-3d-inset');
    const tracesEl   = section.querySelector('.fib-traces-grid');
    const psthEl     = section.querySelector('.fib-psth-grid');
    const eventSel   = section.querySelector('.psth-event-sel');
    const baselineChk = section.querySelector('.psth-baseline-chk');
    const baselineMs  = section.querySelector('.psth-baseline-ms');

    // Resolve implant surgery → per-fiber colours + 3D inset.
    const surgery      = await surgeryPromise;
    const fiberInfoMap = buildFiberColorInfo(surgery);

    if (surgery?.surgeryData) {
      import('../subject/brain-viz-3d.js')
        .then(({ createBrainViz3D }) => {
          const viz = createBrainViz3D(surgery.surgeryData, surgery.proceduresCoordSys);
          viz.style.height = '100%';
          inset3dEl.innerHTML = '';
          inset3dEl.appendChild(viz);
        })
        .catch((err) => {
          console.error('[fib-playback] 3D inset error', err);
          inset3dEl.innerHTML = '<p class="fib-no-data">3D view unavailable.</p>';
        });
    } else {
      section.querySelector('.fib-3d-col')?.remove();
    }

    // ---- Fiber list + metadata ----
    let combos = [];
    try {
      combos = await queryRows(coord,
        `SELECT DISTINCT CAST(fiber AS INT) AS fiber
         FROM read_parquet(${fibSrc})
         WHERE asset_name LIKE '${prefix}%'
         ORDER BY fiber`
      );
    } catch {
      psthEl.innerHTML  = '<p class="fib-no-data">Could not load fiber list.</p>';
      tracesEl.textContent = 'Could not load fiber list.';
      return;
    }

    const fibers    = [...new Set(combos.map(r => r.fiber))].sort((a, b) => a - b);
    const fiberMeta = await loadFiberMeta(coord, rawAssetName);
    const tRef      = await loadSessionRef(coord, subjectId, rawAssetName);

    const areaFor = (idx) => {
      const info = fiberInfoMap.get(idx);
      return fiberMeta.get(idx)?.targetedStructure
        || info?.structureAcronym || info?.structureName || '';
    };

    /** Width of one cell in a 2-column grid container. */
    const cellWidth = (gridEl) => Math.max(220, Math.floor((gridEl.clientWidth - 12) / 2) - 14);

    /** Current baseline window in seconds, or 0 when disabled. */
    const currentBaselineSec = () => {
      if (!baselineChk.checked) return 0;
      const ms = Number(baselineMs.value);
      return Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0;
    };

    // ---- Traces: load every fiber once, cache, share a common Y-axis ----
    const traceCache = new Map();
    let traceYDomain;
    async function ensureTraces() {
      if (traceCache.size) return;
      const results = await Promise.all(
        fibers.map(f => loadTraces(coord, fibSrc, rawAssetName, f, tRef)),
      );
      fibers.forEach((f, i) => traceCache.set(f, results[i]));
      traceYDomain = sharedYDomain(traceCache);
    }

    async function refreshTraces(eventCol) {
      try {
        await ensureTraces();
        const eventTimes = eventCol
          ? await loadEventTimes(coord, subjectId, rawAssetName, eventCol)
          : [];
        const width = cellWidth(tracesEl);
        tracesEl.innerHTML = '';
        let any = false;
        fibers.forEach((f, order) => {
          const rows = traceCache.get(f) ?? [];
          if (!rows.length) return;
          any = true;
          const color = fiberColor(fiberInfoMap, f, order);
          tracesEl.appendChild(
            buildTraceCard(rows, eventTimes, traceYDomain, color, areaFor(f), width),
          );
        });
        if (!any) tracesEl.textContent = 'No trace data available.';
      } catch (err) {
        console.error('[fib-playback] trace error', err);
        tracesEl.textContent = 'Error loading fiber traces.';
      }
    }

    // ---- PSTH: check trial availability ----
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
      eventSel.disabled = true;
      baselineChk.disabled = true;
      baselineMs.disabled = true;
      await refreshTraces(null);
      return;
    }

    // Raw PSTH rows cached per event column (baseline is applied at render time).
    const psthRawCache = new Map();
    async function loadPsthAll(eventCol) {
      if (psthRawCache.has(eventCol)) return psthRawCache.get(eventCol);
      const results = await Promise.all(
        fibers.map(f => loadPsthData(coord, fibSrc, subjectId, rawAssetName, eventCol, f)),
      );
      psthRawCache.set(eventCol, results);
      return results;
    }

    /** Render the 2×2 PSTH grid from cached raw rows using the current baseline. */
    function renderPsth(results) {
      const baselineSec = currentBaselineSec();
      const withData = fibers
        .map((f, order) => ({ f, order, rows: results[order] }))
        .filter((s) => s.rows && s.rows.length);

      if (!withData.length) { psthEl.textContent = 'No data for this selection.'; return; }

      const computed = withData.map((s) => ({
        ...s, series: computePsthSeries(s.rows, baselineSec),
      }));
      const yDomain = psthYDomain(computed.map((c) => c.series));
      const width = cellWidth(psthEl);

      psthEl.innerHTML = '';
      for (const c of computed) {
        const color = fiberColor(fiberInfoMap, c.f, c.order);
        psthEl.appendChild(
          buildPsthCard(c.series, fiberMeta.get(c.f), color, areaFor(c.f), yDomain, width),
        );
      }
    }

    async function refreshPsth() {
      const eventCol = PSTH_EVENTS[eventSel.value];
      refreshTraces(eventCol);
      psthEl.innerHTML = '<p class="fib-loading">Loading PSTH\u2026</p>';
      try {
        const results = await loadPsthAll(eventCol);
        renderPsth(results);
      } catch (err) {
        console.error('[fib-playback] psth error', err);
        psthEl.textContent = 'Error loading PSTH data.';
      }
    }

    /** Re-render PSTH from cache when only the baseline changed (no reload). */
    function rerenderBaseline() {
      const results = psthRawCache.get(PSTH_EVENTS[eventSel.value]);
      if (results) renderPsth(results);
    }

    eventSel.addEventListener('change', refreshPsth);
    baselineChk.addEventListener('change', () => {
      baselineMs.disabled = !baselineChk.checked;
      rerenderBaseline();
    });
    baselineMs.addEventListener('change', () => {
      if (baselineChk.checked) rerenderBaseline();
    });
    await refreshPsth();
  })();

  return section;
}

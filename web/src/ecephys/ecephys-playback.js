import { DATA_CACHE_PREFIX, S3_BUCKET, S3_REGION } from '../constants.js';
import { queryRows } from '../lib/arrow.js';
import * as Plot from '@observablehq/plot';

const EPHYS_VERSION = 'bdc-v0.37';
const TIME_BINS = 250;
const HI_QUANTILE = 0.999;

const PSTH_PRE = -2;
const PSTH_POST = 4;
const PSTH_BINS = 120;
const PSTH_BIN_WIDTH = (PSTH_POST - PSTH_PRE) / PSTH_BINS;

const PSTH_EVENTS = {
  'Trial start': 'start_time',
  'Delay start': 'delay_start_time',
  'Go cue': 'goCue_start_time',
  'Reward outcome': 'reward_outcome_time',
  'Trial stop': 'stop_time',
};
const PSTH_DEFAULT_EVENT = 'Go cue';

function esc(s) { return String(s).replace(/'/g, "''"); }

function sessionDate(rawAssetName) {
  const m = String(rawAssetName).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function dfTrialsUrl(subjectId) {
  return `${DATA_CACHE_PREFIX}/${EPHYS_VERSION}/platform_dynamic_foraging_trials`
    + `/subject_id=${esc(subjectId)}/data.pqt`;
}

const _spikeFileCache = new Map();

async function resolveSpikeFile(rawAssetName) {
  const key = String(rawAssetName);
  if (_spikeFileCache.has(key)) return _spikeFileCache.get(key);
  const p = (async () => {
    const prefix =
      `data-asset-cache/${EPHYS_VERSION}/platform_ecephys_spikes/asset_name=${key}`;
    const listUrl =
      `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/` +
      `?list-type=2&prefix=${encodeURIComponent(prefix)}&max-keys=1000`;
    let resp;
    try { resp = await fetch(listUrl); } catch { return null; }
    if (!resp.ok) return null;
    const xml = await resp.text();
    const re = /<Key>([^<]+\.pqt)<\/Key>/g;
    const keys = [];
    let m;
    while ((m = re.exec(xml)) !== null) keys.push(m[1]);
    if (keys.length === 0) return null;
    keys.sort();
    const latest = keys[keys.length - 1];
    return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${latest}`;
  })();
  _spikeFileCache.set(key, p);
  return p;
}

async function loadProbes(coord, url) {
  return queryRows(coord,
    `SELECT device_name,
            COUNT(DISTINCT unit_name) AS nunits,
            COUNT(*) AS nspikes
     FROM read_parquet('${esc(url)}')
     WHERE spike_time IS NOT NULL
     GROUP BY device_name
     ORDER BY device_name`,
  );
}

async function loadBins(coord, url, probe) {
  const src = esc(url);
  const p = esc(probe);
  const rows = await queryRows(coord, `
    WITH s AS (
      SELECT unit_name, spike_time
      FROM read_parquet('${src}')
      WHERE device_name = '${p}' AND spike_time IS NOT NULL AND spike_time >= 0
    ),
    rng AS (
      SELECT MIN(spike_time) AS lo,
             approx_quantile(spike_time, ${HI_QUANTILE}) AS hi
      FROM s
    ),
    units AS (
      SELECT unit_name, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) - 1 AS uidx
      FROM s GROUP BY unit_name
    )
    SELECT u.uidx AS uidx,
           LEAST(${TIME_BINS} - 1,
                 CAST((s.spike_time - r.lo) / ((r.hi - r.lo) / ${TIME_BINS}) AS INT)) AS tbin,
           COUNT(*) AS n,
           r.lo AS lo,
           r.hi AS hi
    FROM s
    JOIN units u ON u.unit_name = s.unit_name
    CROSS JOIN rng r
    WHERE r.hi > r.lo AND s.spike_time BETWEEN r.lo AND r.hi
    GROUP BY u.uidx, tbin, r.lo, r.hi
  `);
  const lo = rows.length ? Number(rows[0].lo) : 0;
  const hi = rows.length ? Number(rows[0].hi) : 0;
  const bins = rows.map((r) => ({ uidx: Number(r.uidx), tbin: Number(r.tbin), n: Number(r.n) }));
  return { bins, lo, hi };
}

async function loadDfEventCounts(coord, subjectId, date) {
  if (!date) return {};
  const turl = dfTrialsUrl(subjectId);
  let rows;
  try {
    rows = await queryRows(coord, `
      SELECT
        COUNT(start_time) AS "Trial start",
        COUNT(delay_start_time) AS "Delay start",
        COUNT(goCue_start_time) AS "Go cue",
        COUNT(reward_outcome_time) AS "Reward outcome",
        COUNT(stop_time) AS "Trial stop"
      FROM read_parquet('${esc(turl)}')
      WHERE session_date = '${esc(date)}'
    `);
  } catch {
    return {};
  }
  const row = rows[0] ?? {};
  const counts = {};
  for (const label of Object.keys(PSTH_EVENTS)) {
    const n = Number(row[label] ?? 0);
    if (n > 0) counts[label] = n;
  }
  return counts;
}

async function loadAlignedPsth(coord, spkUrl, probe, subjectId, date, eventCol) {
  const turl = dfTrialsUrl(subjectId);
  const rows = await queryRows(coord, `
    WITH ev AS (
      SELECT ${eventCol} AS t0
      FROM read_parquet('${esc(turl)}')
      WHERE session_date = '${esc(date)}' AND ${eventCol} IS NOT NULL
    ),
    sp AS (
      SELECT spike_time
      FROM read_parquet('${esc(spkUrl)}')
      WHERE device_name = '${esc(probe)}' AND spike_time IS NOT NULL
    )
    SELECT CAST((sp.spike_time - ev.t0 - (${PSTH_PRE})) / ${PSTH_BIN_WIDTH} AS INT) AS bin,
           COUNT(*) AS n
    FROM sp
    JOIN ev ON sp.spike_time >= ev.t0 + (${PSTH_PRE})
           AND sp.spike_time < ev.t0 + (${PSTH_POST})
    GROUP BY bin
  `);
  return rows.map((r) => ({ bin: Number(r.bin), n: Number(r.n) }));
}

function computeAlignedPsth(bins, nTrials, nUnits) {
  if (!(nTrials > 0) || !(nUnits > 0)) return [];
  const totals = new Array(PSTH_BINS).fill(0);
  for (const b of bins) {
    if (b.bin >= 0 && b.bin < PSTH_BINS) totals[b.bin] += b.n;
  }
  return totals.map((n, i) => ({
    t: PSTH_PRE + (i + 0.5) * PSTH_BIN_WIDTH,
    rate: n / (nTrials * nUnits * PSTH_BIN_WIDTH),
  }));
}

function computePopulationPsth(bins, lo, hi, nUnits) {
  const binWidth = (hi - lo) / TIME_BINS;
  if (!(binWidth > 0) || !(nUnits > 0)) return [];
  const totals = new Array(TIME_BINS).fill(0);
  for (const b of bins) totals[b.tbin] += b.n;
  return totals.map((n, i) => ({
    t: (i + 0.5) * binWidth,
    rate: n / (nUnits * binWidth),
  }));
}

function buildAlignedPsthPlot(psth, eventLabel, width) {
  return Plot.plot({
    height: 220,
    width: Math.max(240, width),
    marginLeft: 52,
    marginTop: 10,
    marginRight: 12,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { label: `Time from ${eventLabel} (s)`, domain: [PSTH_PRE, PSTH_POST] },
    y: { label: 'Firing rate (Hz/unit)', grid: true, nice: true },
    marks: [
      Plot.areaY(psth, { x: 't', y: 'rate', fill: '#6366f1', fillOpacity: 0.18 }),
      Plot.lineY(psth, { x: 't', y: 'rate', stroke: '#4f46e5', strokeWidth: 1.4 }),
      Plot.ruleX([0], { stroke: '#888', strokeDasharray: '3,3' }),
      Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.4 }),
    ],
  });
}

function buildPopulationPsthPlot(psth, width) {
  return Plot.plot({
    height: 220,
    width: Math.max(240, width),
    marginLeft: 52,
    marginTop: 10,
    marginRight: 12,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { label: 'Time from recording start (s)' },
    y: { label: 'Firing rate (Hz/unit)', grid: true, nice: true },
    marks: [
      Plot.areaY(psth, { x: 't', y: 'rate', fill: '#6366f1', fillOpacity: 0.18 }),
      Plot.lineY(psth, { x: 't', y: 'rate', stroke: '#4f46e5', strokeWidth: 1.4 }),
      Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.4 }),
    ],
  });
}

function buildRasterPlot(bins, lo, hi, nUnits, width) {
  const binWidth = (hi - lo) / TIME_BINS;
  return Plot.plot({
    height: 340,
    width: Math.max(280, width),
    marginLeft: 52,
    marginTop: 10,
    marginRight: 12,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { label: 'Time from recording start (s)', domain: [0, hi - lo] },
    y: { label: 'Unit', domain: [0, Math.max(1, nUnits)], reverse: true },
    color: { type: 'sqrt', scheme: 'turbo', label: 'Spikes/bin', legend: true },
    marks: [
      Plot.rect(bins, {
        x1: (d) => d.tbin * binWidth,
        x2: (d) => (d.tbin + 1) * binWidth,
        y1: 'uidx',
        y2: (d) => d.uidx + 1,
        fill: 'n',
      }),
    ],
  });
}


export function createEcephysPlayback(coord, subjectId, rawAssetName) {
  const section = document.createElement('section');
  section.className = 'ecephys-playback-section';
  section.innerHTML = '<p class="ecephys-loading">Checking for ecephys data\u2026</p>';

  (async () => {
    const url = await resolveSpikeFile(rawAssetName);
    if (!url) { section.remove(); return; }

    let probes = [];
    try {
      probes = await loadProbes(coord, url);
    } catch (err) {
      console.error('[ecephys-playback] probe query error', err);
      section.remove();
      return;
    }
    probes = probes.filter((p) => p.device_name != null && Number(p.nunits) > 0);
    if (probes.length === 0) { section.remove(); return; }

    const date = sessionDate(rawAssetName);
    const dfCounts = await loadDfEventCounts(coord, subjectId, date);
    const dfEventLabels = Object.keys(PSTH_EVENTS).filter((l) => dfCounts[l] > 0);
    const isDf = dfEventLabels.length > 0;

    const probeOptions = probes
      .map((p) => `<option value="${esc(p.device_name)}">${esc(p.device_name)} `
        + `(${Number(p.nunits)} units)</option>`)
      .join('');

    const eventControl = isDf
      ? `<label>Align to
           <select class="ecephys-event-sel">${
             dfEventLabels
               .map((l) => `<option${l === PSTH_DEFAULT_EVENT ? ' selected' : ''}>${esc(l)}</option>`)
               .join('')
           }</select>
         </label>`
      : '';

    const hint = isDf
      ? 'PSTH aligned to behavioral events; full-session raster (binned in DuckDB).'
      : 'No behavioral events \u2014 showing session population rate; full-session raster.';

    section.innerHTML = `
      <div class="ecephys-controls">
        <label>Probe
          <select class="ecephys-probe-sel">${probeOptions}</select>
        </label>
        ${eventControl}
        <span class="ecephys-hint">${hint}</span>
      </div>
      <div class="ecephys-plots">
        <div class="ecephys-psth-col">
          <h4 class="ecephys-section-heading">PSTH</h4>
          <div class="ecephys-psth"><p class="ecephys-loading">Loading\u2026</p></div>
        </div>
        <div class="ecephys-raster-col">
          <h4 class="ecephys-section-heading">Raster</h4>
          <div class="ecephys-raster"><p class="ecephys-loading">Loading\u2026</p></div>
        </div>
      </div>
    `;

    const probeSel = section.querySelector('.ecephys-probe-sel');
    const eventSel = section.querySelector('.ecephys-event-sel');
    const psthEl = section.querySelector('.ecephys-psth');
    const rasterEl = section.querySelector('.ecephys-raster');

    const nUnitsFor = (probe) =>
      Number(probes.find((p) => String(p.device_name) === String(probe))?.nunits ?? 0);

    let lastRaster = null;
    let gen = 0;

    async function renderRaster() {
      rasterEl.innerHTML = '<p class="ecephys-loading">Loading\u2026</p>';
      const probe = probeSel.value;
      const nUnits = nUnitsFor(probe);
      const g = gen;
      let data;
      try {
        data = await loadBins(coord, url, probe);
      } catch (err) {
        console.error('[ecephys-playback] raster query error', err);
        if (g === gen) rasterEl.innerHTML = '<p class="ecephys-no-data">Error loading spikes.</p>';
        return;
      }
      if (g !== gen) return;
      lastRaster = data;
      const { bins, lo, hi } = data;
      if (bins.length === 0 || !(hi > lo)) {
        rasterEl.innerHTML = '<p class="ecephys-no-data">No spikes in range.</p>';
        return;
      }
      const width = Math.max(280, Math.floor(rasterEl.clientWidth) - 8);
      rasterEl.innerHTML = '';
      rasterEl.appendChild(buildRasterPlot(bins, lo, hi, nUnits, width));
    }

    async function renderPsth() {
      psthEl.innerHTML = '<p class="ecephys-loading">Loading\u2026</p>';
      const probe = probeSel.value;
      const nUnits = nUnitsFor(probe);
      const width = Math.max(240, Math.floor(psthEl.clientWidth) - 8);
      const g = gen;

      if (isDf) {
        const label = eventSel.value;
        const eventCol = PSTH_EVENTS[label];
        const nTrials = dfCounts[label] ?? 0;
        let bins;
        try {
          bins = await loadAlignedPsth(coord, url, probe, subjectId, date, eventCol);
        } catch (err) {
          console.error('[ecephys-playback] psth query error', err);
          if (g === gen) psthEl.innerHTML = '<p class="ecephys-no-data">Error loading PSTH.</p>';
          return;
        }
        if (g !== gen) return;
        const series = computeAlignedPsth(bins, nTrials, nUnits);
        if (series.length === 0) {
          psthEl.innerHTML = '<p class="ecephys-no-data">No spikes near this event.</p>';
          return;
        }
        psthEl.innerHTML = '';
        psthEl.appendChild(buildAlignedPsthPlot(series, label, width));
        return;
      }

      if (!lastRaster) { psthEl.innerHTML = ''; return; }
      const { bins, lo, hi } = lastRaster;
      const series = computePopulationPsth(bins, lo, hi, nUnits);
      if (series.length === 0) {
        psthEl.innerHTML = '<p class="ecephys-no-data">No spikes in range.</p>';
        return;
      }
      psthEl.innerHTML = '';
      psthEl.appendChild(buildPopulationPsthPlot(series, width));
    }

    async function refreshProbe() {
      gen += 1;
      await renderRaster();
      await renderPsth();
    }

    probeSel.addEventListener('change', refreshProbe);
    if (eventSel) eventSel.addEventListener('change', () => { renderPsth(); });

    await refreshProbe();
  })().catch((err) => {
    console.error('[ecephys-playback] fatal error', err);
    section.remove();
  });

  return section;
}

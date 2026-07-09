import { DATA_CACHE_PREFIX, S3_BUCKET, S3_REGION } from '../constants.js';
import { queryRows } from '../lib/arrow.js';
import { escHtml } from '../lib/utils.js';
import * as Plot from '@observablehq/plot';

const EPHYS_VERSION = 'bdc-v0.37';
const TIME_BINS = 250;
const DEPTH_BINS = 120;
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

async function loadBinsByDepth(coord, spkUrl, unitsUrl, probe) {
  const rows = await queryRows(coord, `
    WITH s AS (
      SELECT sp.spike_time AS t, u.depth AS depth
      FROM read_parquet('${esc(spkUrl)}') sp
      JOIN read_parquet('${esc(unitsUrl)}') u ON u.unit_name = sp.unit_name
      WHERE sp.device_name = '${esc(probe)}' AND sp.spike_time >= 0 AND u.depth IS NOT NULL
    ),
    rng AS (
      SELECT MIN(t) AS lo, approx_quantile(t, ${HI_QUANTILE}) AS hi,
             MIN(depth) AS dlo, MAX(depth) AS dhi
      FROM s
    )
    SELECT LEAST(${TIME_BINS} - 1,
                 CAST((s.t - r.lo) / ((r.hi - r.lo) / ${TIME_BINS}) AS INT)) AS tbin,
           LEAST(${DEPTH_BINS} - 1,
                 CAST((s.depth - r.dlo) / ((r.dhi - r.dlo) / ${DEPTH_BINS}) AS INT)) AS dbin,
           COUNT(*) AS n,
           r.lo AS lo, r.hi AS hi, r.dlo AS dlo, r.dhi AS dhi
    FROM s
    CROSS JOIN rng r
    WHERE r.hi > r.lo AND r.dhi > r.dlo AND s.t BETWEEN r.lo AND r.hi
    GROUP BY tbin, dbin, r.lo, r.hi, r.dlo, r.dhi
  `);
  const lo = rows.length ? Number(rows[0].lo) : 0;
  const hi = rows.length ? Number(rows[0].hi) : 0;
  const dlo = rows.length ? Number(rows[0].dlo) : 0;
  const dhi = rows.length ? Number(rows[0].dhi) : 0;
  const bins = rows.map((r) => ({ tbin: Number(r.tbin), dbin: Number(r.dbin), n: Number(r.n) }));
  return { bins, lo, hi, dlo, dhi };
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

async function loadAlignedPsth(coord, spkUrl, probe, subjectId, date, eventCol, unitName) {
  const turl = dfTrialsUrl(subjectId);
  const unitFilter = unitName ? ` AND unit_name = '${esc(unitName)}'` : '';
  const rows = await queryRows(coord, `
    WITH ev AS (
      SELECT ${eventCol} AS t0
      FROM read_parquet('${esc(turl)}')
      WHERE session_date = '${esc(date)}' AND ${eventCol} IS NOT NULL
    ),
    sp AS (
      SELECT spike_time
      FROM read_parquet('${esc(spkUrl)}')
      WHERE device_name = '${esc(probe)}' AND spike_time IS NOT NULL${unitFilter}
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

function unitsUrlFrom(spikeUrl) {
  return spikeUrl.replace('/platform_ecephys_spikes/', '/platform_ecephys_units/');
}

async function loadUnitsMeta(coord, unitsUrl, probe) {
  return queryRows(coord, `
    SELECT unit_name, decoder_label, default_qc,
           firing_rate, snr, num_spikes, presence_ratio,
           isi_violations_ratio, amplitude_median, depth,
           array_to_string(waveform, ',') AS waveform
    FROM read_parquet('${esc(unitsUrl)}')
    WHERE device_name = '${esc(probe)}'
  `);
}

async function loadUnitSessionPsth(coord, spkUrl, probe, unitName, lo, hi) {
  const binWidth = (hi - lo) / TIME_BINS;
  if (!(binWidth > 0)) return [];
  const rows = await queryRows(coord, `
    SELECT LEAST(${TIME_BINS} - 1, CAST((spike_time - ${lo}) / ${binWidth} AS INT)) AS bin,
           COUNT(*) AS n
    FROM read_parquet('${esc(spkUrl)}')
    WHERE device_name = '${esc(probe)}' AND unit_name = '${esc(unitName)}'
      AND spike_time BETWEEN ${lo} AND ${hi}
    GROUP BY bin
  `);
  const totals = new Array(TIME_BINS).fill(0);
  for (const r of rows) {
    const b = Number(r.bin);
    if (b >= 0 && b < TIME_BINS) totals[b] = Number(r.n);
  }
  return totals.map((n, i) => ({ t: (i + 0.5) * binWidth, rate: n / binWidth }));
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

function buildAlignedPsthPlot(psth, eventLabel, yLabel, width) {
  return Plot.plot({
    height: 340,
    width: Math.max(240, width),
    marginLeft: 88,
    marginTop: 24,
    marginRight: 12,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { label: `Time from ${eventLabel} (s)`, domain: [PSTH_PRE, PSTH_POST] },
    y: { label: yLabel, grid: true, nice: true },
    marks: [
      Plot.lineY(psth, { x: 't', y: 'rate', stroke: '#c0392b', strokeWidth: 1.6 }),
      Plot.ruleX([0], { stroke: '#888', strokeDasharray: '3,3' }),
      Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.4 }),
    ],
  });
}

function buildPopulationPsthPlot(psth, yLabel, width) {
  return Plot.plot({
    height: 340,
    width: Math.max(240, width),
    marginLeft: 88,
    marginTop: 24,
    marginRight: 12,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { label: 'Time from recording start (s)' },
    y: { label: yLabel, grid: true, nice: true },
    marks: [
      Plot.lineY(psth, { x: 't', y: 'rate', stroke: '#c0392b', strokeWidth: 1.6 }),
      Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.4 }),
    ],
  });
}

function parseWaveform(raw) {
  if (Array.isArray(raw)) return raw.map(Number).filter((x) => Number.isFinite(x));
  if (typeof raw === 'string' && raw.length) {
    return raw.split(',').map(Number).filter((x) => Number.isFinite(x));
  }
  return null;
}

function buildWaveformPlot(waveform, width) {
  const pts = waveform.map((v, i) => ({ i, v: Number(v) }));
  return Plot.plot({
    height: 130,
    width: Math.max(180, width),
    marginLeft: 52,
    marginTop: 8,
    marginRight: 10,
    marginBottom: 26,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 9 },
    x: { label: 'Sample' },
    y: { label: 'Amplitude (a.u.)', grid: true, nice: true },
    marks: [
      Plot.ruleY([0], { stroke: '#555', strokeOpacity: 0.3 }),
      Plot.lineY(pts, { x: 'i', y: 'v', stroke: '#c0392b', strokeWidth: 1.4 }),
    ],
  });
}

const UNIT_COLUMNS = [
  { key: 'decoder_label', label: 'Label', type: 'text' },
  { key: 'firing_rate', label: 'FR', type: 'num', digits: 2 },
  { key: 'snr', label: 'SNR', type: 'num', digits: 2 },
  { key: 'num_spikes', label: 'Spikes', type: 'num', digits: 0 },
  { key: 'presence_ratio', label: 'Presence', type: 'num', digits: 2 },
  { key: 'isi_violations_ratio', label: 'ISIv', type: 'num', digits: 3 },
  { key: 'amplitude_median', label: 'Amp', type: 'num', digits: 0 },
  { key: 'depth', label: 'Depth', type: 'num', digits: 0 },
  { key: 'default_qc', label: 'QC', type: 'bool' },
];

function fmtCell(v, col) {
  if (col.type === 'bool') return v ? '\u2713' : '\u2717';
  if (col.type === 'num') {
    if (v == null || Number.isNaN(Number(v))) return '\u2014';
    const n = Number(v);
    return col.digits === 0 ? Math.round(n).toLocaleString() : n.toFixed(col.digits);
  }
  return escHtml(String(v ?? '\u2014'));
}

function sortUnits(units, key, dir) {
  const s = units.slice();
  const sign = dir === 'asc' ? 1 : -1;
  s.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    const an = av == null;
    const bn = bv == null;
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv);
    return sign * String(av).localeCompare(String(bv));
  });
  return s;
}

function renderUnitsTableHtml(units, sortKey, sortDir, selectedUnit) {
  const arrow = (k) => (k === sortKey ? (sortDir === 'asc' ? ' \u25b2' : ' \u25bc') : '');
  const head =
    `<th data-key="unit_name">Unit${arrow('unit_name')}</th>` +
    UNIT_COLUMNS.map((c) =>
      `<th data-key="${c.key}" class="${c.type === 'num' ? 'num' : ''}">${c.label}${arrow(c.key)}</th>`,
    ).join('');
  const body = sortUnits(units, sortKey, sortDir).map((u) => {
    const name = String(u.unit_name ?? '');
    const sel = name === selectedUnit ? ' ecephys-u-sel' : '';
    const cells = UNIT_COLUMNS.map((c) =>
      `<td class="${c.type === 'num' ? 'num' : ''}">${fmtCell(u[c.key], c)}</td>`,
    ).join('');
    return `<tr class="ecephys-u-row${sel}" data-unit="${escHtml(name)}">`
      + `<td class="ecephys-u-name" title="${escHtml(name)}">${escHtml(name.slice(0, 8))}</td>`
      + `${cells}</tr>`;
  }).join('');
  return `<table class="ecephys-units-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}


function buildRasterPlot(bins, lo, hi, nUnits, width) {
  const binWidth = (hi - lo) / TIME_BINS;
  return Plot.plot({
    height: 340,
    width: Math.max(280, width),
    marginLeft: 62,
    marginTop: 10,
    marginRight: 12,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { label: 'Time from recording start (s)', domain: [0, hi - lo] },
    y: { label: 'Unit', domain: [0, Math.max(1, nUnits)], reverse: true },
    color: { type: 'sqrt', scheme: 'reds', label: 'Spikes/bin', legend: true },
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

function buildDepthRasterPlot(bins, lo, hi, dlo, dhi, width) {
  const tW = (hi - lo) / TIME_BINS;
  const dW = (dhi - dlo) / DEPTH_BINS;
  return Plot.plot({
    height: 340,
    width: Math.max(280, width),
    marginLeft: 66,
    marginTop: 10,
    marginRight: 12,
    marginBottom: 30,
    style: { background: 'transparent', fontFamily: 'inherit', fontSize: 10 },
    x: { label: 'Time from recording start (s)', domain: [0, hi - lo] },
    y: { label: 'Depth (\u00b5m)', domain: [dlo, dhi] },
    color: { type: 'sqrt', scheme: 'reds', label: 'Spikes/bin', legend: true },
    marks: [
      Plot.rect(bins, {
        x1: (d) => d.tbin * tW,
        x2: (d) => (d.tbin + 1) * tW,
        y1: (d) => dlo + d.dbin * dW,
        y2: (d) => dlo + (d.dbin + 1) * dW,
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

    const unitsUrl = unitsUrlFrom(url);
    let hasUnits = false;
    try {
      await queryRows(coord, `SELECT 1 FROM read_parquet('${esc(unitsUrl)}') LIMIT 1`);
      hasUnits = true;
    } catch { hasUnits = false; }

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

    const unitsSection = hasUnits
      ? `<div class="ecephys-units-section">
           <h4 class="ecephys-section-heading">Units \u2014 click a row to compute its PSTH</h4>
           <div class="ecephys-units-wrap">
             <div class="ecephys-units-table-col">
               <div class="ecephys-table-toolbar">
                 <label class="ecephys-toggle">QC
                   <select class="ecephys-qc-filter">
                     <option value="pass" selected>Pass</option>
                     <option value="all">All</option>
                   </select>
                 </label>
               </div>
               <div class="ecephys-units-scroll"><p class="ecephys-loading">Loading units\u2026</p></div>
             </div>
             <div class="ecephys-unit-detail"></div>
           </div>
         </div>`
      : '';

    section.innerHTML = `
      <div class="ecephys-controls">
        <label>Probe
          <select class="ecephys-probe-sel">${probeOptions}</select>
        </label>
        ${eventControl}
        <span class="ecephys-selection">All units</span>
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
      ${unitsSection}
    `;

    const probeSel = section.querySelector('.ecephys-probe-sel');
    const eventSel = section.querySelector('.ecephys-event-sel');
    const psthEl = section.querySelector('.ecephys-psth');
    const rasterEl = section.querySelector('.ecephys-raster');
    const unitsScrollEl = section.querySelector('.ecephys-units-scroll');
    const unitDetailEl = section.querySelector('.ecephys-unit-detail');
    const selectionEl = section.querySelector('.ecephys-selection');
    const qcFilterSel = section.querySelector('.ecephys-qc-filter');

    const nUnitsFor = (probe) =>
      Number(probes.find((p) => String(p.device_name) === String(probe))?.nunits ?? 0);

    let lastRaster = null;
    let selectedUnit = null;
    let unitRows = [];
    const unitCache = new Map();
    const unitSort = { key: 'num_spikes', dir: 'desc' };
    let gen = 0;

    const qcPass = () => (qcFilterSel ? qcFilterSel.value === 'pass' : false);
    const filteredUnits = () => (qcPass() ? unitRows.filter((u) => u.default_qc) : unitRows);

    function updateSelectionLabel() {
      if (!selectedUnit) { selectionEl.textContent = 'All units'; return; }
      const u = unitRows.find((r) => String(r.unit_name) === selectedUnit);
      const label = u?.decoder_label ? ` (${u.decoder_label})` : '';
      selectionEl.textContent = `Unit ${selectedUnit.slice(0, 8)}${label}`;
    }

    async function renderRaster() {
      rasterEl.innerHTML = '<p class="ecephys-loading">Loading\u2026</p>';
      const probe = probeSel.value;
      const nUnits = nUnitsFor(probe);
      const mode = hasUnits ? 'depth' : 'unit';
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
      if (data.bins.length === 0 || !(data.hi > data.lo)) {
        rasterEl.innerHTML = '<p class="ecephys-no-data">No spikes in range.</p>';
        return;
      }
      const width = Math.max(280, Math.floor(rasterEl.clientWidth) - 8);

      if (mode === 'depth' && hasUnits) {
        let depthData;
        try {
          depthData = await loadBinsByDepth(coord, url, unitsUrl, probe);
        } catch (err) {
          console.error('[ecephys-playback] depth raster query error', err);
          if (g === gen) rasterEl.innerHTML = '<p class="ecephys-no-data">Error loading depth raster.</p>';
          return;
        }
        if (g !== gen) return;
        if (depthData.bins.length === 0 || !(depthData.dhi > depthData.dlo)) {
          rasterEl.innerHTML = '<p class="ecephys-no-data">No unit depths available.</p>';
          return;
        }
        rasterEl.innerHTML = '';
        rasterEl.appendChild(
          buildDepthRasterPlot(depthData.bins, depthData.lo, depthData.hi, depthData.dlo, depthData.dhi, width),
        );
        return;
      }

      rasterEl.innerHTML = '';
      rasterEl.appendChild(buildRasterPlot(data.bins, data.lo, data.hi, nUnits, width));
    }

    function renderUnitDetail() {
      if (!unitDetailEl) return;
      if (!selectedUnit) {
        unitDetailEl.innerHTML = '<p class="ecephys-hint">Select a unit to see its mean waveform.</p>';
        return;
      }
      const u = unitRows.find((r) => String(r.unit_name) === selectedUnit);
      if (!u) { unitDetailEl.innerHTML = ''; return; }
      unitDetailEl.innerHTML = '<h5 class="ecephys-detail-title">Mean waveform</h5>';
      const wf = parseWaveform(u.waveform);
      if (wf && wf.length) {
        const width = Math.max(180, Math.floor(unitDetailEl.clientWidth) - 8);
        unitDetailEl.appendChild(buildWaveformPlot(wf, width));
      } else {
        const p = document.createElement('p');
        p.className = 'ecephys-hint';
        p.textContent = 'No waveform available.';
        unitDetailEl.appendChild(p);
      }
    }

    function paintUnitsTable() {
      unitsScrollEl.innerHTML = renderUnitsTableHtml(filteredUnits(), unitSort.key, unitSort.dir, selectedUnit);
    }

    async function renderUnits() {
      if (!hasUnits) return;
      const probe = probeSel.value;
      const g = gen;
      if (!unitCache.has(probe)) {
        unitsScrollEl.innerHTML = '<p class="ecephys-loading">Loading units\u2026</p>';
        try {
          unitCache.set(probe, await loadUnitsMeta(coord, unitsUrl, probe));
        } catch (err) {
          console.error('[ecephys-playback] units query error', err);
          if (g === gen) unitsScrollEl.innerHTML = '<p class="ecephys-no-data">Error loading units.</p>';
          return;
        }
      }
      if (g !== gen) return;
      unitRows = unitCache.get(probe) ?? [];
      paintUnitsTable();
      renderUnitDetail();
    }

    async function renderPsth() {
      psthEl.innerHTML = '<p class="ecephys-loading">Loading\u2026</p>';
      const probe = probeSel.value;
      const unit = selectedUnit;
      const yLabel = unit ? 'Firing rate (Hz)' : 'Firing rate (Hz/unit)';
      const width = Math.max(240, Math.floor(psthEl.clientWidth) - 8);
      const g = gen;

      if (isDf) {
        const label = eventSel.value;
        const eventCol = PSTH_EVENTS[label];
        const nTrials = dfCounts[label] ?? 0;
        const divisor = unit ? 1 : nUnitsFor(probe);
        let bins;
        try {
          bins = await loadAlignedPsth(coord, url, probe, subjectId, date, eventCol, unit);
        } catch (err) {
          console.error('[ecephys-playback] psth query error', err);
          if (g === gen) psthEl.innerHTML = '<p class="ecephys-no-data">Error loading PSTH.</p>';
          return;
        }
        if (g !== gen) return;
        const series = computeAlignedPsth(bins, nTrials, divisor);
        if (series.length === 0) {
          psthEl.innerHTML = '<p class="ecephys-no-data">No spikes near this event.</p>';
          return;
        }
        psthEl.innerHTML = '';
        psthEl.appendChild(buildAlignedPsthPlot(series, label, yLabel, width));
        return;
      }

      if (!lastRaster) { psthEl.innerHTML = ''; return; }
      const { bins, lo, hi } = lastRaster;
      let series;
      if (unit) {
        try {
          series = await loadUnitSessionPsth(coord, url, probe, unit, lo, hi);
        } catch (err) {
          console.error('[ecephys-playback] unit psth query error', err);
          if (g === gen) psthEl.innerHTML = '<p class="ecephys-no-data">Error loading PSTH.</p>';
          return;
        }
        if (g !== gen) return;
      } else {
        series = computePopulationPsth(bins, lo, hi, nUnitsFor(probe));
      }
      if (series.length === 0) {
        psthEl.innerHTML = '<p class="ecephys-no-data">No spikes in range.</p>';
        return;
      }
      psthEl.innerHTML = '';
      psthEl.appendChild(buildPopulationPsthPlot(series, yLabel, width));
    }

    function selectUnit(unitName) {
      selectedUnit = selectedUnit === unitName ? null : unitName;
      updateSelectionLabel();
      paintUnitsTable();
      renderUnitDetail();
      renderPsth();
    }

    if (unitsScrollEl) {
      unitsScrollEl.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-key]');
        if (th) {
          const key = th.dataset.key;
          if (unitSort.key === key) unitSort.dir = unitSort.dir === 'asc' ? 'desc' : 'asc';
          else { unitSort.key = key; unitSort.dir = key === 'unit_name' || key === 'decoder_label' ? 'asc' : 'desc'; }
          paintUnitsTable();
          return;
        }
        const row = e.target.closest('tr.ecephys-u-row');
        if (row) selectUnit(row.dataset.unit);
      });
    }

    async function refreshProbe() {
      gen += 1;
      selectedUnit = null;
      updateSelectionLabel();
      await renderRaster();
      await renderUnits();
      await renderPsth();
    }

    probeSel.addEventListener('change', refreshProbe);
    if (eventSel) eventSel.addEventListener('change', () => { renderPsth(); });
    if (qcFilterSel) qcFilterSel.addEventListener('change', () => { paintUnitsTable(); });

    await refreshProbe();
  })().catch((err) => {
    console.error('[ecephys-playback] fatal error', err);
    section.remove();
  });

  return section;
}

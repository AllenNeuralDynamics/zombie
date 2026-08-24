/**
 * pophys/view.js — population optical-physiology viewer for a multiplane
 * imaging session, embedded in the subject viewer's Event Details panel when
 * an acquisition has the `pophys` modality.
 *
 * Iteration 1:
 *   - plane selector (from the ROI cache),
 *   - field-of-view: max-projection PNG + clickable ROI contour overlay,
 *   - selected-ROI calcium trace (dF/F by default; events / neuropil / raw),
 *     read on demand from the public pophys NWB (Zarr).
 *
 * The ROI contours + FOV images come from the precomputed cache (always
 * public). Traces come from the derived pophys NWB and are only available when
 * that asset is public on aind-open-data — otherwise the FOV still renders and
 * the trace panel shows an "unavailable" note.
 */

import * as Plot from '@observablehq/plot';
import { loadPophysRois, fovUrl } from './cache.js';
import { loadBehaviorEvents } from '../mfish/behavior-events.js';
import { resolveLatestDerived } from '../lib/raw-to-derived.js';
import {
  openPophysNwb,
  loadPlaneTimestamps,
  loadRoiTrace,
  loadPlaneMeta,
  resolvePlaneLayout,
  TRACE_LABELS,
} from './nwb-traces.js';

const SOMA_COLOR = '#3b82f6';
const NONSOMA_COLOR = '#f59e0b';

// PSTH window (seconds) around each behavioral event.
const PSTH_PRE = 2;
const PSTH_POST = 4;

/** Resolve the derived pophys asset (name + location) for a raw acquisition. */
async function resolvePophysAsset(coord, rawAssetName) {
  return resolveLatestDerived(coord, rawAssetName, { modality: 'pophys' });
}

export function createPophysViewer(coord, event) {
  const root = document.createElement('section');
  root.className = 'pophys-viewer';
  root.innerHTML = `
    <div class="pophys-header">
      <h3 class="platform-summary-heading">Population optical physiology</h3>
      <div class="pophys-controls" hidden>
        <label>Plane <select class="pophys-plane"></select></label>
        <label>Trace <select class="pophys-series"></select></label>
      </div>
    </div>
    <div class="pophys-status">Loading pophys data\u2026</div>
    <div class="pophys-body" hidden>
      <div class="pophys-fov">
        <div class="pophys-fov-stage">
          <img class="pophys-fov-img" alt="field of view" />
          <svg class="pophys-fov-overlay" viewBox="0 0 512 512" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
        <div class="pophys-fov-caption"></div>
      </div>
      <div class="pophys-trace">
        <div class="pophys-trace-title">Click an ROI to see its trace</div>
        <div class="pophys-trace-plot"></div>
        <div class="pophys-psth" hidden>
          <div class="pophys-psth-head">
            <span class="pophys-psth-title">PSTH</span>
            <label>aligned to <select class="pophys-psth-event"></select></label>
          </div>
          <div class="pophys-psth-plot"></div>
        </div>
      </div>
    </div>
  `;

  const q = (s) => root.querySelector(s);
  const statusEl = q('.pophys-status');
  const bodyEl = q('.pophys-body');
  const controlsEl = q('.pophys-controls');
  const planeSel = q('.pophys-plane');
  const seriesSel = q('.pophys-series');
  const fovImg = q('.pophys-fov-img');
  const overlay = q('.pophys-fov-overlay');
  const captionEl = q('.pophys-fov-caption');
  const traceTitle = q('.pophys-trace-title');
  const tracePlot = q('.pophys-trace-plot');
  const psthEl = q('.pophys-psth');
  const psthEventSel = q('.pophys-psth-event');
  const psthPlot = q('.pophys-psth-plot');

  const setStatus = (t, err = false) => {
    statusEl.textContent = t;
    statusEl.hidden = !t;
    statusEl.classList.toggle('pophys-status--error', err);
  };

  const ctrl = new AbortController();
  const rawAssetName = event?.data?._assetName ?? null;

  // Per-plane state.
  let asset = null;
  let nwbRoot = null;
  let tracesPublic = false;
  let planes = [];
  let curPlane = null;
  let selectedRoi = null;
  const tsCache = new Map();   // plane → Float64Array timestamps
  const metaCache = new Map(); // plane → { depthUm, imagingRate }
  let traceReq = 0;            // guards out-of-order trace loads

  // Behavioral events for the PSTH (loaded best-effort in the background).
  let behEvents = null;
  let behEventStreams = [];    // [{ key, label, times }]
  let lastTrace = null;        // { roi, series, ts, y } for PSTH recompute

  (async () => {
    if (!rawAssetName) { setStatus('No acquisition asset for this event.', true); return; }
    try {
      asset = await resolvePophysAsset(coord, rawAssetName);
      if (ctrl.signal.aborted) return;
      if (!asset) { setStatus('No derived pophys asset found for this acquisition.', true); return; }

      const { planes: cachePlanes } = await loadPophysRois(coord, asset.name);
      if (ctrl.signal.aborted) return;
      if (!cachePlanes.length) { setStatus('No pophys ROI cache found for this asset.', true); return; }
      planes = cachePlanes;

      if (String(asset.location ?? '').startsWith('s3://aind-open-data/')) {
        nwbRoot = await openPophysNwb(asset.name, { signal: ctrl.signal }).catch((err) => {
          console.warn('[pophys] NWB-Zarr unavailable; showing ROI cache only', err);
          return null;
        });
      }
      tracesPublic = !!nwbRoot;

      // Populate controls.
      planeSel.innerHTML = planes
        .map((p, i) => `<option value="${i}">${p.plane} (${p.rois.length} ROIs)</option>`)
        .join('');
      // The series list depends on the NWB layout of the selected plane, so it
      // is filled in by selectPlane() rather than assumed here.
      seriesSel.disabled = !tracesPublic;
      controlsEl.hidden = false;

      planeSel.onchange = () => selectPlane(planes[Number(planeSel.value)]);
      seriesSel.onchange = () => { if (selectedRoi) loadTrace(selectedRoi); };
      psthEventSel.onchange = () => { if (lastTrace) _renderPsth(); };

      setStatus('');
      bodyEl.hidden = false;
      selectPlane(planes[0]);

      // Behavioral events (for the PSTH) — best-effort, non-blocking.
      if (tracesPublic) _loadBehaviorEvents();
    } catch (err) {
      if (ctrl.signal.aborted) return;
      console.error('[pophys] load failed', err);
      setStatus(`Error loading pophys data: ${err.message}`, true);
    }
  })();

  // ---- Plane selection -------------------------------------------------
  function selectPlane(plane) {
    curPlane = plane;
    selectedRoi = null;
    fovImg.src = fovUrl(asset.name, plane.plane, 'max');
    _renderOverlay(plane);
    _updateCaption(plane);
    traceTitle.textContent = tracesPublic
      ? 'Click an ROI to see its trace'
      : 'Traces unavailable (pophys NWB not public for this asset)';
    tracePlot.replaceChildren();
    if (tracesPublic) _updateSeriesOptions(plane.plane);
  }

  /**
   * Fill the series picker from the plane's actual NWB layout. The two NWB
   * generations expose different series (legacy adds demixed / neuropil
   * fluorescence), so offering a fixed list produced silent 404s on click.
   */
  async function _updateSeriesOptions(plane) {
    const previous = seriesSel.value;
    let layout;
    try {
      layout = await resolvePlaneLayout(nwbRoot, plane);
    } catch (err) {
      if (ctrl.signal.aborted || curPlane?.plane !== plane) return;
      console.warn('[pophys] no readable trace layout for plane', plane, err);
      seriesSel.innerHTML = '';
      seriesSel.disabled = true;
      traceTitle.textContent = 'Traces unavailable (unrecognised NWB layout for this plane)';
      return;
    }
    if (ctrl.signal.aborted || curPlane?.plane !== plane) return;
    seriesSel.innerHTML = layout.series
      .map((k) => `<option value="${k}">${TRACE_LABELS[k] ?? k}</option>`)
      .join('');
    seriesSel.value = layout.series.includes(previous) ? previous : 'dff';
    seriesSel.disabled = false;
  }

  async function _updateCaption(plane) {
    let meta = metaCache.get(plane.plane);
    if (!meta && nwbRoot) {
      meta = await loadPlaneMeta(nwbRoot, plane.plane, { signal: ctrl.signal }).catch(() => null);
      if (meta) metaCache.set(plane.plane, meta);
    }
    const somas = plane.rois.filter((r) => r.isSoma).length;
    const depth = meta?.depthUm != null ? ` · ${meta.depthUm} µm` : '';
    const struct = plane.structure ? `${plane.structure}` : plane.plane;
    captionEl.textContent = `${struct}${depth} · ${plane.rois.length} ROIs (${somas} somatic)`;
  }

  function _renderOverlay(plane) {
    const ns = 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    for (const roi of plane.rois) {
      if (!roi.contour?.length) continue;
      const poly = document.createElementNS(ns, 'polygon');
      poly.setAttribute('points', roi.contour.map((p) => `${p[0]},${p[1]}`).join(' '));
      poly.setAttribute('class', `pophys-roi${roi.isSoma ? ' pophys-roi--soma' : ''}`);
      poly.style.stroke = roi.isSoma ? SOMA_COLOR : NONSOMA_COLOR;
      poly.dataset.roiId = String(roi.id);
      poly.addEventListener('click', () => _pickRoi(roi, poly));
      frag.appendChild(poly);
    }
    overlay.replaceChildren(frag);
  }

  function _pickRoi(roi, poly) {
    selectedRoi = roi;
    for (const el of overlay.querySelectorAll('.pophys-roi--selected')) {
      el.classList.remove('pophys-roi--selected');
    }
    poly.classList.add('pophys-roi--selected');
    if (tracesPublic) loadTrace(roi);
  }

  // ---- Trace loading ---------------------------------------------------
  async function loadTrace(roi) {
    if (!nwbRoot || !curPlane) return;
    const plane = curPlane.plane;
    const series = seriesSel.value;
    const reqId = ++traceReq;
    traceTitle.textContent = `Loading ${TRACE_LABELS[series]} for ROI ${roi.id}…`;
    try {
      let ts = tsCache.get(plane);
      if (!ts) {
        ts = await loadPlaneTimestamps(nwbRoot, plane, { signal: ctrl.signal });
        tsCache.set(plane, ts);
      }
      const y = await loadRoiTrace(nwbRoot, plane, roi.id, series, { signal: ctrl.signal });
      if (ctrl.signal.aborted || reqId !== traceReq) return;
      _renderTrace(roi, series, ts, y);
    } catch (err) {
      if (ctrl.signal.aborted || reqId !== traceReq) return;
      console.error('[pophys] trace load failed', err);
      traceTitle.textContent = `Failed to load trace for ROI ${roi.id}: ${err.message}`;
    }
  }

  function _renderTrace(roi, series, ts, y) {
    traceTitle.textContent = `ROI ${roi.id} · ${TRACE_LABELS[series]}` +
      `${roi.isSoma ? ' · soma' : ''}${roi.somaProb != null ? ` (p=${roi.somaProb.toFixed(2)})` : ''}`;
    const n = Math.min(ts.length, y.length);
    const rows = new Array(n);
    for (let i = 0; i < n; i++) rows[i] = { t: ts[i], v: y[i] };
    const width = Math.max(320, tracePlot.clientWidth || 520);
    const fig = Plot.plot({
      width,
      height: 220,
      marginLeft: 52,
      marginBottom: 34,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      x: { label: 'time (s) →' },
      y: { label: TRACE_LABELS[series], grid: true },
      marks: [
        Plot.ruleY([0], { stroke: '#d1d5db' }),
        Plot.line(rows, { x: 't', y: 'v', stroke: roi.isSoma ? SOMA_COLOR : NONSOMA_COLOR, strokeWidth: 0.7 }),
      ],
    });
    tracePlot.replaceChildren(fig);

    lastTrace = { roi, series, ts, y };
    _renderPsth();
  }

  // ---- Behavioral events + PSTH ---------------------------------------
  async function _loadBehaviorEvents() {
    try {
      behEvents = await loadBehaviorEvents(coord, rawAssetName, { signal: ctrl.signal });
    } catch (err) {
      console.warn('[pophys] behavior events unavailable', err);
      behEvents = null;
    }
    if (ctrl.signal.aborted || !behEvents) return;
    behEventStreams = [
      { key: 'change', label: 'stimulus change', times: behEvents.changes },
      { key: 'reward', label: 'reward', times: behEvents.rewards },
      ...(behEvents.licks ? [{ key: 'lick', label: 'lick', times: behEvents.licks }] : []),
    ].filter((s) => s.times && s.times.length);
    if (!behEventStreams.length) return;
    psthEventSel.innerHTML = behEventStreams
      .map((s) => `<option value="${s.key}">${s.label} (n=${s.times.length})</option>`)
      .join('');
    if (lastTrace) _renderPsth();
  }

  function _renderPsth() {
    if (!behEventStreams.length || !lastTrace) { psthEl.hidden = true; return; }
    const stream = behEventStreams.find((s) => s.key === psthEventSel.value) ?? behEventStreams[0];
    const { ts, y, roi } = lastTrace;
    const psth = _computePsth(ts, y, stream.times, PSTH_PRE, PSTH_POST);
    if (!psth) { psthEl.hidden = true; return; }
    psthEl.hidden = false;

    const width = Math.max(320, psthPlot.clientWidth || 520);
    const fig = Plot.plot({
      width,
      height: 180,
      marginLeft: 52,
      marginBottom: 34,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      x: { label: `time from ${stream.label} (s) →` },
      y: { label: TRACE_LABELS[lastTrace.series], grid: true },
      marks: [
        Plot.ruleX([0], { stroke: '#ef4444' }),
        Plot.ruleY([0], { stroke: '#e5e7eb' }),
        Plot.areaY(psth, { x: 'lag', y1: 'lo', y2: 'hi', fill: roi.isSoma ? SOMA_COLOR : NONSOMA_COLOR, fillOpacity: 0.2 }),
        Plot.line(psth, { x: 'lag', y: 'mean', stroke: roi.isSoma ? SOMA_COLOR : NONSOMA_COLOR, strokeWidth: 1.4 }),
      ],
    });
    psthPlot.replaceChildren(fig);
  }

  /** Event-triggered average of a trace. Returns rows { lag, mean, lo, hi }. */
  function _computePsth(ts, y, events, pre, post) {
    const n = ts.length;
    if (n < 2 || !events.length) return null;
    const dt = (ts[n - 1] - ts[0]) / (n - 1);
    if (!(dt > 0)) return null;
    const nBins = Math.round((pre + post) / dt);
    if (nBins < 2) return null;

    const sum = new Float64Array(nBins);
    const sumSq = new Float64Array(nBins);
    const cnt = new Int32Array(nBins);
    for (const e of events) {
      if (!Number.isFinite(e)) continue;
      const i0 = Math.round((e - pre - ts[0]) / dt);
      if (i0 < 0 || i0 + nBins > n) continue; // skip events too near an edge
      for (let b = 0; b < nBins; b++) {
        const v = y[i0 + b];
        if (!Number.isFinite(v)) continue;
        sum[b] += v; sumSq[b] += v * v; cnt[b]++;
      }
    }
    const rows = [];
    for (let b = 0; b < nBins; b++) {
      if (!cnt[b]) continue;
      const mean = sum[b] / cnt[b];
      const varr = Math.max(0, sumSq[b] / cnt[b] - mean * mean);
      const sem = Math.sqrt(varr / cnt[b]);
      rows.push({ lag: -pre + b * dt, mean, lo: mean - sem, hi: mean + sem });
    }
    return rows.length ? rows : null;
  }

  return root;
}

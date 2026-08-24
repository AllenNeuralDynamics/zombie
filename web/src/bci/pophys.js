/**
 * bci/pophys.js — BCI-local population-ophys viewer.
 *
 * It intentionally uses the established pophys viewer class names and visual
 * arrangement, but its data source is the BCI behavior NWB-Zarr adapter in
 * ./pophys-data.js. That keeps the ordinary multiplane pophys path isolated
 * from this single-plane, nested-NWB layout.
 */

import * as Plot from '@observablehq/plot';
import { buildPsthPlot } from '../lib/psth.js';
import { loadPophysRois } from '../pophys/cache.js';
import { bciProjectionUrl } from './data.js';
import { bciPsthEvents, computeBciPsth, BCI_PSTH_POST, BCI_PSTH_PRE } from './psth.js';
import {
  bciTraceTime,
  bciUnit,
  indexBciCachedRois,
  loadBciPophysMeta,
  loadBciRoiMask,
  loadBciRoiTrace,
  openBciBehaviorNwb,
} from './pophys-data.js';

const FULL_TRACE_POINTS = 3600;
const ZOOM_PRE = 4;
const ZOOM_POST = 4;
const MASK_COLOR = [239, 68, 68];
const SOMA_COLOR = '#3b82f6';
const NONSOMA_COLOR = '#f59e0b';
const PLOT_WIDTH = 520;
const SESSION_PLOT_HEIGHT = 100;
const CURRENT_PLOT_HEIGHT = 220;
const PSTH_PLOT_HEIGHT = 180;

function decimate(trace, meta, sessionClockStart) {
  if (!trace?.length) return [];
  const block = Math.max(1, Math.ceil(trace.length / FULL_TRACE_POINTS));
  const rows = [];
  for (let start = 0; start < trace.length; start += block) {
    const stop = Math.min(trace.length, start + block);
    let sum = 0;
    let count = 0;
    for (let i = start; i < stop; i++) {
      const value = Number(trace[i]);
      if (Number.isFinite(value)) { sum += value; count++; }
    }
    if (count) {
      rows.push({
        t: bciTraceTime(meta, (start + stop - 1) / 2, sessionClockStart),
        v: sum / count,
      });
    }
  }
  return rows;
}

function maskImage(mask, width, height) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const values = mask.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = Number(values[y * width + x]);
      if (!(value > 0)) continue;
      const alpha = Math.round(60 + Math.min(1, value) * 165);
      const offset = (y * width + x) * 4;
      pixels[offset] = MASK_COLOR[0];
      pixels[offset + 1] = MASK_COLOR[1];
      pixels[offset + 2] = MASK_COLOR[2];
      pixels[offset + 3] = alpha;
    }
  }
  return new ImageData(pixels, width, height);
}

function formatUnit(unit) {
  const type = unit.isSoma == null ? '' : unit.isSoma ? ' · soma' : ' · non-soma';
  const prob = unit.somaProbability != null ? ` · soma p=${unit.somaProbability.toFixed(2)}` : '';
  return `ROI ${unit.id}${type}${prob}`;
}

function traceDomain(trace) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const raw of trace ?? []) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-1, 1];
  if (lo === hi) {
    const pad = Math.max(1, Math.abs(lo) * 0.05);
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

/**
 * Create a BCI pophys panel and return its playback-link API.
 *
 * @param {object} coord - DuckDB coordinator used to read the ROI cache.
 * @param {object} data - result of loadBciSession()
 * @returns {{element: HTMLElement, updateTime: (t:number)=>void, dispose:()=>void}}
 */
export function createBciPophysViewer(coord, data) {
  const root = document.createElement('section');
  root.className = 'pophys-viewer bci-pophys-viewer';
  root.innerHTML = `
    <div class="pophys-header">
      <h3 class="platform-summary-heading">Population optical physiology</h3>
      <div class="pophys-controls" hidden>
        <label>Unit <select class="bci-pophys-unit"></select></label>
      </div>
    </div>
    <div class="pophys-status">Loading BCI calcium data…</div>
    <div class="pophys-body" hidden>
      <div class="pophys-fov">
        <div class="bci-pophys-image-label">ROI masks</div>
        <div class="pophys-fov-stage">
          <canvas class="bci-pophys-mask" aria-label="selected ROI mask"></canvas>
          <svg class="pophys-fov-overlay" viewBox="0 0 512 256" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
        <div class="bci-pophys-image-label">Average projection</div>
        <div class="bci-pophys-average-stage">
          <img class="bci-pophys-average-img" alt="BCI average projection without ROI overlay" />
        </div>
        <div class="pophys-fov-caption"></div>
      </div>
      <div class="pophys-trace">
        <div class="pophys-trace-title">Select a unit to see its trace</div>
        <div class="bci-pophys-session-label">Session trace</div>
        <div class="bci-pophys-session-plot"></div>
        <div class="bci-pophys-current-label">Current playback window</div>
        <div class="bci-pophys-current-plot"></div>
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

  const q = (selector) => root.querySelector(selector);
  const statusEl = q('.pophys-status');
  const bodyEl = q('.pophys-body');
  const controlsEl = q('.pophys-controls');
  const unitSel = q('.bci-pophys-unit');
  const fovStage = q('.pophys-fov-stage');
  const averageImg = q('.bci-pophys-average-img');
  const maskCanvas = q('.bci-pophys-mask');
  const overlay = q('.pophys-fov-overlay');
  const captionEl = q('.pophys-fov-caption');
  const traceTitle = q('.pophys-trace-title');
  const sessionPlot = q('.bci-pophys-session-plot');
  const currentPlot = q('.bci-pophys-current-plot');
  const psthEl = q('.pophys-psth');
  const psthEventSel = q('.pophys-psth-event');
  const psthPlot = q('.pophys-psth-plot');

  const ctrl = new AbortController();
  let meta = null;
  let selectedTrace = null;
  let selectedYDomain = [-1, 1];
  let selectedIndex = -1;
  let cachedRois = [];
  let psthStreams = [];
  let currentTime = 0;
  let requestId = 0;

  const setStatus = (text, error = false) => {
    statusEl.textContent = text;
    statusEl.hidden = !text;
    statusEl.classList.toggle('pophys-status--error', error);
  };

  function renderMask(mask) {
    const width = Number(meta.maskShape?.[2] ?? 512);
    const height = Number(meta.maskShape?.[1] ?? 256);
    const sourceHeight = Number(mask.shape?.[0] ?? height);
    const sourceWidth = Number(mask.shape?.[1] ?? width);
    if (!(width > 0 && height > 0 && sourceWidth > 0 && sourceHeight > 0)) return;
    // Keep the displayed mask surface fixed even if a Zarr slice reports a
    // different per-ROI shape. The SVG hit layer and the average image below
    // must stay anchored to the same session FOV geometry.
    maskCanvas.width = width;
    maskCanvas.height = height;
    const context = maskCanvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    context.putImageData(maskImage(mask, sourceWidth, sourceHeight), 0, 0);
  }

  function renderCachedRois() {
    const width = Number(meta.maskShape?.[2] ?? 512);
    const height = Number(meta.maskShape?.[1] ?? 256);
    overlay.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const ns = 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    for (const roi of indexBciCachedRois(meta, cachedRois)) {
      if (!roi.contour?.length) continue;
      const polygon = document.createElementNS(ns, 'polygon');
      polygon.setAttribute('points', roi.contour.map((p) => `${p[0]},${p[1]}`).join(' '));
      polygon.setAttribute('class', `pophys-roi${roi.isSoma ? ' pophys-roi--soma' : ''}`);
      polygon.style.stroke = roi.isSoma ? SOMA_COLOR : NONSOMA_COLOR;
      polygon.dataset.roiId = String(roi.id);
      polygon.title = `ROI ${roi.id}`;
      polygon.addEventListener('click', () => loadSelectedUnit(roi.index));
      frag.appendChild(polygon);
    }
    overlay.replaceChildren(frag);
    syncCachedSelection();
  }

  function syncCachedSelection() {
    for (const polygon of overlay.querySelectorAll('.pophys-roi--selected')) {
      polygon.classList.remove('pophys-roi--selected');
    }
    if (selectedIndex < 0) return;
    const id = meta?.roiIds?.[selectedIndex];
    [...overlay.querySelectorAll('.pophys-roi')]
      .find((polygon) => polygon.dataset.roiId === String(id))
      ?.classList.add('pophys-roi--selected');
  }

  function renderTracePlots() {
    if (!selectedTrace || !meta) return;
    const width = PLOT_WIDTH;
    const sessionRows = decimate(selectedTrace, meta, data.sessionClockStart);
    const color = '#ef4444';
    const common = {
      width,
      marginLeft: 52,
      marginRight: 12,
      marginBottom: 30,
      style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
      y: { label: 'dF/F (%)', grid: true, domain: selectedYDomain },
    };
    sessionPlot.replaceChildren(Plot.plot({
      ...common,
      height: SESSION_PLOT_HEIGHT,
      marginTop: 6,
      x: { axis: null, domain: [0, data.sessionEnd] },
      marks: [
        Plot.line(sessionRows, { x: 't', y: 'v', stroke: '#64748b', strokeWidth: 0.8 }),
        Plot.ruleX([currentTime], { stroke: color, strokeWidth: 1.4 }),
      ],
    }));

    const traceStart = bciTraceTime(meta, 0, data.sessionClockStart);
    const traceEnd = bciTraceTime(meta, selectedTrace.length - 1, data.sessionClockStart);
    const lo = Math.max(traceStart, currentTime - ZOOM_PRE);
    const hi = Math.min(traceEnd, currentTime + ZOOM_POST);
    const i0 = Math.max(0, Math.floor((lo - traceStart) * meta.frameRate));
    const i1 = Math.min(selectedTrace.length, Math.ceil((hi - traceStart) * meta.frameRate) + 1);
    const zoomRows = [];
    for (let i = i0; i < i1; i++) {
      const value = Number(selectedTrace[i]);
      if (Number.isFinite(value)) zoomRows.push({
        t: bciTraceTime(meta, i, data.sessionClockStart),
        v: value,
      });
    }
    const domainLo = Math.min(lo, currentTime - ZOOM_PRE);
    const domainHi = Math.max(hi, currentTime + ZOOM_POST);
    currentPlot.replaceChildren(Plot.plot({
      ...common,
      height: CURRENT_PLOT_HEIGHT,
      marginTop: 8,
      x: { label: 'session time (s) →', domain: [domainLo, domainHi], grid: true },
      marks: [
        Plot.ruleY([0], { stroke: '#d1d5db' }),
        Plot.line(zoomRows, { x: 't', y: 'v', stroke: color, strokeWidth: 1 }),
        Plot.ruleX([currentTime], { stroke: color, strokeWidth: 1.5 }),
      ],
    }));
    renderPsth();
  }

  function renderPsth() {
    if (!selectedTrace || !meta || !psthStreams.length) {
      psthEl.hidden = true;
      return;
    }
    const stream = psthStreams.find((item) => item.key === psthEventSel.value) ?? psthStreams[0];
    const result = computeBciPsth(
      selectedTrace,
      meta,
      data.sessionClockStart,
      stream.times,
      { pre: BCI_PSTH_PRE, post: BCI_PSTH_POST },
    );
    if (!result) {
      psthEl.hidden = true;
      return;
    }
    psthEl.hidden = false;
    const width = PLOT_WIDTH;
    psthPlot.replaceChildren(buildPsthPlot(result.rows, {
      pre: -BCI_PSTH_PRE,
      post: BCI_PSTH_POST,
      width,
      height: PSTH_PLOT_HEIGHT,
      xLabel: `time from ${stream.label} (s) →`,
      yLabel: 'dF/F (%)',
      stroke: '#ef4444',
      fill: '#ef4444',
    }));
  }

  function updateTime(t) {
    currentTime = Math.max(0, Number(t) || 0);
    if (selectedTrace) renderTracePlots();
  }

  async function loadSelectedUnit(index) {
    if (!meta) return;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= meta.nRoi) return;
    selectedIndex = i;
    unitSel.value = String(i);
    syncCachedSelection();
    const unit = bciUnit(meta, i);
    const req = ++requestId;
    traceTitle.textContent = `Loading ${formatUnit(unit)}…`;
    captionEl.textContent = `${meta.nRoi.toLocaleString()} units · loading mask for ${formatUnit(unit)}`
      + (cachedRois.length ? ` · ${cachedRois.length} clickable cached ROIs` : '');
    maskCanvas.getContext('2d').clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    const [traceResult, maskResult] = await Promise.allSettled([
      loadBciRoiTrace(meta, i, { signal: ctrl.signal }),
      loadBciRoiMask(meta, i, { signal: ctrl.signal }),
    ]);
    if (ctrl.signal.aborted || req !== requestId) return;
    if (traceResult.status === 'rejected') {
      traceTitle.textContent = `Failed to load ${formatUnit(unit)}: ${traceResult.reason?.message ?? traceResult.reason}`;
      return;
    }
    selectedTrace = traceResult.value;
    selectedYDomain = traceDomain(selectedTrace);
    if (maskResult.status === 'fulfilled') renderMask(maskResult.value);
    traceTitle.textContent = `${formatUnit(unit)} · linked to playback time`;
    captionEl.textContent = `${meta.nRoi.toLocaleString()} units · mask for ${formatUnit(unit)}`
      + (cachedRois.length ? ` · ${cachedRois.length} clickable cached ROIs` : '');
    renderTracePlots();
  }

  async function load() {
    try {
      const nwbRoot = openBciBehaviorNwb(data.behaviorBase);
      meta = await loadBciPophysMeta(nwbRoot, { signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      if (!(meta.nRoi > 0)) throw new Error('BCI NWB contains no ROI traces');

      try {
        const result = await loadPophysRois(coord, data.asset);
        cachedRois = result.planes.flatMap((plane) => plane.rois);
      } catch (err) {
        console.warn('[bci-pophys] ROI contour cache unavailable; using the unit picker', err);
      }
      psthStreams = bciPsthEvents(data);
      psthEventSel.innerHTML = psthStreams
        .map((stream) => `<option value="${stream.key}">${stream.label} (n=${stream.times.length})</option>`)
        .join('');

      const width = Number(meta.maskShape?.[2] ?? 512);
      const height = Number(meta.maskShape?.[1] ?? 256);
      fovStage.style.aspectRatio = `${width} / ${height}`;
      renderCachedRois();
      averageImg.src = bciProjectionUrl(data.processingBase, 'average');
      averageImg.onerror = () => {
        const fallback = bciProjectionUrl(data.processingBase, 'maximum');
        if (fallback && averageImg.src !== fallback) averageImg.src = fallback;
      };

      const targetId = Number(data.target?.roi);
      const targetIndex = Number.isFinite(targetId) ? meta.roiIds.indexOf(targetId) : -1;
      unitSel.replaceChildren();
      for (let i = 0; i < meta.nRoi; i++) {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = `ROI ${meta.roiIds[i] ?? i}`;
        if (i === (targetIndex >= 0 ? targetIndex : 0)) option.selected = true;
        unitSel.appendChild(option);
      }
      unitSel.onchange = () => loadSelectedUnit(unitSel.value);
      psthEventSel.onchange = renderPsth;
      controlsEl.hidden = false;
      bodyEl.hidden = false;
      setStatus('');
      await loadSelectedUnit(targetIndex >= 0 ? targetIndex : 0);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setStatus(`BCI pophys unavailable: ${err.message}`, true);
    }
  }

  load();

  let resizeObserver = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => { if (selectedTrace) renderTracePlots(); });
    resizeObserver.observe(q('.pophys-trace'));
  }

  return {
    element: root,
    updateTime,
    dispose() {
      ctrl.abort();
      resizeObserver?.disconnect();
    },
  };
}

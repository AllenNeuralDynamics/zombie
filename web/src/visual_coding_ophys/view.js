/**
 * Visual Coding Ophys viewer for canonical Allen Brain Observatory sessions.
 *
 * This is deliberately not a branch inside pophys/view.js. These assets have
 * one legacy ``ophys`` plane, sparse pixel masks, and DfOverF traces under a
 * different NWB hierarchy.
 */

import * as Plot from '@observablehq/plot';
import { loadVisualCodingOphysRois, visualCodingOphysFovUrl } from './cache.js';
import {
  loadVisualCodingOphysMeta,
  loadVisualCodingOphysTrace,
  openVisualCodingOphysNwb,
} from './data.js';

const SOMA_COLOR = '#3b82f6';
const ROI_COLOR = '#f59e0b';
const MAX_PLOT_POINTS = 4000;

function decimate(timestamps, values) {
  const count = Math.min(timestamps.length, values.length);
  const block = Math.max(1, Math.ceil(count / MAX_PLOT_POINTS));
  const rows = [];
  for (let start = 0; start < count; start += block) {
    const stop = Math.min(count, start + block);
    let sum = 0;
    let n = 0;
    for (let index = start; index < stop; index++) {
      const value = Number(values[index]);
      if (Number.isFinite(value)) { sum += value; n++; }
    }
    if (n) rows.push({ t: Number(timestamps[Math.floor((start + stop - 1) / 2)]), v: sum / n });
  }
  return rows;
}

export function createVisualCodingOphysViewer(coord, event) {
  const root = document.createElement('section');
  root.className = 'pophys-viewer visual-coding-ophys-viewer';
  root.innerHTML = `
    <div class="pophys-header">
      <h3 class="platform-summary-heading">Visual Coding population optical physiology</h3>
      <div class="pophys-controls" hidden>
        <label>ROI <select class="visual-coding-ophys-roi"></select></label>
        <label>Trace <select class="visual-coding-ophys-series">
          <option value="dff">dF/F</option>
          <option value="events">events</option>
        </select></label>
      </div>
    </div>
    <div class="pophys-status">Loading Visual Coding Ophys data…</div>
    <div class="pophys-body" hidden>
      <div class="pophys-fov">
        <div class="pophys-fov-stage">
          <img class="pophys-fov-img" alt="Visual Coding field of view" />
          <svg class="pophys-fov-overlay" viewBox="0 0 512 512" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
        <div class="pophys-fov-caption"></div>
      </div>
      <div class="pophys-trace">
        <div class="pophys-trace-title">Select an ROI to see its trace</div>
        <div class="pophys-trace-plot"></div>
      </div>
    </div>
  `;

  const q = (selector) => root.querySelector(selector);
  const statusEl = q('.pophys-status');
  const bodyEl = q('.pophys-body');
  const controlsEl = q('.pophys-controls');
  const roiSel = q('.visual-coding-ophys-roi');
  const seriesSel = q('.visual-coding-ophys-series');
  const fovImg = q('.pophys-fov-img');
  const overlay = q('.pophys-fov-overlay');
  const captionEl = q('.pophys-fov-caption');
  const traceTitle = q('.pophys-trace-title');
  const tracePlot = q('.pophys-trace-plot');

  const ctrl = new AbortController();
  const assetName = event?.data?._assetName ?? null;
  let rois = [];
  let nwbRoot = null;
  let meta = null;
  let requestId = 0;

  const setStatus = (message, error = false) => {
    statusEl.textContent = message;
    statusEl.hidden = !message;
    statusEl.classList.toggle('pophys-status--error', error);
  };

  function renderOverlay() {
    const ns = 'http://www.w3.org/2000/svg';
    const fragment = document.createDocumentFragment();
    for (const roi of rois) {
      if (!roi.contour?.length) continue;
      const polygon = document.createElementNS(ns, 'polygon');
      polygon.setAttribute('points', roi.contour.map(([x, y]) => `${x},${y}`).join(' '));
      polygon.setAttribute('class', 'pophys-roi');
      polygon.style.stroke = ROI_COLOR;
      polygon.dataset.roiId = String(roi.id);
      polygon.title = `ROI ${roi.id}`;
      polygon.addEventListener('click', () => {
        roiSel.value = String(roi.id);
        loadTrace(roi);
      });
      fragment.appendChild(polygon);
    }
    overlay.replaceChildren(fragment);
  }

  function selectOverlay(roiId) {
    for (const polygon of overlay.querySelectorAll('.pophys-roi')) {
      polygon.classList.toggle('pophys-roi--selected', polygon.dataset.roiId === String(roiId));
    }
  }

  async function loadTrace(roi) {
    if (!nwbRoot || !meta) return;
    const request = ++requestId;
    const series = seriesSel.value;
    const traceIndex = meta.roiIds.indexOf(roi.id);
    if (traceIndex < 0) {
      traceTitle.textContent = `ROI ${roi.id} is not present in the DfOverF trace table.`;
      return;
    }
    selectOverlay(roi.id);
    traceTitle.textContent = `Loading ${series === 'events' ? 'events' : 'dF/F'} for ROI ${roi.id}…`;
    try {
      const values = await loadVisualCodingOphysTrace(nwbRoot, traceIndex, series, { signal: ctrl.signal });
      if (ctrl.signal.aborted || request !== requestId) return;
      const rows = decimate(meta.timestamps, values);
      const width = Math.max(320, tracePlot.clientWidth || 520);
      tracePlot.replaceChildren(Plot.plot({
        width,
        height: 220,
        marginLeft: 52,
        marginBottom: 34,
        style: { background: 'transparent', fontFamily: 'inherit', fontSize: '11px' },
        x: { label: 'session time (s) →' },
        y: { label: series === 'events' ? 'events' : 'dF/F', grid: true },
        marks: [
          Plot.ruleY([0], { stroke: '#d1d5db' }),
          Plot.line(rows, { x: 't', y: 'v', stroke: series === 'events' ? SOMA_COLOR : ROI_COLOR, strokeWidth: 0.8 }),
        ],
      }));
      traceTitle.textContent = `ROI ${roi.id} · ${series === 'events' ? 'events' : 'dF/F'}`;
    } catch (error) {
      if (ctrl.signal.aborted || request !== requestId) return;
      traceTitle.textContent = `Failed to load ROI ${roi.id}: ${error.message}`;
    }
  }

  (async () => {
    if (!assetName) { setStatus('No acquisition asset for this event.', true); return; }
    try {
      rois = await loadVisualCodingOphysRois(coord, assetName);
      if (ctrl.signal.aborted) return;
      if (!rois.length) throw new Error('No cached Visual Coding Ophys ROI masks found for this asset');

      fovImg.src = visualCodingOphysFovUrl(assetName);
      renderOverlay();
      roiSel.innerHTML = rois.map((roi) => `<option value="${roi.id}">ROI ${roi.id}</option>`).join('');
      const first = rois[0];
      const depth = first.depthUm != null ? ` · ${first.depthUm} µm` : '';
      captionEl.textContent = `${first.structure ?? 'ophys'}${depth} · ${rois.length} ROIs`;

      try {
        nwbRoot = await openVisualCodingOphysNwb(assetName, { signal: ctrl.signal });
        meta = await loadVisualCodingOphysMeta(nwbRoot, { signal: ctrl.signal });
        seriesSel.disabled = !meta.eventsAvailable;
        if (!meta.eventsAvailable) seriesSel.value = 'dff';
      } catch (error) {
        console.warn('[visual-coding-ophys] trace data unavailable', error);
      }

      roiSel.onchange = () => {
        const roi = rois.find((candidate) => candidate.id === Number(roiSel.value));
        if (roi) loadTrace(roi);
      };
      seriesSel.onchange = () => {
        const roi = rois.find((candidate) => candidate.id === Number(roiSel.value));
        if (roi) loadTrace(roi);
      };
      controlsEl.hidden = false;
      bodyEl.hidden = false;
      setStatus('');
      if (nwbRoot && meta) loadTrace(first);
    } catch (error) {
      if (ctrl.signal.aborted) return;
      console.error('[visual-coding-ophys] load failed', error);
      setStatus(`Visual Coding Ophys unavailable: ${error.message}`, true);
    }
  })();

  return root;
}

/**
 * lib/behaviors/brush-overview.js — the shared zoomable overview + brush strip
 * used by the behavior playback plots (Dynamic Routing, Dynamic Foraging, VR
 * Foraging, mFISH).
 *
 * Historically each of those plots carried its own copy of this machinery. This
 * module is the single implementation: a context strip on top with a brush you
 * can create (drag), resize (drag either edge) and pan (drag the middle), plus
 * a synced playhead and a click/drag-to-seek overlay on the main panel(s).
 *
 * The caller owns the actual marks: it supplies `renderOverview(holder, width)`
 * and `renderMain(holder, width, [t0, t1])` callbacks that draw Observable Plot
 * figures into the provided holders. The caller MUST use the same `margin`
 * (left/right) in its figures so the brush lines up with the data.
 *
 *   const bz = createBrushOverview({ sessionEndS, margin, renderOverview, renderMain, ... });
 *   container.appendChild(bz.element);
 *   bz.mainWrap;               // for absolutely-positioned row labels
 *   bz.setOnScrub((t) => …);   // click/drag to seek
 *   bz.setOnDomainChange(([t0, t1]) => …); // brush zoom/pan notifications
 *   bz.updatePlayhead(t);      // move the playhead
 *   bz.dispose();
 */

const BRUSH_HANDLE_PX = 8;

/**
 * @param {object} config
 * @param {number} config.sessionEndS
 * @param {{left:number,right:number}} config.margin
 * @param {(holder:HTMLElement, width:number) => void} config.renderOverview
 * @param {(holder:HTMLElement, width:number, domain:[number,number]) => void} config.renderMain
 * @param {number} [config.overviewHeight=34]
 * @param {number} [config.minPlotW=320]
 * @param {{top:number,bottom:number}} [config.scrubInset] px inset of the scrub
 *   overlay + main playhead within the main panel (align to plot inner area).
 * @param {string} [config.playheadColor='#222']
 * @param {string} [config.wrapperClass]
 */
export function createBrushOverview(config) {
  const {
    sessionEndS,
    margin,
    renderOverview,
    renderMain,
    overviewHeight = 34,
    minPlotW = 320,
    scrubInset = { top: 0, bottom: 0 },
    playheadColor = '#222',
    wrapperClass = '',
    headerEl = null,
  } = config;

  const end = sessionEndS > 0 ? sessionEndS : 1;

  // ---- DOM scaffold ----------------------------------------------------
  const wrapper = document.createElement('div');
  wrapper.className = `pbz-wrap${wrapperClass ? ` ${wrapperClass}` : ''}`;

  // Optional caller-supplied header (e.g. a legend) above the overview strip.
  if (headerEl) wrapper.appendChild(headerEl);

  const overviewWrap = document.createElement('div');
  overviewWrap.className = 'pbz-overview-wrap';
  wrapper.appendChild(overviewWrap);

  const overviewHolder = document.createElement('div');
  overviewHolder.className = 'pbz-overview-holder';
  overviewWrap.appendChild(overviewHolder);

  const dimLeft = document.createElement('div');
  const dimRight = document.createElement('div');
  dimLeft.className = 'pbz-brush-dim';
  dimRight.className = 'pbz-brush-dim';
  overviewWrap.appendChild(dimLeft);
  overviewWrap.appendChild(dimRight);

  const overviewInteract = document.createElement('div');
  overviewInteract.className = 'pbz-brush-interact';
  overviewInteract.title = 'Drag to zoom · drag the window to pan · double-click to reset';
  overviewWrap.appendChild(overviewInteract);

  const overviewPlayhead = document.createElement('div');
  Object.assign(overviewPlayhead.style, {
    position: 'absolute', top: '0', bottom: '0', width: '1.5px',
    background: '#555', pointerEvents: 'none',
    transform: 'translateX(-0.75px)', left: '0', display: 'none',
  });
  overviewWrap.appendChild(overviewPlayhead);

  const mainWrap = document.createElement('div');
  mainWrap.className = 'pbz-main-wrap';
  mainWrap.style.position = 'relative';
  wrapper.appendChild(mainWrap);

  const mainHolder = document.createElement('div');
  mainWrap.appendChild(mainHolder);

  const playhead = document.createElement('div');
  Object.assign(playhead.style, {
    position: 'absolute', top: `${scrubInset.top}px`, bottom: `${scrubInset.bottom}px`,
    width: '1.5px', background: playheadColor, pointerEvents: 'none',
    transform: 'translateX(-0.75px)', left: '0', display: 'none',
  });
  mainWrap.appendChild(playhead);

  const scrubOverlay = document.createElement('div');
  Object.assign(scrubOverlay.style, {
    position: 'absolute', top: `${scrubInset.top}px`, bottom: `${scrubInset.bottom}px`,
    left: `${margin.left}px`, right: `${margin.right}px`, cursor: 'crosshair',
  });
  mainWrap.appendChild(scrubOverlay);

  // ---- State -----------------------------------------------------------
  let innerWidth = 0;
  let overviewInnerWidth = 0;
  let scrubCb = null;
  let domainCb = null;
  let lastT = 0;
  let lastW = 0;
  let brushT0 = 0;
  let brushT1 = end;
  let dragState = null;
  let pendingRebuild = false;

  const _pxToTime = (px) =>
    Math.max(0, Math.min(end, (px / (overviewInnerWidth || 1)) * end));

  const _brushEdgePx = () => ({
    left: (brushT0 / end) * overviewInnerWidth,
    right: (brushT1 / end) * overviewInnerWidth,
  });

  function _updateBrushVisual() {
    if (overviewInnerWidth <= 0) return;
    const x0 = (brushT0 / end) * overviewInnerWidth;
    const x1 = (brushT1 / end) * overviewInnerWidth;
    Object.assign(dimLeft.style, { left: `${margin.left}px`, width: `${Math.max(0, x0)}px` });
    Object.assign(dimRight.style, {
      left: `${margin.left + x1}px`,
      width: `${Math.max(0, overviewInnerWidth - x1)}px`,
    });
  }

  function _placeOverviewPlayhead() {
    if (end <= 0 || overviewInnerWidth <= 0) return;
    const frac = Math.max(0, Math.min(1, lastT / end));
    overviewPlayhead.style.left = `${margin.left + frac * overviewInnerWidth}px`;
    overviewPlayhead.style.display = '';
  }

  function _placePlayhead() {
    const range = brushT1 - brushT0;
    if (range <= 0 || innerWidth <= 0) { playhead.style.display = 'none'; return; }
    const frac = (lastT - brushT0) / range;
    if (frac < 0 || frac > 1) { playhead.style.display = 'none'; return; }
    playhead.style.left = `${margin.left + frac * innerWidth}px`;
    playhead.style.display = '';
  }

  function _rebuildOverview(w) {
    overviewInnerWidth = w - margin.left - margin.right;
    renderOverview(overviewHolder, w);
    Object.assign(overviewInteract.style, {
      position: 'absolute', top: '0', bottom: '0',
      left: `${margin.left}px`, width: `${overviewInnerWidth}px`,
    });
    _updateBrushVisual();
    _placeOverviewPlayhead();
  }

  function _rebuildMain(w) {
    innerWidth = w - margin.left - margin.right;
    renderMain(mainHolder, w, [brushT0, brushT1]);
    _placePlayhead();
  }

  function _rebuild(w) {
    _rebuildMain(w);
  }

  // ---- Brush interactions (create / resize / pan) ----------------------
  overviewInteract.addEventListener('pointermove', (ev) => {
    const rect = overviewInteract.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const t = _pxToTime(px);

    if (dragState) {
      if (dragState.type === 'new') {
        brushT0 = Math.min(t, dragState.startT);
        brushT1 = Math.max(t, dragState.startT);
      } else if (dragState.type === 'left' || dragState.type === 'right') {
        brushT0 = Math.min(t, dragState.anchor);
        brushT1 = Math.max(t, dragState.anchor);
      } else if (dragState.type === 'move') {
        const span = dragState.origT1 - dragState.origT0;
        const delta = t - dragState.anchorT;
        brushT0 = Math.max(0, Math.min(end - span, dragState.origT0 + delta));
        brushT1 = brushT0 + span;
      }
      _updateBrushVisual();
      if (!pendingRebuild) {
        pendingRebuild = true;
        requestAnimationFrame(() => { pendingRebuild = false; _rebuildMain(lastW); });
      }
    } else {
      const { left: bL, right: bR } = _brushEdgePx();
      if (Math.abs(px - bL) <= BRUSH_HANDLE_PX || Math.abs(px - bR) <= BRUSH_HANDLE_PX) {
        overviewInteract.style.cursor = 'ew-resize';
      } else if (px >= bL && px <= bR && (brushT0 > 0 || brushT1 < end - 0.5)) {
        overviewInteract.style.cursor = 'grab';
      } else {
        overviewInteract.style.cursor = 'crosshair';
      }
    }
  });

  overviewInteract.addEventListener('pointerdown', (ev) => {
    overviewInteract.setPointerCapture(ev.pointerId);
    const rect = overviewInteract.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const t = _pxToTime(px);
    const { left: bL, right: bR } = _brushEdgePx();

    if (Math.abs(px - bL) <= BRUSH_HANDLE_PX) {
      dragState = { type: 'left', anchor: brushT1 };
    } else if (Math.abs(px - bR) <= BRUSH_HANDLE_PX) {
      dragState = { type: 'right', anchor: brushT0 };
    } else if (px >= bL && px <= bR && (brushT0 > 0 || brushT1 < end - 0.5)) {
      dragState = { type: 'move', anchorT: t, origT0: brushT0, origT1: brushT1 };
      overviewInteract.style.cursor = 'grabbing';
    } else {
      dragState = { type: 'new', startT: t };
      brushT0 = t; brushT1 = t;
      _updateBrushVisual();
    }
    ev.preventDefault();
  });

  overviewInteract.addEventListener('pointerup', () => {
    if (!dragState) return;
    dragState = null;
    if (brushT1 - brushT0 < 2) { brushT0 = 0; brushT1 = end; }
    overviewInteract.style.cursor = 'crosshair';
    _updateBrushVisual();
    _rebuildMain(lastW);
    domainCb?.([brushT0, brushT1]);
  });

  overviewInteract.addEventListener('dblclick', () => {
    brushT0 = 0; brushT1 = end;
    _updateBrushVisual();
    _rebuildMain(lastW);
    domainCb?.([brushT0, brushT1]);
  });

  // ---- Scrub (click / drag to seek on the main panel) ------------------
  function _seekAt(clientX) {
    if (!scrubCb || innerWidth <= 0) return;
    const rect = scrubOverlay.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    scrubCb(brushT0 + frac * (brushT1 - brushT0));
  }
  let scrubbing = false;
  scrubOverlay.addEventListener('pointerdown', (ev) => {
    scrubbing = true;
    scrubOverlay.setPointerCapture?.(ev.pointerId);
    _seekAt(ev.clientX);
  });
  scrubOverlay.addEventListener('pointermove', (ev) => { if (scrubbing) _seekAt(ev.clientX); });
  const _endScrub = (ev) => { scrubbing = false; scrubOverlay.releasePointerCapture?.(ev.pointerId); };
  scrubOverlay.addEventListener('pointerup', _endScrub);
  scrubOverlay.addEventListener('pointercancel', _endScrub);

  // ---- Sizing ----------------------------------------------------------
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.max(minPlotW, Math.floor(e.contentRect.width));
      if (w !== lastW) { lastW = w; _rebuildOverview(w); _rebuild(w); }
    }
  });
  ro.observe(wrapper);

  queueMicrotask(() => {
    const w = Math.max(minPlotW, wrapper.clientWidth || 600);
    if (w !== lastW) { lastW = w; _rebuildOverview(w); _rebuild(w); }
  });

  return {
    element: wrapper,
    mainWrap,
    overviewWrap,
    updatePlayhead(t) { lastT = t; _placePlayhead(); _placeOverviewPlayhead(); },
    setOnScrub(cb) { scrubCb = cb; },
    setOnDomainChange(cb) { domainCb = cb; },
    setDomain(domain, { notify = false } = {}) {
      const t0 = Number(domain?.[0]);
      const t1 = Number(domain?.[1]);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
      brushT0 = Math.max(0, Math.min(end, t0));
      brushT1 = Math.max(0, Math.min(end, t1));
      if (brushT1 <= brushT0) { brushT0 = 0; brushT1 = end; }
      _updateBrushVisual();
      if (lastW) _rebuildMain(lastW);
      if (notify) domainCb?.([brushT0, brushT1]);
    },
    /** Force a main-panel redraw at the current width/zoom (e.g. after an
     *  external state change like an axis-mode toggle). */
    redrawMain() { if (lastW) _rebuildMain(lastW); },
    dispose() { ro.disconnect(); },
  };
}

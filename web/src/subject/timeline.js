/**
 * subject-timeline.js — Minimap + bubble-strip timeline for subject events.
 *
 * Layout:
 *   1. SVG minimap — all events as coloured rectangles on a time axis, with a
 *      draggable "window" rectangle that shows the visible portion of the bubbles.
 *   2. Horizontally-scrollable bubble strip — one pill per event showing its
 *      type and date.  Clicking a bubble fires the `onSelect` callback.
 *
 * The window and the bubble strip are bidirectionally synchronised: dragging
 * the window scrolls the strip and scrolling the strip moves the window.
 *
 * Pure helper `buildTimelineSvgParts` is exported for unit testing (Node-safe).
 */

import { EVENT_COLORS } from './parsers.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const MARGIN_TOP = 4;
const MARGIN_LEFT = 8;
const MARGIN_RIGHT = 8;
const RECT_HEIGHT = 20;
const PADDING_MS = 3 * 24 * 60 * 60 * 1000; // 3-day padding around events

const SVG_W = 900;
const SVG_H = 60;

// ---------------------------------------------------------------------------
// Pure helper (testable in Node)
// ---------------------------------------------------------------------------

function formatDateTick(date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

/**
 * Build SVG element data for the minimap overview without touching the DOM.
 *
 * @param {Array<{start:Date,end:Date,event:string,type:string}>} events
 * @param {number} totalWidth  - Full SVG width in px
 * @param {number} totalHeight - Full SVG height in px (unused, kept for API compat)
 * @returns {{
 *   sortedEvents: typeof events,
 *   rects: Array<{x:number,w:number,color:string,label:string,index:number}>,
 *   ticks: Array<{x:number,label:string}>,
 *   innerTop: number,
 * }}
 */
export function buildTimelineSvgParts(events, totalWidth, totalHeight) {
  if (!events.length) {
    return { sortedEvents: [], rects: [], ticks: [], innerTop: MARGIN_TOP };
  }

  const sorted = [...events].sort((a, b) => a.start - b.start);
  const tMin = Math.min(...sorted.map((e) => e.start.getTime())) - PADDING_MS;
  const tMax = Math.max(...sorted.map((e) => e.end.getTime())) + PADDING_MS;
  const innerW = totalWidth - MARGIN_LEFT - MARGIN_RIGHT;
  const rangeMs = tMax - tMin;
  const toX = (ms) => MARGIN_LEFT + ((ms - tMin) / rangeMs) * innerW;

  const rects = sorted.map((ev, i) => {
    const x = toX(ev.start.getTime());
    const x1 = toX(ev.end.getTime());
    const w = Math.max(x1 - x, 2);
    const color = EVENT_COLORS[ev.type] ?? '#888';
    const rawLabel = ev.event;
    const label = rawLabel.length > 20 ? rawLabel.slice(0, 18) + '…' : rawLabel;
    return { x, w, color, label, index: i };
  });

  // Monthly ticks
  const ticks = [];
  const cursor = new Date(Date.UTC(
    new Date(tMin).getUTCFullYear(),
    new Date(tMin).getUTCMonth(),
    1,
  ));
  while (cursor.getTime() <= tMax) {
    if (cursor.getTime() >= tMin) {
      ticks.push({ x: toX(cursor.getTime()), label: formatDateTick(cursor) });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  return { sortedEvents: sorted, rects, ticks, innerTop: MARGIN_TOP };
}

// ---------------------------------------------------------------------------
// DOM builder
// ---------------------------------------------------------------------------

/**
 * Create the combined minimap + bubble-strip timeline element.
 *
 * @param {Array<object>} events - Timeline event objects from buildTimelineEvents().
 * @param {object} [opts]
 * @param {(ev: object) => void} [opts.onSelect] - Called with the event object on click.
 * @returns {HTMLElement}
 */
export function createSubjectTimeline(events, opts = {}) {
  const { onSelect } = opts;

  const wrapper = document.createElement('div');
  wrapper.className = 'subject-timeline-wrapper';

  const sorted = [...events].sort((a, b) => a.start - b.start);

  if (!sorted.length) {
    const msg = document.createElement('p');
    msg.className = 'detail-placeholder';
    msg.textContent = 'No timeline events found.';
    wrapper.appendChild(msg);
    return wrapper;
  }

  const innerW = SVG_W - MARGIN_LEFT - MARGIN_RIGHT;
  const { rects, ticks } = buildTimelineSvgParts(sorted, SVG_W, SVG_H);

  // ── Minimap SVG ────────────────────────────────────────────────────────────
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${SVG_W} ${SVG_H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'subject-timeline');
  svg.style.display = 'block';

  // Tick marks + labels
  const tickY = MARGIN_TOP + RECT_HEIGHT + 2;
  for (const tick of ticks) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', tick.x.toFixed(1));
    line.setAttribute('y1', tickY.toString());
    line.setAttribute('x2', tick.x.toFixed(1));
    line.setAttribute('y2', (tickY + 4).toString());
    line.setAttribute('stroke', '#999');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', tick.x.toFixed(1));
    text.setAttribute('y', (tickY + 16).toString());
    text.setAttribute('font-size', '9');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', '#888');
    text.textContent = tick.label;
    svg.appendChild(text);
  }

  // Event rects (decorative markers — selection is done via the bubbles)
  for (const r of rects) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'timeline-event');
    rect.setAttribute('x', r.x.toFixed(1));
    rect.setAttribute('y', MARGIN_TOP.toString());
    rect.setAttribute('width', Math.max(r.w, 3).toFixed(1));
    rect.setAttribute('height', RECT_HEIGHT.toString());
    rect.setAttribute('fill', r.color);
    rect.setAttribute('rx', '2');
    rect.setAttribute('opacity', '0.75');
    svg.appendChild(rect);
  }

  // Draggable viewport window (rendered last → on top)
  const windowRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  windowRect.setAttribute('class', 'tl-window');
  windowRect.setAttribute('x', MARGIN_LEFT.toString());
  windowRect.setAttribute('y', '0');
  windowRect.setAttribute('width', '120');
  windowRect.setAttribute('height', SVG_H.toString());
  windowRect.setAttribute('rx', '3');
  windowRect.setAttribute('visibility', 'hidden');
  windowRect.style.cursor = 'grab';
  windowRect.style.pointerEvents = 'none';
  svg.appendChild(windowRect);

  wrapper.appendChild(svg);

  // ── Bubble strip ───────────────────────────────────────────────────────────
  const bubbleScroll = document.createElement('div');
  bubbleScroll.className = 'subject-timeline-bubbles';

  let selectedBubble = null;

  for (const ev of sorted) {
    const bubble = document.createElement('button');
    bubble.className = 'tl-bubble';
    bubble.style.setProperty('--bubble-color', EVENT_COLORS[ev.type] ?? '#888');

    const dot = document.createElement('span');
    dot.className = 'tl-bubble-dot';

    const typeEl = document.createElement('span');
    typeEl.className = 'tl-bubble-type';
    typeEl.textContent = ev.type;

    const dateEl = document.createElement('span');
    dateEl.className = 'tl-bubble-date';
    dateEl.textContent = ev.start.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: '2-digit',
    });

    bubble.appendChild(dot);
    bubble.appendChild(typeEl);
    bubble.appendChild(dateEl);

    bubble.addEventListener('click', () => {
      if (selectedBubble) selectedBubble.classList.remove('tl-bubble--selected');
      bubble.classList.add('tl-bubble--selected');
      selectedBubble = bubble;
      onSelect?.(ev);
    });

    bubbleScroll.appendChild(bubble);
  }

  wrapper.appendChild(bubbleScroll);

  // ── Bidirectional sync ─────────────────────────────────────────────────────
  let isDragging = false;
  let dragStartClientX = 0;
  let dragStartWinX = 0;

  function getWindowX() {
    return parseFloat(windowRect.getAttribute('x') || MARGIN_LEFT);
  }

  function getWindowW() {
    return parseFloat(windowRect.getAttribute('width') || '120');
  }

  function clampWindowX(x) {
    const winW = getWindowW();
    return Math.max(MARGIN_LEFT, Math.min(MARGIN_LEFT + innerW - winW, x));
  }

  /** Recalculate window position + size from the current bubble scroll state. */
  function updateWindowFromScroll() {
    const totalW = bubbleScroll.scrollWidth;
    const visibleW = bubbleScroll.clientWidth;
    if (totalW <= 0 || visibleW <= 0) return;

    // No overflow → hide the window entirely; the minimap is just decorative
    if (visibleW >= totalW) {
      windowRect.setAttribute('visibility', 'hidden');
      windowRect.style.pointerEvents = 'none';
      return;
    }

    windowRect.setAttribute('visibility', 'visible');
    windowRect.style.pointerEvents = 'all';

    const winW = Math.max((visibleW / totalW) * innerW, 16);
    const maxScroll = Math.max(totalW - visibleW, 1);
    const scrollFrac = bubbleScroll.scrollLeft / maxScroll;
    const winX = MARGIN_LEFT + scrollFrac * (innerW - winW);

    windowRect.setAttribute('width', winW.toFixed(1));
    windowRect.setAttribute('x', Math.max(MARGIN_LEFT, winX).toFixed(1));
  }

  /** Scroll the bubble strip so it matches the given window x position. */
  function scrollFromWindowX(winX) {
    const winW = getWindowW();
    const totalW = bubbleScroll.scrollWidth;
    const visibleW = bubbleScroll.clientWidth;
    const maxScroll = Math.max(totalW - visibleW, 0);
    const frac = Math.max(0, Math.min(1, (winX - MARGIN_LEFT) / Math.max(innerW - winW, 1)));
    bubbleScroll.scrollLeft = frac * maxScroll;
  }

  // Bubble scroll → window
  bubbleScroll.addEventListener('scroll', () => {
    if (!isDragging) updateWindowFromScroll();
  });

  // Click anywhere on the minimap to center the window there (only when scrollable)
  svg.addEventListener('click', (e) => {
    if (isDragging) return;
    if (windowRect.getAttribute('visibility') === 'hidden') return;
    const svgRect = svg.getBoundingClientRect();
    const scaleX = SVG_W / (svgRect.width || SVG_W);
    const clickX = (e.clientX - svgRect.left) * scaleX;
    const newX = clampWindowX(clickX - getWindowW() / 2);
    windowRect.setAttribute('x', newX.toFixed(1));
    scrollFromWindowX(newX);
  });

  // Drag window → scroll
  windowRect.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartClientX = e.clientX;
    dragStartWinX = getWindowX();
    windowRect.style.cursor = 'grabbing';
    e.preventDefault();
    e.stopPropagation(); // don't also trigger the svg click
  });

  function onMouseMove(e) {
    if (!isDragging) return;
    const svgRect = svg.getBoundingClientRect();
    const scaleX = SVG_W / (svgRect.width || SVG_W);
    const dx = (e.clientX - dragStartClientX) * scaleX;
    const newX = clampWindowX(dragStartWinX + dx);
    windowRect.setAttribute('x', newX.toFixed(1));
    scrollFromWindowX(newX);
  }

  function onMouseUp() {
    if (isDragging) {
      isDragging = false;
      windowRect.style.cursor = 'grab';
    }
  }

  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Touch support
  windowRect.addEventListener('touchstart', (e) => {
    isDragging = true;
    dragStartClientX = e.touches[0].clientX;
    dragStartWinX = getWindowX();
    e.preventDefault();
    e.stopPropagation();
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const svgRect = svg.getBoundingClientRect();
    const scaleX = SVG_W / (svgRect.width || SVG_W);
    const dx = (e.touches[0].clientX - dragStartClientX) * scaleX;
    const newX = clampWindowX(dragStartWinX + dx);
    windowRect.setAttribute('x', newX.toFixed(1));
    scrollFromWindowX(newX);
  });

  document.addEventListener('touchend', () => { isDragging = false; });

  // Initialise geometry after first browser layout pass
  requestAnimationFrame(updateWindowFromScroll);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(updateWindowFromScroll);
    ro.observe(bubbleScroll);
  }

  return wrapper;
}

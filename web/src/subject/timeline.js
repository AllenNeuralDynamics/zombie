/**
 * subject-timeline.js — SVG timeline for subject events.
 *
 * Renders each event as a horizontal coloured rectangle on a time axis.
 * Click a rectangle to fire the `onSelect` callback with the event object.
 *
 * Pure helper `buildTimelineSvgParts` is exported for unit testing (Node-safe).
 */

import { EVENT_COLORS } from './parsers.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const MARGIN_TOP = 10;
const MARGIN_BOTTOM = 50; // room for rotated date labels
const MARGIN_LEFT = 8;
const MARGIN_RIGHT = 8;
const RECT_HEIGHT = 24;
const PADDING_MS = 3 * 24 * 60 * 60 * 1000; // 3-day padding around events

// ---------------------------------------------------------------------------
// Pure helper (testable in Node)
// ---------------------------------------------------------------------------

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function formatDateTick(date) {
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

/**
 * Build SVG element data for the timeline without touching the DOM.
 *
 * Returns the information needed to construct SVG children: rect params,
 * tick params, and the sorted event list (so callers can map click indices
 * back to events).
 *
 * @param {Array<{start:Date,end:Date,event:string,type:string}>} events
 * @param {number} totalWidth  - Full SVG width in px
 * @param {number} totalHeight - Full SVG height in px
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
 * Create an inline SVG timeline element.
 *
 * @param {Array<object>} events - Timeline event objects from buildTimelineEvents().
 * @param {object} [opts]
 * @param {number}   [opts.width=900]
 * @param {number}   [opts.height=90]
 * @param {(ev: object) => void} [opts.onSelect] - Called with the event object on click.
 * @returns {SVGElement}
 */
export function createSubjectTimeline(events, opts = {}) {
  const { width = 900, height = 90, onSelect } = opts;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'subject-timeline');
  svg.style.overflow = 'visible';

  if (!events.length) {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', '8');
    text.setAttribute('y', '24');
    text.setAttribute('fill', '#888');
    text.setAttribute('font-size', '13');
    text.textContent = 'No timeline events found';
    svg.appendChild(text);
    return svg;
  }

  const { sortedEvents, rects, ticks, innerTop } = buildTimelineSvgParts(events, width, height);
  const rectY = innerTop;
  const tickY = rectY + RECT_HEIGHT;

  // Tick marks + labels
  for (const tick of ticks) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', tick.x.toFixed(1));
    line.setAttribute('y1', (tickY + 1).toString());
    line.setAttribute('x2', tick.x.toFixed(1));
    line.setAttribute('y2', (tickY + 5).toString());
    line.setAttribute('stroke', '#999');
    svg.appendChild(line);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', tick.x.toFixed(1));
    text.setAttribute('y', (tickY + 18).toString());
    text.setAttribute('font-size', '9');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('fill', '#555');
    text.textContent = tick.label;
    svg.appendChild(text);
  }

  // Event rectangles + labels
  for (const r of rects) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'timeline-event');
    g.setAttribute('data-index', String(r.index));
    g.style.cursor = 'pointer';

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', r.x.toFixed(1));
    rect.setAttribute('y', rectY.toString());
    rect.setAttribute('width', r.w.toFixed(1));
    rect.setAttribute('height', RECT_HEIGHT.toString());
    rect.setAttribute('fill', r.color);
    rect.setAttribute('stroke', '#fff');
    rect.setAttribute('stroke-width', '0.5');
    rect.setAttribute('rx', '2');
    g.appendChild(rect);

    // Label centred on the rect (only if wide enough)
    if (r.w > 18) {
      const lx = r.x + r.w / 2;
      const ly = rectY + RECT_HEIGHT + 14;
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', lx.toFixed(1));
      text.setAttribute('y', ly.toFixed(1));
      text.setAttribute('font-size', '9');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#333');
      text.setAttribute('transform', `rotate(-35,${lx.toFixed(1)},${ly.toFixed(1)})`);
      text.textContent = escapeXml(r.label);
      g.appendChild(text);
    }

    if (onSelect) {
      const ev = sortedEvents[r.index];
      g.addEventListener('click', () => onSelect(ev));
    }

    svg.appendChild(g);
  }

  return svg;
}

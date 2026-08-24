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
 * @param {(ev: object, info: {programmatic: boolean}) => void} [opts.onSelect] -
 *   Called with the event object on selection. `programmatic` is true when the
 *   selection came from `selectAcquisition()` (e.g. a deep link) rather than a
 *   user click or keypress.
 * @param {Map<string, string[]>} [opts.assetSources] - name → its `source_data`
 *   parents, used to walk a derived asset back to the acquisition it came from.
 * @returns {HTMLElement}
 */
export function createSubjectTimeline(events, opts = {}) {
  const { onSelect, assetSources = null } = opts;

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

  // Pre-compute the SVG x positions and date range used by the minimap so the
  // window can be sized to match the visible date span of the bubble strip.
  const tMin = sorted[0].start.getTime() - PADDING_MS;
  const tMax = sorted[sorted.length - 1].end.getTime() + PADDING_MS;
  const rangeMs = tMax - tMin;
  const msToSvgX = (ms) => MARGIN_LEFT + ((ms - tMin) / rangeMs) * innerW;

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
  windowRect.style.pointerEvents = 'none';
  svg.appendChild(windowRect);

  wrapper.appendChild(svg);

  // ── Bubble strip ───────────────────────────────────────────────────────────
  const bubbleScroll = document.createElement('div');
  bubbleScroll.className = 'subject-timeline-bubbles';

  let selectedBubble = null;
  const bubbleEls = []; // parallel to sorted[]

  function selectBubble(bubble, ev, { focus = false, programmatic = false } = {}) {
    if (selectedBubble) selectedBubble.classList.remove('tl-bubble--selected');
    bubble.classList.add('tl-bubble--selected');
    selectedBubble = bubble;
    bubble.scrollIntoView?.({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    // Keep keyboard focus on the selected bubble so arrow-key navigation keeps working.
    if (focus) bubble.focus?.({ preventScroll: true });
    onSelect?.(ev, { programmatic });
  }

  // Arrow-key navigation: move one event into the past (←) or future (→).
  // Events (bubbleEls) are ordered oldest → newest, matching sorted[].
  bubbleScroll.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const currentIdx = bubbleEls.indexOf(selectedBubble);
    if (currentIdx === -1) return;
    const nextIdx = e.key === 'ArrowLeft' ? currentIdx - 1 : currentIdx + 1;
    if (nextIdx < 0 || nextIdx >= sorted.length) return;
    e.preventDefault();
    selectBubble(bubbleEls[nextIdx], sorted[nextIdx], { focus: true });
  });

  for (const ev of sorted) {
    const bubble = document.createElement('button');
    bubble.className = 'tl-bubble';
    bubble.style.setProperty('--bubble-color', EVENT_COLORS[ev.type] ?? '#888');

    const dot = document.createElement('span');
    dot.className = 'tl-bubble-dot';

    const typeEl = document.createElement('span');
    typeEl.className = 'tl-bubble-type';
    typeEl.textContent = ev.type === 'Surgery' ? (ev.event ?? ev.type) : ev.type;

    // Acquisition type sits above the date; truncated so the bubble stays one line.
    const acqType = ev.type === 'Acquisition'
      ? (ev.data?.acquisition_type ?? ev.data?.session_type ?? '')
      : '';
    let acqEl = null;
    if (acqType) {
      acqEl = document.createElement('span');
      acqEl.className = 'tl-bubble-acqtype';
      acqEl.textContent = `(${acqType.length > 12 ? `${acqType.slice(0, 11)}\u2026` : acqType})`;
      acqEl.title = acqType;
    }

    const dateEl = document.createElement('span');
    dateEl.className = 'tl-bubble-date';
    dateEl.textContent = ev.dateOnly
      ? ev.start.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: '2-digit',
          timeZone: 'UTC',
        })
      : ev.start.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: '2-digit',
        });

    bubble.appendChild(dot);
    bubble.appendChild(typeEl);
    if (acqEl) bubble.appendChild(acqEl);
    bubble.appendChild(dateEl);

    if (ev.type === 'Acquisition' && ev.modalities?.length) {
      const modEl = document.createElement('span');
      modEl.className = 'tl-bubble-modalities';
      modEl.textContent = ev.modalities.join(', ');
      bubble.appendChild(modEl);
    }

    bubble.addEventListener('click', () => selectBubble(bubble, ev));

    bubbleScroll.appendChild(bubble);
    bubbleEls.push(bubble);
  }

  wrapper.appendChild(bubbleScroll);

  // Expose imperative acquisition selection (used by the combined view to jump
  // to a specific acquisition when arriving from a project-page dot click).
  const acqIndexByName = new Map();
  sorted.forEach((ev, i) => {
    if (ev.type === 'Acquisition' && ev.data?._assetName) {
      acqIndexByName.set(ev.data._assetName, i);
    }
  });

  /**
   * Walk a derived asset name back to the acquisition it descends from.
   *
   * The timeline only carries assets with no `source_data`, but deep links
   * arrive with any asset name — including derived children several hops down
   * (e.g. a `_filtered_` asset whose parent is itself a derived `_nwb_` asset).
   * Provenance is followed through `assetSources`; the old longest-common-prefix
   * guess only worked when derived names happened to extend their parent's name,
   * which is not true in general.
   */
  function resolveAcqIndex(assetName) {
    if (acqIndexByName.has(assetName)) return acqIndexByName.get(assetName);

    if (assetSources) {
      const seen = new Set([assetName]);
      let frontier = [assetName];
      // Breadth-first up the provenance DAG; depth is bounded by `seen`.
      while (frontier.length) {
        const next = [];
        for (const name of frontier) {
          for (const parent of assetSources.get(name) ?? []) {
            if (!parent || seen.has(parent)) continue;
            if (acqIndexByName.has(parent)) return acqIndexByName.get(parent);
            seen.add(parent);
            next.push(parent);
          }
        }
        frontier = next;
      }
    }

    // Last resort for assets missing from `assetSources`: the acquisition whose
    // name is the longest prefix of the requested one.
    let idx = -1;
    let bestLen = 0;
    for (const [raw, i] of acqIndexByName) {
      if (assetName.startsWith(`${raw}_`) && raw.length > bestLen) {
        bestLen = raw.length;
        idx = i;
      }
    }
    return idx;
  }

  wrapper.selectAcquisition = (assetName) => {
    if (!assetName) return false;
    const idx = resolveAcqIndex(assetName);
    if (idx === -1 || idx == null) return false;
    selectBubble(bubbleEls[idx], sorted[idx], { focus: true, programmatic: true });
    return true;
  };

  // ── Sync: scroll → window position/size ───────────────────────────────────

  function getWindowW() {
    return parseFloat(windowRect.getAttribute('width') || '120');
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
    windowRect.style.pointerEvents = 'none';

    // Find which bubbles are at least partially visible in the scroll container.
    const scrollLeft = bubbleScroll.scrollLeft;
    const scrollRight = scrollLeft + visibleW;
    let visibleStartMs = null;
    let visibleEndMs = null;
    for (let i = 0; i < bubbleEls.length; i++) {
      const b = bubbleEls[i];
      const bLeft = b.offsetLeft;
      const bRight = bLeft + b.offsetWidth;
      if (bRight > scrollLeft && bLeft < scrollRight) {
        const ev = sorted[i];
        if (visibleStartMs === null || ev.start.getTime() < visibleStartMs) {
          visibleStartMs = ev.start.getTime();
        }
        if (visibleEndMs === null || ev.end.getTime() > visibleEndMs) {
          visibleEndMs = ev.end.getTime();
        }
      }
    }

    // Fall back to scroll-fraction sizing if no bubbles are measurable yet.
    if (visibleStartMs === null) {
      const winW = Math.max((visibleW / totalW) * innerW, 16);
      const maxScroll = Math.max(totalW - visibleW, 1);
      const scrollFrac = scrollLeft / maxScroll;
      const winX = MARGIN_LEFT + scrollFrac * (innerW - winW);
      windowRect.setAttribute('width', winW.toFixed(1));
      windowRect.setAttribute('x', Math.max(MARGIN_LEFT, winX).toFixed(1));
      return;
    }

    const svgX1 = msToSvgX(visibleStartMs);
    const svgX2 = msToSvgX(visibleEndMs);
    const winW = Math.max(svgX2 - svgX1, 4);
    windowRect.setAttribute('width', winW.toFixed(1));
    windowRect.setAttribute('x', svgX1.toFixed(1));
  }

  // Scroll → window
  bubbleScroll.addEventListener('scroll', updateWindowFromScroll);

  // Initialise geometry after first browser layout pass
  requestAnimationFrame(updateWindowFromScroll);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(updateWindowFromScroll);
    ro.observe(bubbleScroll);
  }

  return wrapper;
}

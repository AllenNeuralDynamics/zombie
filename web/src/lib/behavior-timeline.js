/**
 * lib/behavior-timeline.js — Reusable acquisition timeline SVG builder.
 *
 * Extracted from project/view.js so it can be shared across platform pages
 * (project overview, dynamic foraging, etc.).
 *
 * The timeline renders a grid of subject rows × day columns, with dots
 * representing acquisitions coloured by modality or curriculum stage.
 */

import { MODALITY_COLOR } from './charts.js';

// ---------------------------------------------------------------------------
// Constants (exported so callers can compute cell widths)
// ---------------------------------------------------------------------------

export const TIMELINE_ROW_H   = 28;
export const TIMELINE_LABEL_W = 110;
export const TIMELINE_HEAD_H  = 60;
export const TIMELINE_DOT_R   = 9;

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Strip sub-day precision and return a UTC midnight Date. */
export function utcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Return a new Date shifted by `n` days. */
export function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

/** Format a Date as YYYY-MM-DD (UTC). */
export function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function shortDateLabel(d) {
  return `${DOW_SHORT[d.getUTCDay()]} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// ---------------------------------------------------------------------------
// Curriculum stage colours
// ---------------------------------------------------------------------------

export const STAGE_COLORS = [
  '#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c',
  '#fc4e2a', '#e31a1c', '#bd0026', '#800026', '#54001a', '#2d0010',
];

export function stageColor(stageNodeId) {
  if (stageNodeId == null || isNaN(stageNodeId)) return '#aaaaaa';
  const idx = Math.round(stageNodeId);
  return STAGE_COLORS[Math.min(idx, STAGE_COLORS.length - 1)] ?? '#aaaaaa';
}

export function stageForeground(stageNodeId) {
  const idx = stageNodeId == null ? 0 : Math.round(stageNodeId);
  return idx >= 5 ? '#ffffff' : '#000000';
}

// ---------------------------------------------------------------------------
// Curriculum legend
// ---------------------------------------------------------------------------

/**
 * Build an HTML legend element showing which curriculum stages are visible
 * in the current timeline window. Returns null if there is nothing to show.
 *
 * @param {object[]} rawAssets  - Assets with `acquisition_start_time` and `name`.
 * @param {Date}     windowStart
 * @param {Map}      curriculumMap - Maps asset name → {curriculum_name, stage_name, stage_node_id}.
 * @param {number}   numDays
 * @returns {HTMLElement|null}
 */
export function buildCurriculumLegend(rawAssets, windowStart, curriculumMap, numDays = 14) {
  const windowEnd = addDays(windowStart, numDays);
  const visibleCurricula = new Set();
  for (const a of rawAssets) {
    if (!a.acquisition_start_time) continue;
    const d = utcDay(new Date(a.acquisition_start_time));
    if (d < windowStart || d >= windowEnd) continue;
    const cur = curriculumMap?.get(a.name);
    if (cur?.curriculum_name) visibleCurricula.add(cur.curriculum_name);
  }
  if (visibleCurricula.size === 0) return null;

  const allStages = new Map();
  for (const cur of curriculumMap.values()) {
    if (!visibleCurricula.has(cur.curriculum_name)) continue;
    if (!allStages.has(cur.curriculum_name)) allStages.set(cur.curriculum_name, new Map());
    allStages.get(cur.curriculum_name).set(cur.stage_node_id, cur.stage_name);
  }

  const container = document.createElement('div');
  container.className = 'pt-curriculum-legend';

  for (const curriculumName of visibleCurricula) {
    const stagesMap = allStages.get(curriculumName);
    if (!stagesMap) continue;
    const section = document.createElement('div');
    section.className = 'pt-legend-curriculum';
    const title = document.createElement('div');
    title.className = 'pt-legend-curriculum-title';
    title.textContent = curriculumName;
    section.appendChild(title);
    const sortedStages = Array.from(stagesMap.entries()).sort((a, b) => a[0] - b[0]);
    for (const [nodeId, stageName] of sortedStages) {
      const item = document.createElement('div');
      item.className = 'pt-legend-item';
      const badge = document.createElement('span');
      badge.className = 'pt-legend-badge';
      badge.style.background = stageColor(nodeId);
      badge.style.color = stageForeground(nodeId);
      badge.textContent = String(nodeId);
      item.appendChild(badge);
      item.appendChild(document.createTextNode(` ${stageName}`));
      section.appendChild(item);
    }
    container.appendChild(section);
  }
  return container;
}

// ---------------------------------------------------------------------------
// Timeline SVG
// ---------------------------------------------------------------------------

/**
 * Build an SVG timeline showing acquisitions as dots (subject rows × day columns).
 *
 * @param {object[]} assets        - Asset/session objects. Must have:
 *                                   `acquisition_start_time` (ISO string),
 *                                   `subject_id` (string),
 *                                   `name` (string, used as key in curriculumMap),
 *                                   `modalities` (comma-separated string, for modality view).
 * @param {Date}     windowStart   - First day (UTC midnight, inclusive).
 * @param {function(object[]):void} onDotClick - Called with the assets for the clicked dot.
 * @param {object}   [opts]
 * @param {number}   [opts.cellW=70]         - Pixel width per day column.
 * @param {HTMLElement} [opts.tooltipEl]     - Floating HTML div for hover tooltip.
 * @param {string}   [opts.viewMode='modality'] - 'modality' or 'curriculum'.
 * @param {Map}      [opts.curriculumMap]    - Maps asset name → {curriculum_name, stage_name, stage_node_id}.
 * @param {number}   [opts.numDays=14]       - Number of day columns.
 * @returns {SVGSVGElement}
 */
export function buildTimelineSvg(assets, windowStart, onDotClick, {
  cellW = 70,
  tooltipEl = null,
  viewMode = 'modality',
  curriculumMap = null,
  numDays = 14,
} = {}) {
  const windowEnd = addDays(windowStart, numDays);

  const inWindow = assets.filter((a) => {
    if (!a.acquisition_start_time) return false;
    const d = utcDay(new Date(a.acquisition_start_time));
    return d >= windowStart && d < windowEnd;
  });

  // Subjects sorted by numeric ID descending
  const subjectSet = new Set(inWindow.map((a) => a.subject_id).filter(Boolean));
  const subjects = Array.from(subjectSet).sort((a, b) => {
    const na = parseInt(a, 10);
    const nb = parseInt(b, 10);
    if (!isNaN(na) && !isNaN(nb)) return nb - na;
    return b.localeCompare(a);
  });

  const days = Array.from({ length: numDays }, (_, i) => addDays(windowStart, i));

  const svgW = TIMELINE_LABEL_W + numDays * cellW;
  const svgH = TIMELINE_HEAD_H + Math.max(subjects.length, 1) * TIMELINE_ROW_H + 10;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', svgW);
  svg.setAttribute('height', svgH);
  svg.setAttribute('class', 'project-timeline-svg');
  svg.style.overflow = 'visible';

  // Alternating row backgrounds + per-subject highlight rects (hidden by default)
  const subjectHighlightMap = new Map();
  subjects.forEach((subjectId, ri) => {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', TIMELINE_HEAD_H + ri * TIMELINE_ROW_H);
    rect.setAttribute('width', svgW);
    rect.setAttribute('height', TIMELINE_ROW_H);
    rect.setAttribute('class', ri % 2 === 0 ? 'pt-row-even' : 'pt-row-odd');
    svg.appendChild(rect);

    const hl = document.createElementNS(NS, 'rect');
    hl.setAttribute('x', 0);
    hl.setAttribute('y', TIMELINE_HEAD_H + ri * TIMELINE_ROW_H);
    hl.setAttribute('width', svgW);
    hl.setAttribute('height', TIMELINE_ROW_H);
    hl.setAttribute('class', 'pt-row-highlight');
    hl.style.display = 'none';
    svg.appendChild(hl);
    subjectHighlightMap.set(subjectId, hl);
  });

  // Vertical day dividers
  days.forEach((_, di) => {
    const x = TIMELINE_LABEL_W + di * cellW;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', 0);
    line.setAttribute('x2', x);
    line.setAttribute('y2', svgH);
    line.setAttribute('class', 'pt-day-line');
    svg.appendChild(line);
  });

  // Date header labels — rotated up-left
  days.forEach((day, di) => {
    const cx = TIMELINE_LABEL_W + di * cellW + cellW / 2;
    const y = TIMELINE_HEAD_H - 4;
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', cx);
    text.setAttribute('y', y);
    text.setAttribute('class', 'pt-date-label');
    text.setAttribute('text-anchor', 'start');
    text.setAttribute('transform', `rotate(-55, ${cx}, ${y})`);
    text.textContent = shortDateLabel(day);
    svg.appendChild(text);
  });

  // Subject labels as links
  subjects.forEach((subjectId, ri) => {
    const y = TIMELINE_HEAD_H + ri * TIMELINE_ROW_H + TIMELINE_ROW_H / 2;
    const a = document.createElementNS(NS, 'a');
    a.setAttribute('href', `/view?subject_id=${encodeURIComponent(subjectId)}`);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', TIMELINE_LABEL_W - 8);
    text.setAttribute('y', y + 4);
    text.setAttribute('class', 'pt-subject-label');
    text.setAttribute('text-anchor', 'end');
    text.textContent = subjectId;
    a.appendChild(text);
    svg.appendChild(a);
    subjectHighlightMap.set(subjectId + '__label', text);
  });

  if (subjects.length === 0) {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', svgW / 2);
    text.setAttribute('y', TIMELINE_HEAD_H + TIMELINE_ROW_H / 2 + 4);
    text.setAttribute('class', 'pt-date-label');
    text.setAttribute('text-anchor', 'middle');
    text.textContent = 'No acquisitions in this window';
    svg.appendChild(text);
    return svg;
  }

  // Group acquisitions by subject+day
  const bySubjectDay = new Map();
  for (const asset of inWindow) {
    if (!asset.subject_id) continue;
    const day = isoDate(utcDay(new Date(asset.acquisition_start_time)));
    const key = `${asset.subject_id}|${day}`;
    if (!bySubjectDay.has(key)) bySubjectDay.set(key, []);
    bySubjectDay.get(key).push(asset);
  }

  // Build <defs> with one <symbol> per unique modality fingerprint.
  const defs = document.createElementNS(NS, 'defs');
  const fingerprintToSymId = new Map();
  let symCounter = 0;

  function getOrCreateSymbol(modalities) {
    const fp = modalities.join('|');
    if (fingerprintToSymId.has(fp)) return fingerprintToSymId.get(fp);

    const symId = `pt-pie-${symCounter++}`;
    fingerprintToSymId.set(fp, symId);

    const sym = document.createElementNS(NS, 'symbol');
    sym.setAttribute('id', symId);
    sym.setAttribute('overflow', 'visible');

    if (modalities.length === 1) {
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', 0);
      c.setAttribute('cy', 0);
      c.setAttribute('r', TIMELINE_DOT_R);
      c.setAttribute('fill', MODALITY_COLOR[modalities[0]] ?? '#888888');
      sym.appendChild(c);
    } else {
      const n = modalities.length;
      const step = (2 * Math.PI) / n;
      const start = -Math.PI / 2;
      for (let i = 0; i < n; i++) {
        const a0 = start + i * step;
        const a1 = start + (i + 1) * step;
        const x0 = TIMELINE_DOT_R * Math.cos(a0);
        const y0 = TIMELINE_DOT_R * Math.sin(a0);
        const x1 = TIMELINE_DOT_R * Math.cos(a1);
        const y1 = TIMELINE_DOT_R * Math.sin(a1);
        const large = step > Math.PI ? 1 : 0;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', `M 0 0 L ${x0} ${y0} A ${TIMELINE_DOT_R} ${TIMELINE_DOT_R} 0 ${large} 1 ${x1} ${y1} Z`);
        path.setAttribute('fill', MODALITY_COLOR[modalities[i]] ?? '#888888');
        sym.appendChild(path);
      }
    }
    defs.appendChild(sym);
    return symId;
  }

  const stageColorSymIdMap = new Map();
  function getOrCreateCircleSymbol(color) {
    if (stageColorSymIdMap.has(color)) return stageColorSymIdMap.get(color);
    const symId = `pt-circle-${symCounter++}`;
    stageColorSymIdMap.set(color, symId);
    const sym = document.createElementNS(NS, 'symbol');
    sym.setAttribute('id', symId);
    sym.setAttribute('overflow', 'visible');
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', 0);
    c.setAttribute('cy', 0);
    c.setAttribute('r', TIMELINE_DOT_R);
    c.setAttribute('fill', color);
    sym.appendChild(c);
    defs.appendChild(sym);
    return symId;
  }

  svg.appendChild(defs);

  // Map from asset name → dot <g> element, for imperative highlighting.
  const assetDotMap = new Map();
  let selectedDotG = null;

  bySubjectDay.forEach((dayAssets, key) => {
    const [subjectId, dayStr] = key.split('|');
    const ri = subjects.indexOf(subjectId);
    if (ri === -1) return;
    const di = days.findIndex((d) => isoDate(d) === dayStr);
    if (di === -1) return;

    const cx = TIMELINE_LABEL_W + di * cellW + cellW / 2;
    const cy = TIMELINE_HEAD_H + ri * TIMELINE_ROW_H + TIMELINE_ROW_H / 2;
    const count = dayAssets.length;

    let symId;
    if (viewMode === 'curriculum') {
      let stageNodeId = null;
      for (const a of dayAssets) {
        const cur = curriculumMap?.get(a.name);
        if (cur && cur.stage_node_id != null) { stageNodeId = cur.stage_node_id; break; }
      }
      symId = getOrCreateCircleSymbol(stageColor(stageNodeId));
    } else {
      const modalitySet = new Set();
      for (const a of dayAssets) {
        if (!a.modalities) continue;
        const mods = Array.isArray(a.modalities) ? a.modalities : String(a.modalities).split(',').map((s) => s.trim()).filter(Boolean);
        for (const m of mods) {
          modalitySet.add(m);
        }
      }
      const modalities = Array.from(modalitySet).sort();
      if (modalities.length === 0) modalities.push('unknown');
      symId = getOrCreateSymbol(modalities);
    }

    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${cx},${cy})`);
    g.style.cursor = 'pointer';

    const useEl = document.createElementNS(NS, 'use');
    useEl.setAttribute('href', `#${symId}`);
    g.appendChild(useEl);

    // Transparent hit circle for reliable pointer events
    const hit = document.createElementNS(NS, 'circle');
    hit.setAttribute('cx', 0);
    hit.setAttribute('cy', 0);
    hit.setAttribute('r', TIMELINE_DOT_R);
    hit.setAttribute('fill', 'transparent');
    g.appendChild(hit);

    if (count > 1) {
      const countText = document.createElementNS(NS, 'text');
      countText.setAttribute('x', 0);
      countText.setAttribute('y', 4);
      countText.setAttribute('class', 'pt-dot-count');
      countText.setAttribute('text-anchor', 'middle');
      countText.textContent = count;
      countText.style.pointerEvents = 'none';
      g.appendChild(countText);
    }

    if (tooltipEl) {
      const showTip = (e) => {
        tooltipEl.innerHTML = dayAssets.map((a) => {
          const cur = curriculumMap?.get(a.name);
          const metaLines = [
            a.acquisition_type ? `type: ${a.acquisition_type}` : '',
            a.modalities ? `modalities: ${Array.isArray(a.modalities) ? a.modalities.join(', ') : a.modalities}` : '',
            cur?.curriculum_name ? `curriculum: ${cur.curriculum_name}` : '',
            cur?.stage_name ? `stage: ${cur.stage_name}` : '',
          ].filter(Boolean);
          const metaHtml = metaLines.map((l) => `<div>${l}</div>`).join('');
          return `<div class="pt-tip-row"><div class="pt-tip-name">${a.name ?? ''}</div>${metaHtml ? `<div class="pt-tip-meta">${metaHtml}</div>` : ''}</div>`;
        }).join('');
        tooltipEl.style.display = '';
        tooltipEl.style.left = `${e.clientX + 14}px`;
        tooltipEl.style.top  = `${e.clientY + 14}px`;
      };
      g.addEventListener('mouseenter', showTip);
      g.addEventListener('mousemove', (e) => {
        tooltipEl.style.left = `${e.clientX + 14}px`;
        tooltipEl.style.top  = `${e.clientY + 14}px`;
      });
      g.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
    }

    // Selection ring — hidden by default, shown via pt-dot-selected class on g
    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', 0);
    ring.setAttribute('cy', 0);
    ring.setAttribute('r', TIMELINE_DOT_R + 4);
    ring.setAttribute('class', 'pt-dot-ring');
    ring.style.pointerEvents = 'none';
    g.appendChild(ring);

    g.addEventListener('click', () => onDotClick && onDotClick(dayAssets));

    // Register each asset name → this dot group for external highlighting.
    for (const a of dayAssets) {
      if (a.name) assetDotMap.set(a.name, g);
    }

    svg.appendChild(g);
  });

  let selectedHlEl = null;
  let selectedLabelEl = null;
  svg.highlightSubject = (subjectId) => {
    if (selectedHlEl) selectedHlEl.style.display = 'none';
    if (selectedLabelEl) selectedLabelEl.classList.remove('pt-subject-label--selected');
    selectedHlEl = subjectId ? (subjectHighlightMap.get(subjectId) ?? null) : null;
    selectedLabelEl = subjectId ? (subjectHighlightMap.get(subjectId + '__label') ?? null) : null;
    if (selectedHlEl) selectedHlEl.style.display = '';
    if (selectedLabelEl) selectedLabelEl.classList.add('pt-subject-label--selected');
  };

  svg.highlightAsset = (assetName) => {
    if (selectedDotG) selectedDotG.classList.remove('pt-dot-selected');
    selectedDotG = assetName ? (assetDotMap.get(assetName) ?? null) : null;
    if (selectedDotG) selectedDotG.classList.add('pt-dot-selected');
  };

  return svg;
}

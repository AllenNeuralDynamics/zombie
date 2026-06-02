/**
 * project/view.js — Project overview page (/project?project=<name>).
 *
 * Queries asset_basics for all assets in the selected project and renders:
 *   1. Project selector (synced to URL ?project=)
 *   2. Two-week acquisition timeline (subjects as rows, days as columns)
 *      with < > navigation arrows shifting by two weeks at a time.
 *   3. Grouped assets table at the bottom (shared with subject page).
 */

import { arrowTableToRows, buildAssetsTable, fetchAssetsWithSources } from '../lib/assets-table.js';
import { buildModalityHistogram, MODALITY_COLOR } from '../lib/charts.js';
import { createForagingSessionDetail } from '../lib/behaviors/dynamic-foraging.js';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function utcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function isoDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function getNumDays(windowSize) {
  switch (windowSize) {
    case 'week':    return 7;
    case 'month':   return 30;
    case '3months': return 91;
    default:        return 14;
  }
}

function computeDefaultWindowStart(windowSize, today) {
  const dow = today.getUTCDay();
  const thisSunday = addDays(today, -dow);
  switch (windowSize) {
    case 'week':    return thisSunday;
    case 'month':   return addDays(today, -29);
    case '3months': return addDays(today, -90);
    default:        return addDays(thisSunday, -7);
  }
}

function findLastAcquisitionWindow(rawAssets, windowSize) {
  let lastDate = null;
  for (const a of rawAssets) {
    if (!a.acquisition_start_time) continue;
    const d = utcDay(new Date(a.acquisition_start_time));
    if (!lastDate || d > lastDate) lastDate = d;
  }
  return computeDefaultWindowStart(windowSize, lastDate ?? utcDay(new Date()));
}

function filterByCurricula(rawAssets, windowStart, numDays, curriculumMap, selectedCurricula) {
  if (!selectedCurricula || selectedCurricula.size === 0) return rawAssets;
  const windowEnd = addDays(windowStart, numDays);
  const allowedSubjects = new Set();
  for (const a of rawAssets) {
    if (!a.acquisition_start_time || !a.subject_id) continue;
    const d = utcDay(new Date(a.acquisition_start_time));
    if (d < windowStart || d >= windowEnd) continue;
    const cur = curriculumMap.get(a.name);
    if (cur && selectedCurricula.has(cur.curriculum_name)) allowedSubjects.add(a.subject_id);
  }
  return rawAssets.filter((a) => allowedSubjects.has(a.subject_id));
}

// ---------------------------------------------------------------------------
// Timeline SVG builder
// ---------------------------------------------------------------------------

const ROW_H = 28;
const LABEL_W = 110;
const HEAD_H = 60;
const DOT_R = 9;

const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DOW_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function shortDateLabel(d) {
  return `${DOW_SHORT[d.getUTCDay()]} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * Build an SVG timeline for the 14-day window.
 *
 * @param {object[]} assets        - All raw project assets.
 * @param {Date}     windowStart   - First day inclusive (UTC midnight).
 * @param {function(object[]):void} onDotClick
 * @param {object}   opts
 * @param {number}   opts.cellW    - Pixel width per day column.
 * @param {HTMLElement} opts.tooltipEl - Floating HTML div for hover tooltip (avoids SVG clipping).
 * @returns {SVGSVGElement}
 */
function buildTimelineSvg(assets, windowStart, onDotClick, { cellW = 70, tooltipEl = null, viewMode = 'modality', curriculumMap = null, numDays = 14 } = {}) {
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

  const svgW = LABEL_W + numDays * cellW;
  const svgH = HEAD_H + Math.max(subjects.length, 1) * ROW_H + 10;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', svgW);
  svg.setAttribute('height', svgH);
  svg.setAttribute('class', 'project-timeline-svg');
  svg.style.overflow = 'visible';

  // Alternating row backgrounds
  subjects.forEach((_, ri) => {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', HEAD_H + ri * ROW_H);
    rect.setAttribute('width', svgW);
    rect.setAttribute('height', ROW_H);
    rect.setAttribute('class', ri % 2 === 0 ? 'pt-row-even' : 'pt-row-odd');
    svg.appendChild(rect);
  });

  // Vertical day dividers
  days.forEach((_, di) => {
    const x = LABEL_W + di * cellW;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', 0);
    line.setAttribute('x2', x);
    line.setAttribute('y2', svgH);
    line.setAttribute('class', 'pt-day-line');
    svg.appendChild(line);
  });

  // Date header labels — all 14 days, anchored at bottom of header row, rotated up-left
  days.forEach((day, di) => {
    const cx = LABEL_W + di * cellW + cellW / 2;
    const y = HEAD_H - 4;
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
    const y = HEAD_H + ri * ROW_H + ROW_H / 2;
    const a = document.createElementNS(NS, 'a');
    a.setAttribute('href', `/subject?subject_id=${encodeURIComponent(subjectId)}`);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', LABEL_W - 8);
    text.setAttribute('y', y + 4);
    text.setAttribute('class', 'pt-subject-label');
    text.setAttribute('text-anchor', 'end');
    text.textContent = subjectId;
    a.appendChild(text);
    svg.appendChild(a);
  });

  if (subjects.length === 0) {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', svgW / 2);
    text.setAttribute('y', HEAD_H + ROW_H / 2 + 4);
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
  // A fingerprint is the sorted unique modality set for a dot, e.g. "ecephys|fib".
  // This means we only generate O(unique combos) paths, not O(dots).
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
      c.setAttribute('r', DOT_R);
      c.setAttribute('fill', MODALITY_COLOR[modalities[0]] ?? '#888888');
      sym.appendChild(c);
    } else {
      const n = modalities.length;
      const step = (2 * Math.PI) / n;
      const start = -Math.PI / 2; // 12 o'clock
      for (let i = 0; i < n; i++) {
        const a0 = start + i * step;
        const a1 = start + (i + 1) * step;
        const x0 = DOT_R * Math.cos(a0);
        const y0 = DOT_R * Math.sin(a0);
        const x1 = DOT_R * Math.cos(a1);
        const y1 = DOT_R * Math.sin(a1);
        const large = step > Math.PI ? 1 : 0;
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', `M 0 0 L ${x0} ${y0} A ${DOT_R} ${DOT_R} 0 ${large} 1 ${x1} ${y1} Z`);
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
    c.setAttribute('r', DOT_R);
    c.setAttribute('fill', color);
    sym.appendChild(c);
    defs.appendChild(sym);
    return symId;
  }

  svg.appendChild(defs);

  bySubjectDay.forEach((dayAssets, key) => {
    const [subjectId, dayStr] = key.split('|');
    const ri = subjects.indexOf(subjectId);
    if (ri === -1) return;
    const di = days.findIndex((d) => isoDate(d) === dayStr);
    if (di === -1) return;

    const cx = LABEL_W + di * cellW + cellW / 2;
    const cy = HEAD_H + ri * ROW_H + ROW_H / 2;
    const count = dayAssets.length;

    // Collect symbol for this dot based on view mode
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
        for (const m of String(a.modalities).split(',').map((s) => s.trim()).filter(Boolean)) {
          modalitySet.add(m);
        }
      }
      const modalities = Array.from(modalitySet).sort();
      if (modalities.length === 0) modalities.push('unknown');
      symId = getOrCreateSymbol(modalities);
    }

    // Group: positions the reused symbol and acts as event target
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('transform', `translate(${cx},${cy})`);
    g.style.cursor = 'pointer';

    const useEl = document.createElementNS(NS, 'use');
    useEl.setAttribute('href', `#${symId}`);
    g.appendChild(useEl);

    // Transparent hit circle ensures reliable pointer events regardless of pie slice geometry
    const hit = document.createElementNS(NS, 'circle');
    hit.setAttribute('cx', 0);
    hit.setAttribute('cy', 0);
    hit.setAttribute('r', DOT_R);
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
            a.modalities ? `modalities: ${a.modalities}` : '',
            cur?.curriculum_name ? `curriculum: ${cur.curriculum_name}` : '',
            cur?.stage_name ? `stage: ${cur.stage_name}` : '',
          ].filter(Boolean);
          const metaHtml = metaLines.map(l => `<div>${l}</div>`).join('');
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

    g.addEventListener('click', () => onDotClick && onDotClick(dayAssets));
    svg.appendChild(g);
  });

  return svg;
}

// ---------------------------------------------------------------------------
// Modality histogram (delegated to lib/charts.js)
// ---------------------------------------------------------------------------

const CURRICULUM_PARQUET_URL = 'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/zs_behavior_curriculum.pqt';

const STAGE_COLORS = [
  '#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c',
  '#fc4e2a', '#e31a1c', '#bd0026', '#800026', '#54001a', '#2d0010',
];

function stageColor(stageNodeId) {
  if (stageNodeId == null || isNaN(stageNodeId)) return '#aaaaaa';
  const idx = Math.round(stageNodeId);
  return STAGE_COLORS[Math.min(idx, STAGE_COLORS.length - 1)] ?? '#aaaaaa';
}

function stageForeground(stageNodeId) {
  const idx = stageNodeId == null ? 0 : Math.round(stageNodeId);
  return idx >= 5 ? '#ffffff' : '#000000';
}

function buildCurriculumLegend(rawAssets, windowStart, curriculumMap, numDays = 14) {
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

/**
 * Build a stacked bar chart of acquisitions per month, colored by modality.
 *
 * Pre-aggregates the assets in JS (data already in memory) then passes a
 * plain array to Observable Plot via vgplot's barY mark.
 *
 * @param {object[]} assets - Raw project assets (already filtered to non-derived).
 * @param {number} containerWidth - Available pixel width for sizing the chart.
 * @param {Date} windowStart - Start of the currently selected two-week window (for highlight overlay).
 * @returns {HTMLElement|null} The plot element, or null if there's no data.
 */
// buildModalityHistogram is imported from lib/charts.js

// ---------------------------------------------------------------------------
// Main view factory
// ---------------------------------------------------------------------------

export function createProjectView(opts = {}) {
  const { coordinator } = opts;
  const params = new URLSearchParams(window.location.search);
  const initialProject = params.get('project') ?? '';

  const today = utcDay(new Date());
  let currentProject = initialProject;
  let abortController = null;
  let viewMode = params.get('color_by') ?? 'modality';
  let windowSize = params.get('window_size') ?? 'twoweeks';
  let windowStart = params.get('window_start')
    ? utcDay(new Date(params.get('window_start') + 'T00:00:00Z'))
    : null;
  let selectedCurricula = new Set((params.get('curricula') ?? '').split(',').filter(Boolean));

  const root = document.createElement('div');
  root.className = 'project-view';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'view-header';
  headerEl.innerHTML = '<h2>Project Overview</h2>';

  const selectorEl = document.createElement('div');
  selectorEl.className = 'subject-selector';
  selectorEl.innerHTML = `
    <label for="project-select-input">Project</label>
    <input id="project-select-input" list="project-select-list"
           placeholder="Type or select a project…"
           autocomplete="off" spellcheck="false"
           aria-label="Project name" />
    <datalist id="project-select-list"></datalist>`;
  headerEl.appendChild(selectorEl);
  root.appendChild(headerEl);

  const contentEl = document.createElement('div');
  contentEl.className = 'project-content';
  root.appendChild(contentEl);

  const input = selectorEl.querySelector('input');
  const datalist = selectorEl.querySelector('datalist');
  if (initialProject) input.value = initialProject;

  // Populate project list
  if (coordinator) {
    coordinator.query(
      `SELECT DISTINCT project_name FROM asset_basics WHERE project_name IS NOT NULL ORDER BY 1`,
    ).then((result) => {
      for (const row of arrowTableToRows(result)) {
        const opt = document.createElement('option');
        opt.value = row.project_name;
        datalist.appendChild(opt);
      }
    }).catch(() => {});
  }

  function load() {
    if (abortController) abortController.abort();
    abortController = new AbortController();

    // Update URL
    const p = new URLSearchParams(window.location.search);
    if (currentProject) p.set('project', currentProject); else p.delete('project');
    p.set('color_by', viewMode);
    p.set('window_size', windowSize);
    if (windowStart) p.set('window_start', isoDate(windowStart)); else p.delete('window_start');
    const curriculaStr = Array.from(selectedCurricula).join(',');
    if (curriculaStr) p.set('curricula', curriculaStr); else p.delete('curricula');
    try {
      const url = new URL(window.location.href);
      url.search = p.toString();
      history.replaceState({}, '', url);
    } catch { /* restricted */ }

    const _numDays = getNumDays(windowSize);
    _loadProject(contentEl, currentProject, coordinator, windowStart, abortController.signal, {
      onPrev: () => { windowStart = addDays(windowStart, -_numDays); load(); },
      onNext: () => { windowStart = addDays(windowStart, _numDays); load(); },
      onWindowStartChange: (date) => { windowStart = date; },
      viewMode,
      onViewModeChange: (mode) => { viewMode = mode; load(); },
      windowSize,
      onWindowSizeChange: (size) => { windowSize = size; windowStart = computeDefaultWindowStart(size, utcDay(new Date())); load(); },
      selectedCurricula,
      onCurriculaChange: (set) => { selectedCurricula = set; load(); },
    });
  }

  input.addEventListener('change', () => {
    currentProject = input.value.trim();
    windowStart = null;
    load();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  load();
  return root;
}

// ---------------------------------------------------------------------------
// Internal load function
// ---------------------------------------------------------------------------

async function _loadProject(contentEl, projectName, coordinator, windowStart, signal, { onPrev, onNext, onWindowStartChange = null, viewMode = 'modality', onViewModeChange = null, windowSize = 'twoweeks', onWindowSizeChange = null, selectedCurricula = null, onCurriculaChange = null } = {}) {
  // Remove any stale tooltip divs from a previous load
  document.querySelectorAll('.pt-html-tooltip').forEach((el) => el.remove());
  contentEl.innerHTML = '';

  if (!projectName) {
    contentEl.innerHTML = `
      <div class="error-banner">
        No project selected. Pick one from the dropdown or use <code>?project=&lt;name&gt;</code> in the URL.
      </div>`;
    return;
  }

  const loadingEl = document.createElement('div');
  loadingEl.className = 'subject-loading';
  loadingEl.textContent = 'Loading project data…';
  contentEl.appendChild(loadingEl);

  if (!coordinator) {
    loadingEl.replaceWith(_errorEl('No data connection available.'));
    return;
  }

  const numDays = getNumDays(windowSize);
  const safeProject = projectName.replace(/'/g, "''");

  try {
    // Fetch raw assets for the timeline
    const { assets: rawAssets } = await fetchAssetsWithSources(
      coordinator,
      `project_name = '${safeProject}' AND (data_level IS NULL OR data_level != 'derived')`,
    );
    if (signal?.aborted) return;

    if (!windowStart) {
      windowStart = findLastAcquisitionWindow(rawAssets, windowSize);
      onWindowStartChange?.(windowStart);
      try {
        const _p = new URLSearchParams(window.location.search);
        _p.set('window_start', isoDate(windowStart));
        const _url = new URL(window.location.href);
        _url.search = _p.toString();
        history.replaceState({}, '', _url);
      } catch { /* restricted */ }
    }
    const windowEnd = addDays(windowStart, numDays);

    // Fetch all assets (raw + derived) for the table
    const { assets: allAssets, sourceMap } = await fetchAssetsWithSources(
      coordinator,
      `project_name = '${safeProject}'`,
    );
    if (signal?.aborted) return;

    const curriculumMap = new Map();
    try {
      const currResult = await coordinator.query(`
        SELECT a.name, c.curriculum_name, c.stage_name, c.stage_node_id
        FROM asset_basics a
        LEFT JOIN read_parquet('${CURRICULUM_PARQUET_URL}') c ON a.name = c.asset_name
        WHERE a.project_name = '${safeProject}' AND c.curriculum_name IS NOT NULL
      `);
      if (!signal?.aborted) {
        for (const row of arrowTableToRows(currResult)) {
          curriculumMap.set(row.name, {
            curriculum_name: row.curriculum_name,
            stage_name: row.stage_name,
            stage_node_id: row.stage_node_id != null ? Math.round(Number(row.stage_node_id)) : null,
          });
        }
      }
    } catch { /* curriculum data is optional */ }
    if (signal?.aborted) return;

    const allCurricula = Array.from(
      new Set(Array.from(curriculumMap.values()).map((c) => c.curriculum_name).filter(Boolean))
    ).sort();
    const filteredRawAssets = filterByCurricula(rawAssets, windowStart, numDays, curriculumMap, selectedCurricula ?? new Set());

    // Info card
    const infoEl = document.createElement('div');
    infoEl.className = 'subject-info-card project-info-card';
    const subjectCount = new Set(rawAssets.map((a) => a.subject_id).filter(Boolean)).size;

    const infoTextEl = document.createElement('div');
    infoTextEl.className = 'project-info-text';
    infoTextEl.innerHTML = `
      <h3>${projectName}</h3>
      <dl>
        <dt>Total assets</dt><dd>${allAssets.length}</dd>
        <dt>Subjects</dt><dd>${subjectCount}</dd>
      </dl>`;
    infoEl.appendChild(infoTextEl);

    // Acquisitions histogram — lives inside the info card, to the right
    const histogramEl = document.createElement('div');
    histogramEl.className = 'project-info-histogram';
    const histPlot = buildModalityHistogram(rawAssets, Math.max(400, (contentEl.getBoundingClientRect().width || window.innerWidth) - 220));
    if (histPlot) {
      histogramEl.appendChild(histPlot);
      infoEl.appendChild(histogramEl);
    }

    // Timeline section
    const timelineSection = document.createElement('div');
    timelineSection.className = 'subject-timeline-section project-timeline-section';

    const timelineHeader = document.createElement('div');
    timelineHeader.className = 'project-timeline-header';
    timelineHeader.innerHTML = '<h3>Acquisitions</h3>';
    timelineSection.appendChild(timelineHeader);

    const timelineBody = document.createElement('div');
    timelineBody.className = 'project-timeline-body';

    // --- Settings / filter panel ---
    const filterPanel = document.createElement('div');
    filterPanel.className = 'sessions-filter-panel project-filter-panel';

    const panelTitle = document.createElement('h3');
    panelTitle.className = 'sessions-panel-title';
    panelTitle.textContent = 'Settings';
    filterPanel.appendChild(panelTitle);

    if (allCurricula.length > 0) {
      const curriculumGroup = document.createElement('div');
      curriculumGroup.className = 'sessions-filter-group';
      const curriculumLabel = document.createElement('div');
      curriculumLabel.className = 'sessions-filter-label';
      curriculumLabel.textContent = 'Curriculum';
      curriculumGroup.appendChild(curriculumLabel);
      const cbList = document.createElement('div');
      cbList.className = 'sessions-checkbox-list';
      const localCurricula = new Set(selectedCurricula ?? []);
      for (const name of allCurricula) {
        const item = document.createElement('label');
        item.className = 'sessions-checkbox-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = localCurricula.has(name);
        cb.addEventListener('change', () => {
          if (cb.checked) localCurricula.add(name); else localCurricula.delete(name);
          onCurriculaChange?.(new Set(localCurricula));
        });
        item.appendChild(cb);
        item.appendChild(document.createTextNode('\u00a0' + name));
        cbList.appendChild(item);
      }
      const clearCurrBtn = document.createElement('button');
      clearCurrBtn.className = 'sessions-filter-clear';
      clearCurrBtn.textContent = 'Clear';
      clearCurrBtn.addEventListener('click', () => {
        localCurricula.clear();
        cbList.querySelectorAll('input').forEach((c) => { c.checked = false; });
        onCurriculaChange?.(new Set());
      });
      curriculumGroup.appendChild(cbList);
      curriculumGroup.appendChild(clearCurrBtn);
      filterPanel.appendChild(curriculumGroup);
    }

    const windowGroup = document.createElement('div');
    windowGroup.className = 'sessions-filter-group';
    const windowLabel = document.createElement('div');
    windowLabel.className = 'sessions-filter-label';
    windowLabel.textContent = 'Window';
    windowGroup.appendChild(windowLabel);
    const windowSelect = document.createElement('select');
    windowSelect.className = 'project-filter-select';
    [{ value: 'week', label: 'Current week' }, { value: 'twoweeks', label: 'Two weeks' },
     { value: 'month', label: 'Month' }, { value: '3months', label: '3 months' }]
      .forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = label;
        if (value === windowSize) opt.selected = true;
        windowSelect.appendChild(opt);
      });
    windowSelect.addEventListener('change', () => onWindowSizeChange?.(windowSelect.value));
    windowGroup.appendChild(windowSelect);
    filterPanel.appendChild(windowGroup);

    const colorGroup = document.createElement('div');
    colorGroup.className = 'sessions-filter-group';
    const colorLabel = document.createElement('div');
    colorLabel.className = 'sessions-filter-label';
    colorLabel.textContent = 'Color by';
    colorGroup.appendChild(colorLabel);
    const colorSelect = document.createElement('select');
    colorSelect.className = 'project-filter-select';
    [{ value: 'modality', label: 'Modality' }, { value: 'curriculum', label: 'Curriculum stage' }]
      .forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value; opt.textContent = label;
        if (value === viewMode) opt.selected = true;
        colorSelect.appendChild(opt);
      });
    colorSelect.addEventListener('change', () => onViewModeChange?.(colorSelect.value));
    colorGroup.appendChild(colorSelect);
    filterPanel.appendChild(colorGroup);

    // --- Timeline main content ---
    const timelineMain = document.createElement('div');
    timelineMain.className = 'project-timeline-main';

    const navEl = document.createElement('div');
    navEl.className = 'project-timeline-nav';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'project-nav-btn';
    prevBtn.setAttribute('aria-label', 'Previous window');
    prevBtn.innerHTML = `<span class="material-icons">chevron_left</span>`;
    prevBtn.addEventListener('click', onPrev);

    const rangeLabel = document.createElement('span');
    rangeLabel.className = 'project-nav-range';
    rangeLabel.textContent = `${isoDate(windowStart)} \u2013 ${isoDate(addDays(windowEnd, -1))}`;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'project-nav-btn';
    nextBtn.setAttribute('aria-label', 'Next window');
    nextBtn.innerHTML = `<span class="material-icons">chevron_right</span>`;
    nextBtn.addEventListener('click', onNext);

    navEl.appendChild(prevBtn);
    navEl.appendChild(rangeLabel);
    navEl.appendChild(nextBtn);
    timelineMain.appendChild(navEl);

    const timelineWrap = document.createElement('div');
    timelineWrap.className = 'project-timeline-wrap';

    // HTML tooltip div — lives outside the SVG so it's never clipped
    const tooltipEl = document.createElement('div');
    tooltipEl.className = 'pt-html-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);

    let assetsTableEl = null;

    // Detail section for foraging sessions (shown on dot click)
    const detailSection = document.createElement('div');
    detailSection.className = 'subject-detail-section project-detail-section';

    // Compute cell width — subtract filter panel (180px) + gap (16px) so SVG always fits
    const containerW = (contentEl.getBoundingClientRect().width || window.innerWidth) - 196;
    const cellW = Math.max(10, Math.floor((containerW - LABEL_W - 24) / numDays));

    const svgEl = buildTimelineSvg(filteredRawAssets, windowStart, (dayAssets) => {
      if (assetsTableEl) {
        assetsTableEl.clearHighlights?.();
        for (const asset of dayAssets) {
          assetsTableEl.goToAsset?.(asset.name ?? '');
        }
      }
      // Show foraging detail for behavior assets
      const behaviorAsset = dayAssets.find((a) => /^behavior_\d{6}_\d{4}-\d{2}-\d{2}/.test(a.name ?? ''));
      if (behaviorAsset && coordinator) {
        const match = behaviorAsset.name.match(/^behavior_(\d{6})_(\d{4}-\d{2}-\d{2})_(\d+)/);
        if (match) {
          detailSection.innerHTML = '';
          detailSection.appendChild(createForagingSessionDetail(
            { subject_id: match[1], session_date: match[2], nwb_suffix: match[3] },
            null,
            coordinator,
          ));
        }
      }
    }, { cellW, tooltipEl, viewMode, curriculumMap, numDays });
    timelineWrap.appendChild(svgEl);
    if (viewMode === 'curriculum') {
      const legendEl = buildCurriculumLegend(filteredRawAssets, windowStart, curriculumMap, numDays);
      if (legendEl) timelineWrap.appendChild(legendEl);
    }
    timelineMain.appendChild(timelineWrap);

    timelineBody.appendChild(filterPanel);
    timelineBody.appendChild(timelineMain);
    timelineSection.appendChild(timelineBody);

    // Assets table
    const assetsSection = document.createElement('div');
    assetsSection.className = 'subject-assets-section';
    assetsSection.innerHTML = '<h3>Assets</h3>';
    assetsTableEl = buildAssetsTable(allAssets, sourceMap);
    assetsSection.appendChild(assetsTableEl);

    loadingEl.replaceWith(infoEl);
    contentEl.appendChild(timelineSection);
    contentEl.appendChild(detailSection);
    contentEl.appendChild(assetsSection);

  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) return;
    console.error('[ProjectView] Failed:', err);
    loadingEl.replaceWith(_errorEl(`Failed to load data: ${err.message}`));
  }
}

function _errorEl(msg) {
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.textContent = msg;
  return el;
}

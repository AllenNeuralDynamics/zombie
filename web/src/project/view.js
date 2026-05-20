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
function buildTimelineSvg(assets, windowStart, onDotClick, { cellW = 70, tooltipEl = null } = {}) {
  const windowEnd = addDays(windowStart, 14);

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

  const numDays = 14;
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

  bySubjectDay.forEach((dayAssets, key) => {
    const [subjectId, dayStr] = key.split('|');
    const ri = subjects.indexOf(subjectId);
    if (ri === -1) return;
    const di = days.findIndex((d) => isoDate(d) === dayStr);
    if (di === -1) return;

    const cx = LABEL_W + di * cellW + cellW / 2;
    const cy = HEAD_H + ri * ROW_H + ROW_H / 2;
    const count = dayAssets.length;

    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    circle.setAttribute('r', DOT_R);
    circle.setAttribute('class', 'pt-dot');
    circle.style.cursor = 'pointer';
    svg.appendChild(circle);

    if (count > 1) {
      const countText = document.createElementNS(NS, 'text');
      countText.setAttribute('x', cx);
      countText.setAttribute('y', cy + 4);
      countText.setAttribute('class', 'pt-dot-count');
      countText.setAttribute('text-anchor', 'middle');
      countText.textContent = count;
      countText.style.pointerEvents = 'none';
      svg.appendChild(countText);
    }

    // HTML tooltip on hover — avoids SVG viewport clipping
    if (tooltipEl) {
      const showTip = (e) => {
        tooltipEl.innerHTML = dayAssets.map((a) => {
          const meta = [
            a.acquisition_type ? `type: ${a.acquisition_type}` : '',
            a.modalities ? `modalities: ${a.modalities}` : '',
          ].filter(Boolean).join(' · ');
          return `<div class="pt-tip-row"><div class="pt-tip-name">${a.name ?? ''}</div>${meta ? `<div class="pt-tip-meta">${meta}</div>` : ''}</div>`;
        }).join('');
        tooltipEl.style.display = '';
        tooltipEl.style.left = `${e.clientX + 14}px`;
        tooltipEl.style.top  = `${e.clientY + 14}px`;
      };
      circle.addEventListener('mouseenter', showTip);
      circle.addEventListener('mousemove', (e) => {
        tooltipEl.style.left = `${e.clientX + 14}px`;
        tooltipEl.style.top  = `${e.clientY + 14}px`;
      });
      circle.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
    }

    // Click: highlight asset row in table
    circle.addEventListener('click', () => onDotClick && onDotClick(dayAssets));
  });

  return svg;
}

// ---------------------------------------------------------------------------
// Main view factory
// ---------------------------------------------------------------------------

export function createProjectView(opts = {}) {
  const { coordinator } = opts;
  const params = new URLSearchParams(window.location.search);
  const initialProject = params.get('project') ?? '';

  const today = utcDay(new Date());
  let windowStart = addDays(today, -13);
  let currentProject = initialProject;
  let abortController = null;

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
    try {
      const url = new URL(window.location.href);
      url.search = p.toString();
      history.replaceState({}, '', url);
    } catch { /* restricted */ }

    _loadProject(contentEl, currentProject, coordinator, windowStart, abortController.signal, {
      onPrev: () => { windowStart = addDays(windowStart, -14); load(); },
      onNext: () => { windowStart = addDays(windowStart, 14); load(); },
    });
  }

  input.addEventListener('change', () => {
    currentProject = input.value.trim();
    windowStart = addDays(utcDay(new Date()), -13);
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

async function _loadProject(contentEl, projectName, coordinator, windowStart, signal, { onPrev, onNext } = {}) {
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

  const windowEnd = addDays(windowStart, 14);
  const safeProject = projectName.replace(/'/g, "''");

  try {
    // Fetch raw assets for the timeline
    const { assets: rawAssets } = await fetchAssetsWithSources(
      coordinator,
      `project_name = '${safeProject}' AND (data_level IS NULL OR data_level != 'derived')`,
    );
    if (signal?.aborted) return;

    // Fetch all assets (raw + derived) for the table
    const { assets: allAssets, sourceMap } = await fetchAssetsWithSources(
      coordinator,
      `project_name = '${safeProject}'`,
    );
    if (signal?.aborted) return;

    // Info card
    const infoEl = document.createElement('div');
    infoEl.className = 'subject-info-card';
    const subjectCount = new Set(rawAssets.map((a) => a.subject_id).filter(Boolean)).size;
    infoEl.innerHTML = `
      <h3>${projectName}</h3>
      <dl>
        <dt>Total assets</dt><dd>${allAssets.length}</dd>
        <dt>Subjects</dt><dd>${subjectCount}</dd>
      </dl>`;

    // Timeline section
    const timelineSection = document.createElement('div');
    timelineSection.className = 'subject-timeline-section project-timeline-section';

    const timelineHeader = document.createElement('div');
    timelineHeader.className = 'project-timeline-header';
    timelineHeader.innerHTML = `<h3>Acquisitions</h3>`;
    timelineSection.appendChild(timelineHeader);

    const timelineWrap = document.createElement('div');
    timelineWrap.className = 'project-timeline-wrap';

    // HTML tooltip div — lives outside the SVG so it's never clipped
    const tooltipEl = document.createElement('div');
    tooltipEl.className = 'pt-html-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);

    let assetsTableEl = null;

    // Compute cell width from available container width
    const containerW = contentEl.getBoundingClientRect().width || window.innerWidth;
    const cellW = Math.max(50, Math.floor((containerW - LABEL_W - 24) / 14));

    const svgEl = buildTimelineSvg(rawAssets, windowStart, (dayAssets) => {
      if (!assetsTableEl) return;
      for (const asset of dayAssets) {
        assetsTableEl.goToAsset?.(asset.name ?? '');
      }
    }, { cellW, tooltipEl });
    timelineWrap.appendChild(svgEl);
    timelineSection.appendChild(timelineWrap);

    // Navigation arrows
    const navEl = document.createElement('div');
    navEl.className = 'project-timeline-nav';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'project-nav-btn';
    prevBtn.setAttribute('aria-label', 'Previous two weeks');
    prevBtn.innerHTML = `<span class="material-icons">chevron_left</span>`;
    prevBtn.addEventListener('click', onPrev);

    const rangeLabel = document.createElement('span');
    rangeLabel.className = 'project-nav-range';
    rangeLabel.textContent = `${isoDate(windowStart)} – ${isoDate(addDays(windowEnd, -1))}`;

    const nextBtn = document.createElement('button');
    nextBtn.className = 'project-nav-btn';
    nextBtn.setAttribute('aria-label', 'Next two weeks');
    nextBtn.innerHTML = `<span class="material-icons">chevron_right</span>`;
    nextBtn.addEventListener('click', onNext);

    navEl.appendChild(prevBtn);
    navEl.appendChild(rangeLabel);
    navEl.appendChild(nextBtn);
    timelineSection.appendChild(navEl);

    // Assets table
    const assetsSection = document.createElement('div');
    assetsSection.className = 'subject-assets-section';
    assetsSection.innerHTML = '<h3>Assets</h3>';
    assetsTableEl = buildAssetsTable(allAssets, sourceMap);
    assetsSection.appendChild(assetsTableEl);

    loadingEl.replaceWith(infoEl);
    contentEl.appendChild(timelineSection);
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

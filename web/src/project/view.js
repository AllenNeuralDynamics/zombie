/**
 * project/view.js — Project overview page (/project?project=<name>).
 *
 * Queries asset_basics for all assets in the selected project and renders:
 *   1. Project selector (synced to URL ?project=)
 *   2. Two-week acquisition timeline (subjects as rows, days as columns)
 *      with < > navigation arrows shifting by two weeks at a time.
 *   3. Grouped assets table at the bottom (shared with subject page).
 */

import { arrowTableToRows } from '../lib/arrow.js';
import { buildAssetsTable, fetchAssetsWithSources } from '../lib/assets-table.js';
import { buildModalityHistogram } from '../lib/charts.js';
import { createForagingSessionDetail } from '../lib/behaviors/dynamic-foraging.js';
import { ensureTable } from '../lib/registry.js';
import {
  utcDay, addDays, isoDate,
  buildTimelineSvg, buildCurriculumLegend,
  TIMELINE_LABEL_W,
} from '../lib/behavior-timeline.js';

// ---------------------------------------------------------------------------
// Date helpers (utcDay, addDays, isoDate imported from lib/behavior-timeline.js)
// ---------------------------------------------------------------------------

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
      await ensureTable(coordinator, 'behavior_curriculum');
      const currResult = await coordinator.query(`
        SELECT a.name, c.curriculum_name, c.stage_name, c.stage_node_id
        FROM asset_basics a
        LEFT JOIN behavior_curriculum c ON a.name = c.asset_name
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
    const cellW = Math.max(10, Math.floor((containerW - TIMELINE_LABEL_W - 24) / numDays));

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

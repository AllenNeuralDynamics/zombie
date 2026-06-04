/**
 * dynamic_foraging/view.js — Dynamic Foraging Platform dashboard.
 *
 * Shows the platform overview section (summary stats + QC table) followed by
 * a filterable acquisition-figures gallery (choice_history.png per session).
 */

import { createPlatformOverview } from '../lib/platform-overview.js';
import { ensureForagingTable } from '../lib/behaviors/foraging-metadata.js';
import { buildChoiceHistoryUrl } from '../lib/behaviors/dynamic-foraging.js';
import { arrowTableToRows } from '../lib/assets-table.js';

import {
  utcDay, addDays, isoDate,
  buildTimelineSvg, buildCurriculumLegend,
  TIMELINE_LABEL_W,
} from '../lib/behavior-timeline.js';

// URL for the curriculum parquet (same source used by project/view.js)
const CURRICULUM_PARQUET_URL =
  'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/zs_behavior_curriculum.pqt';

// Maximum figures shown at once (prevents DOM explosion)
const MAX_FIGURES = 60;

// URL query-param / cookie key names for the figures filter state
const PARAM_SINCE     = 'df_since';
const PARAM_TRAINERS  = 'df_trainers';
const PARAM_CURRICULA = 'df_curricula';
const PARAM_STAGES    = 'df_stages';
const PARAM_COLOR_BY  = 'df_color_by';

// ---------------------------------------------------------------------------
// Cookie helpers (scoped to this module)
// ---------------------------------------------------------------------------

function _readCookie(name) {
  const m = ('; ' + document.cookie).split(`; ${name}=`);
  if (m.length < 2) return null;
  return decodeURIComponent(m.pop().split(';')[0]);
}

function _writeCookie(name, value) {
  const exp = new Date(Date.now() + 365 * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function createDynamicForagingView(coord) {
  const container = document.createElement('div');
  container.className = 'assets-view dynamic-foraging-view';

  container.appendChild(
    createPlatformOverview(coord, {
      platformKey: 'dynamic_foraging',
      assetFilter: { type: 'acquisition_type_regex', value: '(Uncoupled|Coupled)( Without)? Baiting' },
    }),
  );

  container.appendChild(_createFiguresSection(coord));

  return container;
}

// ---------------------------------------------------------------------------
// Figures section
// ---------------------------------------------------------------------------

function _createFiguresSection(coord) {
  const section = document.createElement('div');
  section.className = 'df-figures-section';

  const heading = document.createElement('h3');
  heading.className = 'platform-summary-heading df-figures-heading';
  heading.textContent = 'Acquisition Figures';
  section.appendChild(heading);

  const loadingEl = document.createElement('div');
  loadingEl.className = 'loading-message';
  loadingEl.textContent = 'Loading session data…';
  section.appendChild(loadingEl);

  _loadFiguresSection(coord, section, loadingEl);

  return section;
}

async function _loadFiguresSection(coord, section, loadingEl) {
  let allSessions = [];

  try {
    await ensureForagingTable(coord);

    // Load foraging sessions joined with the curriculum table to get stage_node_id.
    // Join on (curriculum_name, stage_name) since the asset_name format in the parquet
    // uses full timestamps and doesn't match our session date keys.
    const result = await coord.query(`
      SELECT
        f.subject_id,
        f.session_date,
        f.nwb_suffix,
        f.trainer_normalized AS trainer,
        f.curriculum_name,
        f.current_stage_actual AS stage_name,
        c.stage_node_id
      FROM zs_foraging_sessions f
      LEFT JOIN (
        SELECT DISTINCT curriculum_name, stage_name, stage_node_id
        FROM read_parquet('${CURRICULUM_PARQUET_URL}')
        WHERE stage_node_id IS NOT NULL
      ) c ON c.curriculum_name = f.curriculum_name
         AND c.stage_name = f.current_stage_actual
      ORDER BY f.session_date DESC, f.subject_id ASC
    `);
    allSessions = arrowTableToRows(result);
  } catch (err) {
    console.warn('[DFView] curriculum join failed, falling back to sessions-only query:', err);
    try {
      const result = await coord.query(`
        SELECT subject_id, session_date, nwb_suffix, trainer_normalized AS trainer,
               curriculum_name, current_stage_actual AS stage_name,
               NULL AS stage_node_id
        FROM zs_foraging_sessions
        ORDER BY session_date DESC, subject_id ASC
      `);
      allSessions = arrowTableToRows(result);
    } catch (err2) {
      loadingEl.textContent = `Failed to load session data: ${err2?.message ?? err2}`;
      loadingEl.className = 'loading-message error';
      return;
    }
  }

  loadingEl.remove();

  if (allSessions.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'detail-placeholder';
    empty.textContent = 'No foraging sessions found.';
    section.appendChild(empty);
    return;
  }

  // Unique sorted options for each filter dimension
  const allTrainers  = _unique(allSessions, 'trainer');
  const allCurricula = _unique(allSessions, 'curriculum_name');
  const allStages    = _unique(allSessions, 'stage_name');

  // ---------------------------------------------------------------------------
  // Restore state from URL params (priority) then cookies, then defaults
  // ---------------------------------------------------------------------------
  const _urlParams = new URLSearchParams(window.location.search);

  function _readParam(key) {
    const url = _urlParams.get(key);
    if (url !== null) return url;
    return _readCookie(key) ?? null;
  }

  function _parseSet(raw, allOptions) {
    if (!raw) return new Set();
    // Validate against known options to avoid stale/injected values
    const allowed = new Set(allOptions);
    const s = new Set(raw.split('|').filter((v) => allowed.has(v)));
    return s;
  }

  const _rawSince = _readParam(PARAM_SINCE);
  // null means "not stored" → use default (last week). '' means "all time".
  let sinceDate = _rawSince !== null ? (_rawSince || null) : _computeSince(0, 7);

  const selTrainers  = _parseSet(_readParam(PARAM_TRAINERS),  allTrainers);
  const selCurricula = _parseSet(_readParam(PARAM_CURRICULA), allCurricula);
  const selStages    = _parseSet(_readParam(PARAM_STAGES),    allStages);

  const _rawColorBy = _readParam(PARAM_COLOR_BY);
  let colorBy = (_rawColorBy === 'modality' || _rawColorBy === 'curriculum') ? _rawColorBy : 'modality';

  // ---------------------------------------------------------------------------
  // Persist current filter state to URL + cookies
  // ---------------------------------------------------------------------------
  function _persist() {
    const p = new URLSearchParams(window.location.search);

    const setOrDel = (key, val) => val ? p.set(key, val) : p.delete(key);
    setOrDel(PARAM_SINCE,     sinceDate ?? '');
    setOrDel(PARAM_TRAINERS,  [...selTrainers].join('|'));
    setOrDel(PARAM_CURRICULA, [...selCurricula].join('|'));
    setOrDel(PARAM_STAGES,    [...selStages].join('|'));
    p.set(PARAM_COLOR_BY, colorBy);

    try {
      history.replaceState({}, '', `?${p.toString()}`);
    } catch { /* cross-origin guard */ }

    _writeCookie(PARAM_SINCE,     sinceDate ?? '');
    _writeCookie(PARAM_TRAINERS,  [...selTrainers].join('|'));
    _writeCookie(PARAM_CURRICULA, [...selCurricula].join('|'));
    _writeCookie(PARAM_STAGES,    [...selStages].join('|'));
    _writeCookie(PARAM_COLOR_BY,  colorBy);
  }

  // -- Layout ----------------------------------------------------------------
  const layout = document.createElement('div');
  layout.className = 'df-figures-layout';
  section.appendChild(layout);

  // Left: filter panel
  const filterPanel = document.createElement('div');
  filterPanel.className = 'sessions-filter-panel df-filter-panel';

  const panelTitle = document.createElement('h3');
  panelTitle.className = 'sessions-panel-title';
  panelTitle.textContent = 'Filters';
  filterPanel.appendChild(panelTitle);

  // Right: main column (timeline on top, figures below)
  const rightCol = document.createElement('div');
  rightCol.className = 'df-figures-panel';

  // Timeline area
  const timelineWrap = document.createElement('div');
  timelineWrap.className = 'df-timeline-wrap';
  rightCol.appendChild(timelineWrap);

  // Figures panel (count + grid)
  const figuresPanel = document.createElement('div');
  figuresPanel.className = 'df-figures-inner';
  rightCol.appendChild(figuresPanel);

  layout.appendChild(filterPanel);
  layout.appendChild(rightCol);

  // HTML tooltip for timeline hover
  const tooltipEl = document.createElement('div');
  tooltipEl.className = 'pt-html-tooltip';
  tooltipEl.style.display = 'none';
  document.body.appendChild(tooltipEl);

  // -- Checkbox helper -------------------------------------------------------
  function buildCheckboxGroup(title, options, selectedSet) {
    const wrapper = document.createElement('div');
    wrapper.className = 'sessions-filter-group';

    const labelEl = document.createElement('div');
    labelEl.className = 'sessions-filter-label';
    labelEl.textContent = title;
    wrapper.appendChild(labelEl);

    const list = document.createElement('div');
    list.className = 'sessions-checkbox-list';
    wrapper.appendChild(list);

    for (const opt of options) {
      const item = document.createElement('label');
      item.className = 'sessions-checkbox-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = opt;
      cb.checked = selectedSet.has(opt);
      cb.addEventListener('change', () => {
        if (cb.checked) selectedSet.add(opt);
        else selectedSet.delete(opt);
        _persist();
        renderAll();
      });
      item.appendChild(cb);
      item.appendChild(document.createTextNode('\u00a0' + opt));
      list.appendChild(item);
    }

    const clearBtn = document.createElement('button');
    clearBtn.className = 'sessions-filter-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      selectedSet.clear();
      for (const cb of list.querySelectorAll('input[type=checkbox]')) cb.checked = false;
      _persist();
      renderAll();
    });
    wrapper.appendChild(clearBtn);

    return wrapper;
  }

  filterPanel.appendChild(buildCheckboxGroup('Trainer / Experimenter', allTrainers, selTrainers));
  filterPanel.appendChild(buildCheckboxGroup('Curriculum', allCurricula, selCurricula));
  filterPanel.appendChild(buildCheckboxGroup('Curriculum Stage', allStages, selStages));
  filterPanel.appendChild(_buildDateFilter(() => sinceDate, (d) => { sinceDate = d; _persist(); renderAll(); }));

  // Color-by selector (affects timeline only)
  const colorByGroup = document.createElement('div');
  colorByGroup.className = 'sessions-filter-group';
  const colorByLabel = document.createElement('div');
  colorByLabel.className = 'sessions-filter-label';
  colorByLabel.textContent = 'Color timeline by';
  colorByGroup.appendChild(colorByLabel);
  const colorBySelect = document.createElement('select');
  colorBySelect.className = 'project-filter-select';
  [{ value: 'modality', label: 'Modality' }, { value: 'curriculum', label: 'Curriculum stage' }]
    .forEach(({ value, label }) => {
      const opt = document.createElement('option');
      opt.value = value; opt.textContent = label;
      if (value === colorBy) opt.selected = true;
      colorBySelect.appendChild(opt);
    });
  colorBySelect.addEventListener('change', () => {
    colorBy = colorBySelect.value;
    _persist();
    renderAll();
  });
  colorByGroup.appendChild(colorBySelect);
  filterPanel.appendChild(colorByGroup);

  // Push whatever was resolved from URL/cookie into the URL immediately
  _persist();

  // -- Combined render -------------------------------------------------------
  function renderAll() {
    const filtered = allSessions.filter((s) =>
      (!sinceDate || (s.session_date ?? '') >= sinceDate) &&
      (selTrainers.size  === 0 || selTrainers.has(s.trainer)) &&
      (selCurricula.size === 0 || selCurricula.has(s.curriculum_name ?? '')) &&
      (selStages.size    === 0 || selStages.has(s.stage_name ?? '')),
    );
    renderTimeline(filtered);
    renderFigures(filtered);
  }

  // -- Timeline renderer -----------------------------------------------------
  function renderTimeline(filtered) {
    document.querySelectorAll('.pt-html-tooltip').forEach((el) => {
      if (el !== tooltipEl) el.remove();
    });
    tooltipEl.style.display = 'none';

    // Build curriculum map for colour coding.
    // For curricula that appear in the parquet, stage_node_id comes from the join.
    // For the main DF curricula (Coupled/Uncoupled Baiting etc.) the parquet has no
    // matching rows, so we infer a node ID from the stage name pattern instead.
    const curriculumMap = new Map();
    for (const s of filtered) {
      const assetName = `behavior_${s.subject_id}_${s.session_date}` +
        (s.nwb_suffix && String(s.nwb_suffix) !== '0' && String(s.nwb_suffix) !== ''
          ? `_${s.nwb_suffix}` : '');
      if (s.curriculum_name) {
        let nodeId = s.stage_node_id != null ? Math.round(Number(s.stage_node_id)) : null;
        if (nodeId == null && s.stage_name) {
          nodeId = _inferStageNodeId(s.stage_name);
        }
        curriculumMap.set(assetName, {
          curriculum_name: s.curriculum_name,
          stage_name: s.stage_name ?? null,
          stage_node_id: nodeId,
        });
      }
    }

    // Compute window: sinceDate to today (capped at 90 days for readability)
    const today = utcDay(new Date());
    const windowStart = sinceDate
      ? utcDay(new Date(sinceDate + 'T00:00:00Z'))
      : addDays(today, -13);
    const rawDays = Math.round((today.getTime() - windowStart.getTime()) / 86400000) + 1;
    const numDays = Math.min(Math.max(rawDays, 1), 90);

    // Convert sessions to synthetic asset objects for the timeline
    const assets = filtered.map((s) => ({
      subject_id: String(s.subject_id ?? ''),
      name: `behavior_${s.subject_id}_${s.session_date}` +
        (s.nwb_suffix && String(s.nwb_suffix) !== '0' && String(s.nwb_suffix) !== ''
          ? `_${s.nwb_suffix}` : ''),
      acquisition_start_time: s.session_date ? (s.session_date + 'T12:00:00Z') : null,
      modalities: 'behavior',
    }));

    timelineWrap.innerHTML = '';

    if (assets.length === 0) return;

    // cellW: available width minus filter panel (~250px) minus label width
    const containerW = (section.getBoundingClientRect().width || window.innerWidth) - 260;
    const cellW = Math.max(8, Math.floor((containerW - TIMELINE_LABEL_W - 24) / numDays));

    const rangeLabel = document.createElement('div');
    rangeLabel.className = 'df-timeline-range';
    rangeLabel.textContent =
      `${isoDate(windowStart)} \u2013 ${isoDate(addDays(windowStart, numDays - 1))}`;
    timelineWrap.appendChild(rangeLabel);

    const svgEl = buildTimelineSvg(assets, windowStart, (dayAssets) => {
      // Highlight figure cards matching clicked day's assets
      const nameSet = new Set(dayAssets.map((a) => a.name));
      const cards = figuresPanel.querySelectorAll('.df-figure-card[data-name]');
      let firstHighlighted = null;
      for (const card of cards) {
        if (nameSet.has(card.dataset.name)) {
          card.classList.add('df-figure-card--highlighted');
          if (!firstHighlighted) firstHighlighted = card;
        } else {
          card.classList.remove('df-figure-card--highlighted');
        }
      }
      firstHighlighted?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, { cellW, tooltipEl, viewMode: colorBy, curriculumMap, numDays });

    timelineWrap.appendChild(svgEl);

    if (colorBy === 'curriculum') {
      const legendEl = buildCurriculumLegend(assets, windowStart, curriculumMap, numDays);
      if (legendEl) timelineWrap.appendChild(legendEl);
    }
  }

  // -- Figure renderer -------------------------------------------------------
  function renderFigures(filtered) {

    figuresPanel.innerHTML = '';

    const countEl = document.createElement('div');
    countEl.className = 'df-figures-count';
    const shown = Math.min(filtered.length, MAX_FIGURES);
    countEl.textContent = filtered.length === 0
      ? 'No sessions match the selected filters.'
      : `Showing ${shown}${filtered.length > MAX_FIGURES ? ` of ${filtered.length}` : ''} session${shown !== 1 ? 's' : ''}, most recent first.`;
    figuresPanel.appendChild(countEl);

    if (filtered.length === 0) return;

    const grid = document.createElement('div');
    grid.className = 'df-figures-grid';
    figuresPanel.appendChild(grid);

    for (const s of filtered.slice(0, MAX_FIGURES)) {
      const card = document.createElement('div');
      card.className = 'df-figure-card';
      const assetName = `behavior_${s.subject_id}_${s.session_date}` +
        (s.nwb_suffix && String(s.nwb_suffix) !== '0' && String(s.nwb_suffix) !== ''
          ? `_${s.nwb_suffix}` : '');
      card.dataset.name = assetName;

      const imgUrl = buildChoiceHistoryUrl(s.subject_id, s.session_date, s.nwb_suffix);

      const imgLink = document.createElement('a');
      imgLink.href = imgUrl;
      imgLink.target = '_blank';
      imgLink.rel = 'noopener noreferrer';
      imgLink.className = 'df-figure-img-link';

      const img = document.createElement('img');
      img.src = imgUrl;
      img.alt = `Choice history: ${s.subject_id} ${s.session_date}`;
      img.className = 'df-figure-img';
      img.loading = 'lazy';
      img.onerror = () => {
        imgLink.remove();
        const missing = document.createElement('div');
        missing.className = 'df-figure-missing';
        missing.textContent = 'Figure not available';
        card.insertBefore(missing, card.firstChild);
        card.classList.add('df-figure-card--no-img');
      };

      imgLink.appendChild(img);
      card.appendChild(imgLink);

      const caption = document.createElement('div');
      caption.className = 'df-figure-caption';

      const subjectLink = document.createElement('a');
      subjectLink.href = `/subject?subject_id=${encodeURIComponent(s.subject_id ?? '')}`;
      subjectLink.className = 'df-figure-subject';
      subjectLink.textContent = s.subject_id ?? '';

      const dateSpan = document.createElement('span');
      dateSpan.className = 'df-figure-date';
      dateSpan.textContent = s.session_date ?? '';

      caption.appendChild(subjectLink);
      caption.appendChild(document.createTextNode(' · '));
      caption.appendChild(dateSpan);

      if (s.trainer) {
        const trainerSpan = document.createElement('span');
        trainerSpan.className = 'df-figure-meta';
        trainerSpan.textContent = s.trainer;
        caption.appendChild(document.createElement('br'));
        caption.appendChild(trainerSpan);
      }

      if (s.stage_name) {
        const stageSpan = document.createElement('span');
        stageSpan.className = 'df-figure-stage';
        stageSpan.textContent = s.stage_name;
        caption.appendChild(document.createElement('br'));
        caption.appendChild(stageSpan);
      }

      card.appendChild(caption);
      grid.appendChild(card);
    }
  }

  // Initial render
  renderAll();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Unique non-empty values for a plain column, sorted. */
function _unique(rows, key) {
  return [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort();
}


/**
 * Compute a YYYY-MM-DD date string N days before today.
 * Pass months via { months } or days via { days }.
 */
function _computeSince(months, days = 0) {
  const d = new Date();
  if (days) {
    d.setDate(d.getDate() - days);
  } else if (months) {
    d.setMonth(d.getMonth() - months);
  } else {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

const DATE_PRESETS = [
  { label: '— Quick select —', key: null },
  { label: 'Last week',     key: '7d' },
  { label: 'Last month',    key: '1m' },
  { label: 'Last 3 months', key: '3m' },
  { label: 'Last 6 months', key: '6m' },
  { label: 'Last year',     key: '12m' },
  { label: 'All time',      key: '' },
];

function _presetToDate(key) {
  if (key === null || key === undefined) return undefined; // placeholder
  if (key === '') return null; // all time
  if (key.endsWith('d')) return _computeSince(0, parseInt(key, 10));
  return _computeSince(parseInt(key, 10));
}

/**
 * Build the "Show sessions since" filter widget.
 *
 * @param {() => string|null} getSince - Returns current since date (YYYY-MM-DD or null).
 * @param {(date: string|null) => void} onChange - Called with new date on change.
 * @returns {HTMLElement}
 */
function _buildDateFilter(getSince, onChange) {
  const wrapper = document.createElement('div');
  wrapper.className = 'sessions-filter-group';

  const label = document.createElement('div');
  label.className = 'sessions-filter-label';
  label.textContent = 'Show sessions since';
  wrapper.appendChild(label);

  const presetSel = document.createElement('select');
  presetSel.className = 'df-since-select';
  for (const p of DATE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.key === null ? '__placeholder__' : p.key;
    opt.textContent = p.label;
    if (p.key === null) { opt.disabled = true; opt.hidden = true; }
    presetSel.appendChild(opt);
  }
  // Reflect the initial sinceDate back onto the select if it matches a preset
  presetSel.value = '__placeholder__';
  wrapper.appendChild(presetSel);

  const dateRow = document.createElement('div');
  dateRow.className = 'df-since-row';

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.className = 'df-since-date';
  dateInput.value = getSince() ?? '';

  const allTimeBtn = document.createElement('button');
  allTimeBtn.type = 'button';
  allTimeBtn.className = 'sessions-filter-clear';
  allTimeBtn.textContent = 'All time';

  dateRow.appendChild(dateInput);
  dateRow.appendChild(allTimeBtn);
  wrapper.appendChild(dateRow);

  presetSel.addEventListener('change', () => {
    const key = presetSel.value;
    if (key === '__placeholder__') return;
    const computed = _presetToDate(key);
    dateInput.value = computed ?? '';
    presetSel.value = '__placeholder__';
    onChange(computed);
  });

  dateInput.addEventListener('change', () => {
    onChange(dateInput.value || null);
  });

  allTimeBtn.addEventListener('click', () => {
    dateInput.value = '';
    onChange(null);
  });

  return wrapper;
}

/**
 * Infer a numeric stage node ID from a stage name string when the curriculum
 * parquet has no entry for this curriculum (e.g. "Coupled Baiting" curricula).
 *
 * Handles patterns like STAGE_1, STAGE_1_WARMUP, STAGE_2, …, STAGE_FINAL, GRADUATED.
 * Returns null if the pattern is unrecognised.
 */
function _inferStageNodeId(stageName) {
  if (!stageName) return null;
  const s = stageName.toUpperCase();
  if (s === 'STAGE_1_WARMUP') return 0;
  const numMatch = s.match(/^STAGE_(\d+)/);
  if (numMatch) return parseInt(numMatch[1], 10);
  if (s === 'STAGE_FINAL') return 5;
  if (s === 'GRADUATED') return 6;
  return null;
}

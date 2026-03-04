/**
 * time-view.js — Session Timeline with intervalX brush selection.
 *
 * Shows all sessions for the selected project as horizontal rectangles on
 * a time axis. The user drags to select a time range; the resulting
 * Selection cross-filters all DataView plots.
 *
 * Pure helper functions (buildRectMarkOptions, buildProjectClause, constants)
 * are exported so they can be unit-tested without a live coordinator.
 * createTimeView() requires a running duckdb-server + real DOM.
 */

import {
  Selection,
  coordinator,
  plot,
  from,
  rect,
  intervalX,
  height,
  xLabel,
  xScale,
  yLabel,
  style,
} from '@uwdata/vgplot';

import { AIND_COLORS, TIME_VIEW_HEIGHT } from './constants.js';

// ---------------------------------------------------------------------------
// # Column / table name constants (pure, exported for testing)
// ---------------------------------------------------------------------------

/** DuckDB table that holds one row per asset. */
export const TIME_TABLE = 'asset_basics';

/** Column: acquisition start timestamp. Maps to the x1 rect edge. */
export const TIME_COL_START = 'acquisition_start_time';

/** Column: acquisition end timestamp. Maps to the x2 rect edge. */
export const TIME_COL_END = 'acquisition_end_time';

/** Column: subject identifier. Used as the y-axis grouping. */
export const TIME_COL_SUBJECT = 'subject_id';

/** Column: project name. Used to filter rows to the selected projects. */
export const TIME_COL_PROJECT = 'project_name';

// ---------------------------------------------------------------------------
// # Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Build the vgplot rect mark encoding options for the TimeView.
 *
 * Extracted as a pure function so the column-name contract can be tested
 * independently of the Mosaic coordinator.
 *
 * @param {string} [fill] - Rectangle fill colour (CSS colour string).
 * @returns {object} Encoding options to pass to the vgplot `rect` mark.
 */
export function buildRectMarkOptions(fill = AIND_COLORS.light_blue, fillOpacity = 0.7) {
  return {
    x1: TIME_COL_START,
    x2: TIME_COL_END,
    y: TIME_COL_SUBJECT,
    fill,
    fillOpacity,
  };
}

/**
 * Build a Mosaic Selection clause from a query filter object.
 *
 * Combines project names (IN clause) and arbitrary extra column filters
 * (each also an IN clause) into a single AND-joined SQL predicate that is
 * passed to `Selection.update()`.
 *
 * @param {{ projects: string[], extraFilters: Array<{column: string, values: string[]}> }|null} queryFilter
 * @returns {{ source: string, value: object|null, predicate: { toString(): string }|null }}
 */
export function buildQueryClause(queryFilter) {
  const { projects = [], extraFilters = [] } = queryFilter || {};
  const parts = [];

  if (projects.length > 0) {
    const quoted = projects
      .map((p) => "'" + String(p).replace(/'/g, "''") + "'")
      .join(', ');
    parts.push(`"${TIME_COL_PROJECT}" IN (${quoted})`);
  }

  for (const f of extraFilters) {
    if (Array.isArray(f.values) && f.values.length > 0) {
      const col = f.column.replace(/"/g, '""');
      const quoted = f.values
        .map((v) => "'" + String(v).replace(/'/g, "''") + "'")
        .join(', ');
      parts.push(`"${col}" IN (${quoted})`);
    }
  }

  const combined = parts.join(' AND ');
  return {
    source: 'query',
    value: queryFilter ?? null,
    predicate: combined ? { toString: () => combined } : null,
  };
}

// ---------------------------------------------------------------------------
// # Height calculation (pure, exported for testing)
// ---------------------------------------------------------------------------

/**
 * Compute the TimeView plot height based on the number of unique subjects.
 *
 * Up to 25 subjects uses `baseHeight` unchanged. Beyond that, every additional
 * group of 25 subjects adds 100 px so long runs of sessions don't overlap.
 *
 * @param {number} subjectCount - Number of distinct subjects in the current project.
 * @param {number} [baseHeight=TIME_VIEW_HEIGHT] - Minimum height in pixels.
 * @returns {number} Height in pixels.
 */
export function computeTimeViewHeight(subjectCount, baseHeight = TIME_VIEW_HEIGHT) {
  if (subjectCount <= 25) return baseHeight;
  return baseHeight + Math.ceil((subjectCount - 25) / 25) * 100;
}

// ---------------------------------------------------------------------------
// # Component factory (requires live coordinator + DOM)
// ---------------------------------------------------------------------------

/**
 * Create the TimeView component.
 *
 * Builds a vgplot `rect` plot backed by the `asset_basics` DuckDB table,
 * filtered to the current query filter (selected projects + extra column
 * filters). Attaches an `intervalX` interactor that populates the returned
 * `$timeSelection`.
 *
 * @param {import('@uwdata/mosaic-core').Param} $queryFilter
 *   Reactive Param holding `{ projects: string[], extraFilters: [] }`
 *   (from settings.js). The TimeView subscribes to value changes to
 *   update its filter.
 *
 * @returns {{
 *   $timeSelection: import('@uwdata/mosaic-core').Selection,
 *   el: HTMLDivElement,
 * }}
 *   - `$timeSelection`: crossfilter Selection populated by brush gestures;
 *     pass as `filterBy` to DataView marks.
 *   - `el`: container DOM element ready to append to the page.
 */
export function createTimeView($queryFilter) {
  // ── Shared cross-filter selection ─────────────────────────────────────────
  const $timeSelection = Selection.crossfilter();

  // ── Query-scoped filter ───────────────────────────────────────────────────
  const $queryFilterSel = Selection.intersect();

  function applyQueryFilter(value) {
    $queryFilterSel.update(buildQueryClause(value));
  }

  applyQueryFilter($queryFilter.value);
  $queryFilter.addEventListener('value', applyQueryFilter);

  // ── Plot config ───────────────────────────────────────────────────────────
  const plotConfig = {
    plotHeight: 0,                          // 0 = auto-compute from subjects
    fillColor: AIND_COLORS.light_blue,
    fillOpacity: 0.7,
    fontSize: 6,
  };

  // ── Auto height ───────────────────────────────────────────────────────────
  let autoHeight = TIME_VIEW_HEIGHT;

  async function updateAutoHeight(queryFilter) {
    const { projects = [], extraFilters = [] } = queryFilter || {};
    if (projects.length === 0 && extraFilters.length === 0) return;
    try {
      const parts = [];
      if (projects.length > 0) {
        const quoted = projects
          .map((p) => "'" + String(p).replace(/'/g, "''") + "'")
          .join(', ');
        parts.push(`"${TIME_COL_PROJECT}" IN (${quoted})`);
      }
      for (const f of extraFilters) {
        if (Array.isArray(f.values) && f.values.length > 0) {
          const col = f.column.replace(/"/g, '""');
          const quoted = f.values
            .map((v) => "'" + String(v).replace(/'/g, "''") + "'")
            .join(', ');
          parts.push(`"${col}" IN (${quoted})`);
        }
      }
      const whereClause = parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '';
      const result = await coordinator().query(
        `SELECT COUNT(DISTINCT "${TIME_COL_SUBJECT}") AS n FROM ${TIME_TABLE} ${whereClause}`,
      );
      const n = Number(result.getChild('n')?.get(0) ?? 25);
      autoHeight = computeTimeViewHeight(n);
      if (plotConfig.plotHeight === 0) rebuildPlot();
    } catch (err) {
      console.warn('[ZOMBIE] TimeView height query failed:', err);
    }
  }

  updateAutoHeight($queryFilter.value);
  $queryFilter.addEventListener('value', updateAutoHeight);

  // ── Plot wrapper + rebuild ────────────────────────────────────────────────
  const plotWrapEl = document.createElement('div');
  plotWrapEl.className = 'tv-plot-wrap';

  function rebuildPlot() {
    plotWrapEl.innerHTML = '';
    const h = plotConfig.plotHeight > 0 ? plotConfig.plotHeight : autoHeight;
    const newPlot = plot(
      rect(
        from(TIME_TABLE, { filterBy: $queryFilterSel }),
        buildRectMarkOptions(plotConfig.fillColor, plotConfig.fillOpacity),
      ),
      intervalX({ as: $timeSelection }),
      height(h),
      xScale('utc'),
      xLabel('Acquisition time'),
      yLabel(null),
      style({ background: 'transparent', fontSize: `${plotConfig.fontSize}px` }),
    );
    plotWrapEl.appendChild(newPlot);
  }

  // ── Container ─────────────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.className = 'card time-view';
  container.id = 'time-view';

  // Header row: title + gear btn + collapse btn
  const headerRow = document.createElement('div');
  headerRow.className = 'tv-header-row';

  const headerTitle = document.createElement('h3');
  headerTitle.className = 'view-header';
  headerTitle.textContent = 'Session Timeline';
  headerRow.appendChild(headerTitle);

  const gearBtn = document.createElement('button');
  gearBtn.type = 'button';
  gearBtn.className = 'dv-gear-btn';
  gearBtn.title = 'Timeline appearance settings';
  gearBtn.innerHTML = '&#9881;'; // ⚙
  headerRow.appendChild(gearBtn);

  const collapseBtn = document.createElement('button');
  collapseBtn.type = 'button';
  collapseBtn.className = 'tv-collapse-btn';
  collapseBtn.title = 'Collapse timeline';
  collapseBtn.innerHTML = '&#9650;'; // ▲
  headerRow.appendChild(collapseBtn);

  container.appendChild(headerRow);

  // ── Plot controls panel (hidden by default) ───────────────────────────────
  const plotControlsEl = document.createElement('div');
  plotControlsEl.className = 'dv-plot-controls';
  plotControlsEl.hidden = true;
  container.appendChild(plotControlsEl);

  function buildPlotControls() {
    plotControlsEl.innerHTML = '';

    function addControlRow(labelText, inputEl) {
      const row = document.createElement('label');
      row.className = 'dv-ctrl-row';
      const span = document.createElement('span');
      span.textContent = labelText;
      row.appendChild(span);
      row.appendChild(inputEl);
      plotControlsEl.appendChild(row);
      return inputEl;
    }

    function makeNumber(value, min, max, step = 1) {
      const el = document.createElement('input');
      el.type = 'number';
      el.className = 'dv-ctrl-input dv-ctrl-number';
      el.value = value;
      el.min = min;
      el.max = max;
      el.step = step;
      return el;
    }

    // Height (0 = auto)
    const heightInput = addControlRow('Height (px, 0=auto)', makeNumber(plotConfig.plotHeight, 0, 1200, 50));
    heightInput.addEventListener('change', () => { plotConfig.plotHeight = Number(heightInput.value); rebuildPlot(); });

    // Fill color
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'dv-ctrl-color';
    colorInput.value = plotConfig.fillColor;
    colorInput.addEventListener('input', () => { plotConfig.fillColor = colorInput.value; rebuildPlot(); });
    const colorRow = document.createElement('label');
    colorRow.className = 'dv-ctrl-row';
    const colorSpan = document.createElement('span');
    colorSpan.textContent = 'Mark color';
    colorRow.appendChild(colorSpan);
    colorRow.appendChild(colorInput);
    plotControlsEl.appendChild(colorRow);

    // Fill opacity
    const opacityInput = addControlRow('Opacity (0–1)', makeNumber(plotConfig.fillOpacity, 0, 1, 0.05));
    opacityInput.addEventListener('input', () => { plotConfig.fillOpacity = Number(opacityInput.value); rebuildPlot(); });

    // Font size
    const fontInput = addControlRow('Font size (px)', makeNumber(plotConfig.fontSize, 4, 32));
    fontInput.addEventListener('change', () => { plotConfig.fontSize = Number(fontInput.value); rebuildPlot(); });
  }

  buildPlotControls();

  gearBtn.addEventListener('click', () => {
    plotControlsEl.hidden = !plotControlsEl.hidden;
    gearBtn.classList.toggle('dv-gear-btn--active', !plotControlsEl.hidden);
    if (!plotControlsEl.hidden) buildPlotControls(); // refresh with current values
  });

  // ── Collapsible body ──────────────────────────────────────────────────────
  const bodyEl = document.createElement('div');
  bodyEl.className = 'tv-body';
  bodyEl.appendChild(plotWrapEl);
  container.appendChild(bodyEl);

  let collapsed = false;
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    bodyEl.hidden = collapsed;
    if (collapsed) {
      plotControlsEl.hidden = true;
      gearBtn.classList.remove('dv-gear-btn--active');
    }
    collapseBtn.innerHTML = collapsed ? '&#9660;' : '&#9650;'; // ▼ or ▲
    collapseBtn.title = collapsed ? 'Expand timeline' : 'Collapse timeline';
    container.classList.toggle('time-view--collapsed', collapsed);
  });

  // ── Initial build ─────────────────────────────────────────────────────────
  rebuildPlot();

  return { $timeSelection, el: container };
}

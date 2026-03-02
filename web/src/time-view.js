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
  Param,
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
export function buildRectMarkOptions(fill = AIND_COLORS.light_blue) {
  return {
    x1: TIME_COL_START,
    x2: TIME_COL_END,
    y: TIME_COL_SUBJECT,
    fill,
    fillOpacity: 0.7,
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

  // ── Dynamic height ────────────────────────────────────────────────────────
  const $height = Param.value(TIME_VIEW_HEIGHT);

  async function updateHeight(queryFilter) {
    const { projects = [], extraFilters = [] } = queryFilter || {};
    if (projects.length === 0 && extraFilters.length === 0) return;
    try {
      let whereClause = '';
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
      if (parts.length > 0) whereClause = `WHERE ${parts.join(' AND ')}`;
      const result = await coordinator().query(
        `SELECT COUNT(DISTINCT "${TIME_COL_SUBJECT}") AS n FROM ${TIME_TABLE} ${whereClause}`,
      );
      const n = Number(result.getChild('n')?.get(0) ?? 25);
      $height.update(computeTimeViewHeight(n));
    } catch (err) {
      console.warn('[ZOMBIE] TimeView height query failed:', err);
    }
  }

  updateHeight($queryFilter.value);
  $queryFilter.addEventListener('value', updateHeight);

  // ── Plot ──────────────────────────────────────────────────────────────────
  const timeViewEl = plot(
    rect(
      from(TIME_TABLE, { filterBy: $queryFilterSel }),
      buildRectMarkOptions(),
    ),
    intervalX({ as: $timeSelection }),
    height($height),
    xScale('utc'),
    xLabel('Acquisition time'),
    // Suppress the y-axis label — subject IDs are self-explanatory.
    yLabel(null),
    // Let the outer card background show through.
    style({ background: 'transparent' }),
  );

  // ── Container ─────────────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.className = 'card time-view';
  container.id = 'time-view';

  const header = document.createElement('h3');
  header.className = 'view-header';
  header.textContent = 'Session Timeline';

  container.appendChild(header);
  container.appendChild(timeViewEl);

  return { $timeSelection, el: container };
}

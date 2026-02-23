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
  eq,
  literal,
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

/** Column: project name. Used to filter rows to the selected project. */
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
 * Build a Mosaic Selection clause for filtering by project name.
 *
 * The clause is passed to `Selection.update()` to push a new filter predicate
 * into the project-filter Selection that gates the TimeView's data source.
 *
 * @param {string|null|undefined} projectName - Selected project, or falsy to clear the filter.
 * @returns {{ source: string, value: string|null, predicate: object|null }}
 */
export function buildProjectClause(projectName) {
  return {
    source: 'project',
    value: projectName ?? null,
    predicate: projectName ? eq(TIME_COL_PROJECT, literal(projectName)) : null,
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
 * filtered to the currently selected project. Attaches an `intervalX`
 * interactor that populates the returned `$timeSelection`.
 *
 * @param {import('@uwdata/mosaic-core').Param} $project
 *   Reactive scalar Param holding the selected project name (from settings.js).
 *   The TimeView subscribes to value changes to update the project filter.
 *
 * @returns {{
 *   $timeSelection: import('@uwdata/mosaic-core').Selection,
 *   el: HTMLDivElement,
 * }}
 *   - `$timeSelection`: crossfilter Selection populated by brush gestures;
 *     pass as `filterBy` to DataView marks.
 *   - `el`: container DOM element ready to append to the page.
 */
export function createTimeView($project) {
  // ── Shared cross-filter selection ─────────────────────────────────────────
  // The intervalX interactor writes into this. DataViews subscribe to it via
  // `from(tableName, { filterBy: $timeSelection })`.
  const $timeSelection = Selection.crossfilter();

  // ── Project-scoped filter ─────────────────────────────────────────────────
  // Intersect-type: all clauses must be satisfied simultaneously. Here we
  // have just one clause (the project predicate) but using intersect keeps
  // the pattern extensible.
  const $projectFilter = Selection.intersect();

  function applyProjectFilter(value) {
    $projectFilter.update(buildProjectClause(value));
  }

  // Apply the initial project value immediately.
  applyProjectFilter($project.value);

  // Re-apply whenever the user selects a different project.
  $project.addEventListener('value', applyProjectFilter);

  // ── Dynamic height ────────────────────────────────────────────────────────
  // Start at the base height; updated after each subject-count query.
  const $height = Param.value(TIME_VIEW_HEIGHT);

  async function updateHeight(projectName) {
    if (!projectName) return;
    try {
      const escaped = String(projectName).replace(/'/g, "''");
      const result = await coordinator().query(
        `SELECT COUNT(DISTINCT ${TIME_COL_SUBJECT}) AS n ` +
        `FROM ${TIME_TABLE} ` +
        `WHERE ${TIME_COL_PROJECT} = '${escaped}'`,
      );
      const n = Number(result.getChild('n')?.get(0) ?? 25);
      $height.update(computeTimeViewHeight(n));
    } catch (err) {
      console.warn('[ZOMBIE] TimeView height query failed:', err);
    }
  }

  updateHeight($project.value);
  $project.addEventListener('value', updateHeight);

  // ── Plot ──────────────────────────────────────────────────────────────────
  const timeViewEl = plot(
    rect(
      from(TIME_TABLE, { filterBy: $projectFilter }),
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

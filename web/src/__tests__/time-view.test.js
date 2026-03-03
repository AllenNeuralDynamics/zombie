/**
 * time-view.test.js — Unit tests for pure helpers in time-view.js.
 *
 * Only the pure helper functions and exported constants are tested here.
 * They have no browser/DOM dependencies and run cleanly in the Node
 * test environment.
 *
 * createTimeView() requires a live Mosaic coordinator + DOM and is
 * covered by future integration / browser tests.
 */

import { describe, it, expect } from 'vitest';
import {
  TIME_TABLE,
  TIME_COL_START,
  TIME_COL_END,
  TIME_COL_SUBJECT,
  TIME_COL_PROJECT,
  buildRectMarkOptions,
  buildProjectClause,
  computeTimeViewHeight,
} from '../time-view.js';
import { AIND_COLORS, TIME_VIEW_HEIGHT } from '../constants.js';

// ---------------------------------------------------------------------------
// Column / table name constants
// ---------------------------------------------------------------------------

describe('time-view constants', () => {
  it('TIME_TABLE references the asset_basics table', () => {
    expect(TIME_TABLE).toBe('asset_basics');
  });

  it('TIME_COL_START references the acquisition start column', () => {
    expect(TIME_COL_START).toBe('acquisition_start_time');
  });

  it('TIME_COL_END references the acquisition end column', () => {
    expect(TIME_COL_END).toBe('acquisition_end_time');
  });

  it('TIME_COL_SUBJECT references the subject_id column', () => {
    expect(TIME_COL_SUBJECT).toBe('subject_id');
  });

  it('TIME_COL_PROJECT references the project_name column', () => {
    expect(TIME_COL_PROJECT).toBe('project_name');
  });
});

// ---------------------------------------------------------------------------
// buildRectMarkOptions
// ---------------------------------------------------------------------------

describe('buildRectMarkOptions', () => {
  it('uses the correct x1 and x2 columns for the time span', () => {
    const opts = buildRectMarkOptions();
    expect(opts.x1).toBe(TIME_COL_START);
    expect(opts.x2).toBe(TIME_COL_END);
  });

  it('uses subject_id as the y-axis grouping column', () => {
    const opts = buildRectMarkOptions();
    expect(opts.y).toBe(TIME_COL_SUBJECT);
  });

  it('defaults fill to the AIND light blue brand colour', () => {
    const opts = buildRectMarkOptions();
    expect(opts.fill).toBe(AIND_COLORS.light_blue);
  });

  it('accepts a custom fill colour', () => {
    const opts = buildRectMarkOptions('#ff0000');
    expect(opts.fill).toBe('#ff0000');
  });

  it('sets fillOpacity to 0.7', () => {
    const opts = buildRectMarkOptions();
    expect(opts.fillOpacity).toBe(0.7);
  });

  it('returns a plain object with exactly the expected keys', () => {
    const keys = Object.keys(buildRectMarkOptions()).sort();
    expect(keys).toEqual(['fill', 'fillOpacity', 'x1', 'x2', 'y'].sort());
  });
});

// ---------------------------------------------------------------------------
// buildProjectClause
// ---------------------------------------------------------------------------

describe('buildProjectClause', () => {
  it('uses "project" as the clause source', () => {
    expect(buildProjectClause('my-project').source).toBe('project');
    expect(buildProjectClause(null).source).toBe('project');
  });

  it('carries the project name as the clause value', () => {
    expect(buildProjectClause('my-project').value).toBe('my-project');
  });

  it('sets value to null when no project is given', () => {
    expect(buildProjectClause(null).value).toBeNull();
    expect(buildProjectClause(undefined).value).toBeNull();
  });

  it('sets predicate to null when no project is given', () => {
    expect(buildProjectClause(null).predicate).toBeNull();
    expect(buildProjectClause(undefined).predicate).toBeNull();
    expect(buildProjectClause('').predicate).toBeNull();
  });

  it('provides a truthy predicate when a project name is supplied', () => {
    const { predicate } = buildProjectClause('my-project');
    expect(predicate).toBeTruthy();
  });

  it('produces a predicate that serialises to a SQL equality expression', () => {
    const { predicate } = buildProjectClause('my-project');
    // The predicate is an eq() expression from mosaic-sql; its toString()
    // renders valid SQL: project_name = 'my-project'
    const sql = String(predicate);
    expect(sql).toContain('project_name');
    expect(sql).toContain('my-project');
    expect(sql).toContain('=');
  });

  it('preserves the project name in the right-hand literal of the predicate', () => {
    // eq(col, literal(value)) creates an expression with shape { a, b }
    // where b is the literal node. Verify the original value is preserved.
    const { predicate } = buildProjectClause("O'Malley's Lab");
    expect(predicate).toBeTruthy();
    // The eq() expression exposes its operands as .a (column) and .b (literal).
    expect(predicate.b.value).toBe("O'Malley's Lab");
  });
});

// ---------------------------------------------------------------------------
// computeTimeViewHeight
// ---------------------------------------------------------------------------

describe('computeTimeViewHeight', () => {
  it('returns the base height when subjectCount is 0', () => {
    expect(computeTimeViewHeight(0)).toBe(TIME_VIEW_HEIGHT);
  });

  it('returns the base height when subjectCount equals 25', () => {
    expect(computeTimeViewHeight(25)).toBe(TIME_VIEW_HEIGHT);
  });

  it('adds 100px for 26 subjects (first subject beyond the base band)', () => {
    expect(computeTimeViewHeight(26)).toBe(TIME_VIEW_HEIGHT + 100);
  });

  it('adds 100px for 50 subjects (fills the second band)', () => {
    expect(computeTimeViewHeight(50)).toBe(TIME_VIEW_HEIGHT + 100);
  });

  it('adds 200px for 51 subjects (starts the third band)', () => {
    expect(computeTimeViewHeight(51)).toBe(TIME_VIEW_HEIGHT + 200);
  });

  it('adds 300px for 100 subjects', () => {
    expect(computeTimeViewHeight(100)).toBe(TIME_VIEW_HEIGHT + 300);
  });

  it('respects a custom baseHeight', () => {
    expect(computeTimeViewHeight(50, 200)).toBe(300);
    expect(computeTimeViewHeight(25, 200)).toBe(200);
  });
});

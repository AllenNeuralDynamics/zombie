/**
 * data-view.js — Interactive scatter plot with settings panel.
 *
 * Each DataView renders a vgplot `dot` (scatter) mark sourced from a DuckDB
 * table. The mark is filtered by a per-DataView `$viewFilter` Selection
 * (intersect) that combines:
 *   - time-brush predicates forwarded from the global `$timeSelection`
 *   - a column=value predicate from the local filter UI
 *
 * Column selectors are populated dynamically from `DESCRIBE <table>` so
 * they reflect the actual schema rather than just what's in the metadata JSON.
 *
 * Pure helper functions are exported for unit testing.
 * createDataView() requires a live coordinator + DOM.
 */

import {
  Param,
  Selection,
  coordinator,
  plot,
  from,
  dot,
  width,
  height,
  xLabel,
  yLabel,
  xScale,
  yScale,
  style,
  colorScheme,
  colorLegend,
  cast,
  eq,
  literal,
  sql,
  column as sqlColumn,
} from '@uwdata/vgplot';

import { getAssetAcorns } from './metadata.js';
import { AIND_COLORS, DEFAULT_PLOT_WIDTH, DEFAULT_PLOT_HEIGHT } from './constants.js';

// ---------------------------------------------------------------------------
// # Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Pick sensible initial x, y, and color-by columns from a columns array.
 *
 * - x: first column
 * - y: second column (or first if only one exists)
 * - by: null (color-by off by default)
 *
 * @param {string[]} columns - Array of column names from an acorn definition.
 * @returns {{ x: string|null, y: string|null, by: null }}
 */
export function getInitialColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    return { x: null, y: null, by: null };
  }
  return {
    x: columns[0] ?? null,
    y: columns[1] ?? columns[0] ?? null,
    by: null,
  };
}

/**
 * Build the encoding options object for a vgplot `dot` (scatter) mark.
 *
 * @param {string|null} xCol        - X-axis column name.
 * @param {string|null} yCol        - Y-axis column name.
 * @param {string|null} byCol       - Color-by column name (null = static fill).
 * @param {string[]}    tooltipCols - Extra columns to show in hover tooltip.
 * @param {string|null} sizeCol     - Size-by column expression (null = fixed r=3).
 * @param {string} [fillColor]      - Static fill colour when color-by is unset.
 * @returns {object} Encoding options to pass to the vgplot `dot` mark.
 */
export function buildDotMarkOptions(xCol, yCol, byCol, tooltipCols = [], sizeCol = null, fillColor = AIND_COLORS.light_blue) {
  const opts = {
    x: xCol,
    y: yCol,
    r: sizeCol !== null ? sizeCol : 3,
    fillOpacity: 0.7,
  };
  if (byCol !== null) {
    opts.fill = byCol;
  } else {
    opts.fill = fillColor;
  }
  if (tooltipCols.length > 0) {
    opts.tip = true;
    const channels = {};
    for (const col of tooltipCols) {
      channels[col] = col;
    }
    opts.channels = channels;
  }
  return opts;
}

/**
 * Build a labelled <select> element and return both the wrapper label and the
 * raw <select> element so event listeners can be attached externally.
 *
 * @param {string}   labelText         - Human-readable label.
 * @param {string[]} options           - Option values shown in the dropdown.
 * @param {string|null} selectedValue  - Initially-selected value (or null).
 * @param {boolean}  [withNone=false]  - Prepend a "— none —" option with value "".
 * @returns {{ wrapperEl: HTMLLabelElement, selectEl: HTMLSelectElement }}
 */
function buildColumnSelect(labelText, options, selectedValue, withNone = false) {
  const wrapperEl = document.createElement('label');
  wrapperEl.className = 'dv-select-label';

  const labelSpan = document.createElement('span');
  labelSpan.textContent = labelText;
  wrapperEl.appendChild(labelSpan);

  const selectEl = document.createElement('select');
  selectEl.className = 'dv-select';

  if (withNone) {
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— none —';
    selectEl.appendChild(noneOpt);
  }

  for (const col of options) {
    const opt = document.createElement('option');
    opt.value = col;
    opt.textContent = col;
    opt.selected = col === selectedValue;
    selectEl.appendChild(opt);
  }

  wrapperEl.appendChild(selectEl);
  return { wrapperEl, selectEl };
}

// ---------------------------------------------------------------------------
// # Schema / value fetchers
// ---------------------------------------------------------------------------

/**
 * DuckDB type strings that represent date/time values.
 * When an axis column has one of these types, a UTC time scale is applied
 * so Observable Plot renders proper date labels instead of raw numbers.
 */
const TEMPORAL_TYPES = new Set([
  'TIMESTAMP', 'TIMESTAMPTZ', 'TIMESTAMP WITH TIME ZONE',
  'DATE', 'TIME', 'TIMETZ',
  'TIMESTAMP_S', 'TIMESTAMP_MS', 'TIMESTAMP_NS',
]);

/**
 * Return true when a DuckDB column type string represents a date/time.
 * Exported for unit testing.
 *
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
export function isTemporalType(type) {
  return typeof type === 'string' && TEMPORAL_TYPES.has(type.toUpperCase());
}

const OBJECT_TYPE_PREFIXES = ['STRUCT', 'MAP', 'JSON', 'UNION', 'ARRAY', 'LIST'];

/**
 * Return true when a DuckDB column type string represents an object/composite
 * type (STRUCT, MAP, JSON, UNION, ARRAY, LIST). Values of these types arrive
 * from Arrow as JS objects, which Observable Plot cannot use as scale inputs.
 * Exported for unit testing.
 *
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
export function isObjectType(type) {
  if (typeof type !== 'string') return false;
  const upper = type.toUpperCase();
  return OBJECT_TYPE_PREFIXES.some((p) => upper === p || upper.startsWith(`${p}(`));
}

const NUMERIC_TYPE_PREFIXES = [
  'TINYINT', 'INT1',
  'SMALLINT', 'INT2',
  'INTEGER', 'INT4', 'INT', 'SIGNED',
  'BIGINT', 'INT8', 'LONG',
  'HUGEINT', 'UBIGINT', 'UINTEGER', 'USMALLINT', 'UTINYINT',
  'FLOAT', 'FLOAT4', 'REAL',
  'DOUBLE', 'FLOAT8',
  'DECIMAL', 'NUMERIC',
];

/**
 * Return true when a DuckDB column type string represents a numeric value
 * (integer or floating-point, including DECIMAL/NUMERIC with precision).
 * Exported for unit testing.
 *
 * @param {string|null|undefined} type
 * @returns {boolean}
 */
export function isNumericType(type) {
  if (typeof type !== 'string') return false;
  const upper = type.toUpperCase();
  return NUMERIC_TYPE_PREFIXES.some((p) => upper === p || upper.startsWith(`${p}(`));
}

/**
 * Query DuckDB for the real schema of a registered table.
 * Returns an array of { name, type } objects, or null on failure.
 *
 * @param {string} tableName
 * @returns {Promise<Array<{name: string, type: string}>|null>}
 */
async function fetchTableColumns(tableName) {
  try {
    const result = await coordinator().query(`DESCRIBE "${tableName}"`);
    const nameCol = result.getChild('column_name');
    const typeCol = result.getChild('column_type');
    if (nameCol) {
      return Array.from({ length: nameCol.length }, (_, i) => ({
        name: nameCol.get(i),
        type: typeCol?.get(i) ?? null,
      }));
    }
  } catch (err) {
    console.warn(`[ZOMBIE] DESCRIBE ${tableName} failed:`, err);
  }
  return null;
}

/**
 * Query DuckDB for distinct values of a column in a table (up to 200).
 * Returns string representations. Numeric columns are sorted numerically;
 * all others are sorted alphabetically by their VARCHAR representation.
 *
 * @param {string}           tableName
 * @param {string}           colName
 * @param {string|null}      [colType]  - DuckDB type string for the column.
 * @returns {Promise<string[]>}  Empty array on failure.
 */
async function fetchDistinctValues(tableName, colName, colType = null) {
  const numeric = isNumericType(colType);
  try {
    const orderExpr = numeric
      ? `"${colName}"::DOUBLE`
      : `"${colName}"::VARCHAR`;
    const result = await coordinator().query(
      `SELECT DISTINCT "${colName}"::VARCHAR AS v FROM "${tableName}" WHERE "${colName}" IS NOT NULL ORDER BY ${orderExpr} LIMIT 200`,
    );
    const col = result.getChild('v');
    if (col) {
      return Array.from({ length: col.length }, (_, i) => String(col.get(i)));
    }
  } catch (err) {
    console.warn(`[ZOMBIE] Distinct values query failed (${tableName}.${colName}):`, err);
  }
  return [];
}

// ---------------------------------------------------------------------------
// # Component factory (requires live coordinator + DOM)
// ---------------------------------------------------------------------------

/**
 * Create a DataView component: interactive scatter plot + settings panel.
 *
 * @param {string|number}                           id             - Unique identifier.
 * @param {import('@uwdata/mosaic-core').Selection}  $timeSelection - Crossfilter from TimeView.
 * @param {{ acorns: object[] }}                    metadata       - Parsed squirrel.json.
 * @returns {{
 *   el: HTMLDivElement,
 *   notifyTableRegistered: (name: string) => void,
 * }}
 */
export function createDataView(id, $timeSelection, metadata) {
  const assetAcorns = getAssetAcorns(metadata.acorns);

  // ── State ──────────────────────────────────────────────────────────────────
  let currentAcorn = assetAcorns[0] ?? null;
  let liveColumns = currentAcorn?.columns ?? [];   // string[] of column names
  let liveColumnTypes = new Map();                 // name → DuckDB type string

  const initialCols = getInitialColumns(liveColumns);
  // Plain string state — not Mosaic Params. vgplot mark encodings resolve
  // column names as strings; Params as encoding channels produce empty SELECTs.
  // Changes to these require a full plot rebuild (triggered via "Update plot").
  let xColValue = initialCols.x;
  let yColValue = initialCols.y;
  let byColValue = null;
  let sizeColValue = null;
  let tooltipColumns = liveColumns.includes('asset_name') ? ['asset_name'] : [];

  const activeFilters = new Map();
  const committedFilterCols = new Set();

  // Dirty flag: true when settings have changed but plot has not been rebuilt
  let isDirty = false;

  function markDirty() {
    isDirty = true;
    if (updateBtnEl) updateBtnEl.classList.add('dv-update-btn--dirty');
  }
  // ── Plot config state ──────────────────────────────────────────────────────
  const plotConfig = {
    title:       '',
    xLabelText:  '',                     // '' → auto (column name)
    yLabelText:  '',
    plotWidth:   DEFAULT_PLOT_WIDTH,
    plotHeight:  DEFAULT_PLOT_HEIGHT,
    fontSize:    12,                     // px, applied to both tick and axis labels
    showLegend:  true,
  };
  // ── Registered table tracking ────────────────────────────────────────────
  // We must not build a vgplot mark (or send DESCRIBE) before the DuckDB table
  // is registered. settings.js fires notifyTableRegistered() once the table is
  // ready; until then rebuildPlot() renders a placeholder instead.
  const registeredTables = new Set();

  // ── Combined filter Selection ──────────────────────────────────────────────
  // Single Selection that both time-brush AND column-filter predicates are
  // pushed into. The dot mark subscribes only to this one Selection.
  const $viewFilter = Selection.intersect();

  // Forward every time-selection clause into $viewFilter, namespacing the
  // source so it doesn't collide with the column-filter clause.
  $timeSelection.addEventListener('value', (clause) => {
    $viewFilter.update(
      clause
        ? { ...clause, source: `time:${String(clause.source ?? 'brush')}` }
        : { source: 'time:brush', predicate: null, value: null },
    );
  });

  function applyFilter(col, val) {
    if (val) {
      activeFilters.set(col, val);
    } else {
      activeFilters.delete(col);
    }
    markDirty();
  }

  function removeFilter(col) {
    activeFilters.delete(col);
    markDirty();
  }

  // ── Container ──────────────────────────────────────────────────────────────
  const container = document.createElement('div');
  container.className = 'card data-view';
  container.id = `data-view-${id}`;

  // Header row: title text + gear button
  const headerRow = document.createElement('div');
  headerRow.className = 'dv-header-row';

  const headerTitle = document.createElement('h3');
  headerTitle.className = 'view-header';
  headerTitle.textContent = 'Data View';
  headerRow.appendChild(headerTitle);

  const gearBtn = document.createElement('button');
  gearBtn.type = 'button';
  gearBtn.className = 'dv-gear-btn';
  gearBtn.title = 'Plot appearance settings';
  gearBtn.innerHTML = '&#9881;'; // ⚙ gear
  headerRow.appendChild(gearBtn);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'dv-remove-btn';
  removeBtn.title = 'Remove this data view';
  removeBtn.innerHTML = '&#10005;'; // ✕
  headerRow.appendChild(removeBtn);

  container.appendChild(headerRow);

  // Collapsible plot-controls panel (hidden by default)
  const plotControlsEl = document.createElement('div');
  plotControlsEl.className = 'dv-plot-controls';
  plotControlsEl.hidden = true;
  container.appendChild(plotControlsEl);

  // Build plot-controls content
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

    function makeText(value, placeholder = '') {
      const el = document.createElement('input');
      el.type = 'text';
      el.className = 'dv-ctrl-input';
      el.value = value;
      el.placeholder = placeholder;
      return el;
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

    // Title
    const titleInput = addControlRow('Title', makeText(plotConfig.title, 'Data View'));
    titleInput.addEventListener('input', () => {
      plotConfig.title = titleInput.value;
      headerTitle.textContent = plotConfig.title || 'Data View';
    });

    // X label
    const xLabelInput = addControlRow('X label', makeText(plotConfig.xLabelText, xColValue ?? 'auto'));
    xLabelInput.addEventListener('input', () => { plotConfig.xLabelText = xLabelInput.value; rebuildPlot(); });

    // Y label
    const yLabelInput = addControlRow('Y label', makeText(plotConfig.yLabelText, yColValue ?? 'auto'));
    yLabelInput.addEventListener('input', () => { plotConfig.yLabelText = yLabelInput.value; rebuildPlot(); });

    // Width
    const widthInput = addControlRow('Width (px)', makeNumber(plotConfig.plotWidth, 200, 2000, 50));
    widthInput.addEventListener('change', () => { plotConfig.plotWidth = Number(widthInput.value); rebuildPlot(); });

    // Height
    const heightInput = addControlRow('Height (px)', makeNumber(plotConfig.plotHeight, 100, 1200, 50));
    heightInput.addEventListener('change', () => { plotConfig.plotHeight = Number(heightInput.value); rebuildPlot(); });

    // Font size
    const fontInput = addControlRow('Font size (px)', makeNumber(plotConfig.fontSize, 8, 32));
    fontInput.addEventListener('change', () => { plotConfig.fontSize = Number(fontInput.value); rebuildPlot(); });

    // Show legend
    const legendChk = document.createElement('input');
    legendChk.type = 'checkbox';
    legendChk.checked = plotConfig.showLegend;
    legendChk.addEventListener('change', () => { plotConfig.showLegend = legendChk.checked; rebuildPlot(); });
    const legendRow = document.createElement('label');
    legendRow.className = 'dv-ctrl-row dv-ctrl-checkbox';
    legendRow.appendChild(legendChk);
    const legendSpan = document.createElement('span');
    legendSpan.textContent = 'Show legend';
    legendRow.appendChild(legendSpan);
    plotControlsEl.appendChild(legendRow);
  }

  buildPlotControls();

  gearBtn.addEventListener('click', () => {
    plotControlsEl.hidden = !plotControlsEl.hidden;
    gearBtn.classList.toggle('dv-gear-btn--active', !plotControlsEl.hidden);
    if (!plotControlsEl.hidden) buildPlotControls(); // refresh placeholder text
  });

  const layoutEl = document.createElement('div');
  layoutEl.className = 'data-view-layout';
  container.appendChild(layoutEl);

  // ── Settings panel ─────────────────────────────────────────────────────────
  const settingsEl = document.createElement('div');
  settingsEl.className = 'data-view-settings';

  // Data-type selector
  const { wrapperEl: dtWrapperEl, selectEl: dtSelectEl } = buildColumnSelect(
    'Data type',
    assetAcorns.map((a) => a.name),
    currentAcorn?.name ?? null,
  );
  settingsEl.appendChild(dtWrapperEl);

  // Column/filter selector slots — rebuilt whenever the data type or real schema changes
  let xSelectEl = null;
  let ySelectEl = null;
  let bySelectEl = null;
  let sizeSelectEl = null;
  let tooltipSelectEl = null;

  // Elements for the "add filter" row
  let addFilterColSelectEl = null;
  let addFilterValSelectEl = null;
  let filterListEl = null;

  /**
   * (Re)populate the add-filter value <select> with distinct values from DuckDB.
   */
  async function populateAddFilterValues(col, valSelectEl) {
    if (!valSelectEl) return;
    valSelectEl.disabled = true;
    valSelectEl.innerHTML = '';

    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = col ? 'Loading…' : '— pick column first —';
    valSelectEl.appendChild(placeholderOpt);

    if (!col || !currentAcorn) {
      valSelectEl.disabled = false;
      return;
    }

    const colType = liveColumnTypes.get(col) ?? null;
    const values = await fetchDistinctValues(currentAcorn.name, col, colType);
    valSelectEl.innerHTML = '';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— select value —';
    valSelectEl.appendChild(none);

    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      valSelectEl.appendChild(opt);
    }

    valSelectEl.disabled = false;
  }

  /**
   * Rebuild the chips list showing active filters.
   */
  function renderFilterChips() {
    if (!filterListEl) return;
    filterListEl.innerHTML = '';
    for (const [col, val] of activeFilters.entries()) {
      const chip = document.createElement('span');
      chip.className = 'dv-filter-chip';
      chip.textContent = `${col} = ${val}`;
      const removeX = document.createElement('button');
      removeX.type = 'button';
      removeX.className = 'dv-filter-chip-remove';
      removeX.title = 'Remove filter';
      removeX.textContent = '×';
      removeX.addEventListener('click', () => {
        removeFilter(col);
        renderFilterChips();
      });
      chip.appendChild(removeX);
      filterListEl.appendChild(chip);
    }
  }

  function buildColumnSelectors(columns) {
    // Remove previous selectors and filter UI
    [xSelectEl, ySelectEl, bySelectEl, sizeSelectEl].forEach((el) =>
      el?.closest('label')?.remove(),
    );
    tooltipSelectEl?.closest('label')?.remove();
    addFilterColSelectEl?.closest('.dv-add-filter-row')?.remove();
    filterListEl?.remove();

    const { wrapperEl: xWrap, selectEl: xSel } = buildColumnSelect('X axis', columns, xColValue);
    const { wrapperEl: yWrap, selectEl: ySel } = buildColumnSelect('Y axis', columns, yColValue);
    const { wrapperEl: byWrap, selectEl: bySel } = buildColumnSelect('Color by', columns, byColValue, true);
    const { wrapperEl: sizeWrap, selectEl: sizeSel } = buildColumnSelect('Size by', columns, sizeColValue, true);

    xSelectEl = xSel;
    ySelectEl = ySel;
    bySelectEl = bySel;
    sizeSelectEl = sizeSel;

    xSelectEl.addEventListener('change', () => { xColValue = xSelectEl.value || null; markDirty(); });
    ySelectEl.addEventListener('change', () => { yColValue = ySelectEl.value || null; markDirty(); });
    bySelectEl.addEventListener('change', () => { byColValue = bySelectEl.value || null; markDirty(); });
    sizeSelectEl.addEventListener('change', () => { sizeColValue = sizeSelectEl.value || null; markDirty(); });

    // Tooltip columns multi-select
    const tooltipWrapEl = document.createElement('label');
    tooltipWrapEl.className = 'dv-select-label';
    const tooltipSpan = document.createElement('span');
    tooltipSpan.textContent = 'Tooltip columns';
    tooltipWrapEl.appendChild(tooltipSpan);
    const tooltipSel = document.createElement('select');
    tooltipSel.className = 'dv-select dv-tooltip-select';
    tooltipSel.multiple = true;
    tooltipSel.size = Math.min(4, Math.max(2, columns.length));
    for (const col of columns) {
      const opt = document.createElement('option');
      opt.value = col;
      opt.textContent = col;
      opt.selected = tooltipColumns.includes(col);
      tooltipSel.appendChild(opt);
    }
    tooltipSel.addEventListener('change', () => {
      tooltipColumns = Array.from(tooltipSel.selectedOptions).map((o) => o.value);
      markDirty();
    });
    tooltipSelectEl = tooltipSel;
    tooltipWrapEl.appendChild(tooltipSel);

    settingsEl.appendChild(xWrap);
    settingsEl.appendChild(yWrap);
    settingsEl.appendChild(byWrap);
    settingsEl.appendChild(sizeWrap);
    settingsEl.appendChild(tooltipWrapEl);

    // ── Multi-filter UI ────────────────────────────────────────────────────
    // Chips list (active filters)
    const chipsList = document.createElement('div');
    chipsList.className = 'dv-filter-chips';
    filterListEl = chipsList;
    settingsEl.appendChild(chipsList);
    renderFilterChips();

    // "Add filter" row: column select + value select + Add button
    const addRow = document.createElement('div');
    addRow.className = 'dv-add-filter-row';

    const addColSel = document.createElement('select');
    addColSel.className = 'dv-select dv-add-filter-col';
    const colNoneOpt = document.createElement('option');
    colNoneOpt.value = '';
    colNoneOpt.textContent = '+ filter column';
    addColSel.appendChild(colNoneOpt);
    for (const col of columns) {
      const opt = document.createElement('option');
      opt.value = col;
      opt.textContent = col;
      addColSel.appendChild(opt);
    }

    const addValSel = document.createElement('select');
    addValSel.className = 'dv-select dv-add-filter-val';
    addValSel.disabled = true;
    const valNoneOpt = document.createElement('option');
    valNoneOpt.value = '';
    valNoneOpt.textContent = '— pick column first —';
    addValSel.appendChild(valNoneOpt);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'dv-add-filter-btn';
    addBtn.textContent = 'Add';
    addBtn.disabled = true;

    addColSel.addEventListener('change', () => {
      const col = addColSel.value || null;
      addBtn.disabled = !col;
      populateAddFilterValues(col, addValSel);
    });

    addValSel.addEventListener('change', () => {
      addBtn.disabled = !addColSel.value || !addValSel.value;
    });

    addBtn.addEventListener('click', () => {
      const col = addColSel.value;
      const val = addValSel.value;
      if (!col || !val) return;
      applyFilter(col, val);
      renderFilterChips();
      addColSel.value = '';
      addValSel.innerHTML = '';
      const reset = document.createElement('option');
      reset.value = '';
      reset.textContent = '— pick column first —';
      addValSel.appendChild(reset);
      addValSel.disabled = true;
      addBtn.disabled = true;
    });

    addFilterColSelectEl = addColSel;
    addFilterValSelectEl = addValSel;

    addRow.appendChild(addColSel);
    addRow.appendChild(addValSel);
    addRow.appendChild(addBtn);
    settingsEl.appendChild(addRow);
  }

  if (currentAcorn) {
    buildColumnSelectors(liveColumns);
  }

  // ── Update Plot button ─────────────────────────────────────────────────────
  let updateBtnEl = null;
  const updateBtn = document.createElement('button');
  updateBtn.type = 'button';
  updateBtn.className = 'dv-update-btn';
  updateBtn.textContent = 'Update plot';
  updateBtn.addEventListener('click', () => rebuildPlot());
  updateBtnEl = updateBtn;
  settingsEl.appendChild(updateBtn);

  layoutEl.appendChild(settingsEl);

  // ── Plot container ─────────────────────────────────────────────────────────
  const plotContainer = document.createElement('div');
  plotContainer.className = 'data-view-plot';
  layoutEl.appendChild(plotContainer);

  // ── Debug data table ──────────────────────────────────────────────────────
  let debugVisible = false;

  let debugRowLimit = 1000;

  const debugControlsRow = document.createElement('div');
  debugControlsRow.className = 'dv-debug-controls';

  const debugToggleBtn = document.createElement('button');
  debugToggleBtn.type = 'button';
  debugToggleBtn.className = 'dv-debug-toggle';
  debugToggleBtn.textContent = '▼ Show data';
  debugControlsRow.appendChild(debugToggleBtn);

  const debugLimitSel = document.createElement('select');
  debugLimitSel.className = 'dv-debug-limit-sel';
  for (const n of [100, 500, 1000, 5000]) {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = `${n} rows`;
    opt.selected = n === debugRowLimit;
    debugLimitSel.appendChild(opt);
  }
  debugLimitSel.addEventListener('change', () => {
    debugRowLimit = Number(debugLimitSel.value);
    if (debugVisible) renderDebugTable();
  });
  debugControlsRow.appendChild(debugLimitSel);

  const debugTableContainer = document.createElement('div');
  debugTableContainer.className = 'dv-debug-wrap';
  debugTableContainer.hidden = true;

  async function renderDebugTable() {
    debugTableContainer.innerHTML = '';
    if (!currentAcorn || !registeredTables.has(currentAcorn.name)) {
      const note = document.createElement('p');
      note.className = 'dv-debug-note';
      note.textContent = 'No table loaded.';
      debugTableContainer.appendChild(note);
      return;
    }
    const loading = document.createElement('p');
    loading.className = 'dv-debug-note';
    loading.textContent = 'Loading…';
    debugTableContainer.appendChild(loading);
    try {
      const whereParts = [...activeFilters.entries()]
        .filter(([, v]) => v)
        .map(([col, val]) => `"${col}"::VARCHAR = '${val.replace(/'/g, "''")}'`);
      const whereClause = whereParts.length ? `WHERE ${whereParts.join(' AND ')}` : '';
      const result = await coordinator().query(`SELECT * FROM "${currentAcorn.name}" ${whereClause} LIMIT ${debugRowLimit}`);
      debugTableContainer.innerHTML = '';
      const fields = result.schema.fields;
      const numRows = result.numRows;
      const info = document.createElement('p');
      info.className = 'dv-debug-note';
      info.textContent = `${numRows} row(s) shown (max ${debugRowLimit}) — ${currentAcorn.name}`;
      debugTableContainer.appendChild(info);
      const scrollWrap = document.createElement('div');
      scrollWrap.className = 'dv-debug-scroll';
      const table = document.createElement('table');
      table.className = 'dv-debug-table';
      const thead = table.createTHead();
      const headerRow = thead.insertRow();
      for (const field of fields) {
        const th = document.createElement('th');
        th.textContent = field.name;
        const typeSpan = document.createElement('span');
        typeSpan.className = 'dv-debug-type';
        typeSpan.textContent = liveColumnTypes.get(field.name) || '';
        th.appendChild(typeSpan);
        headerRow.appendChild(th);
      }
      const tbody = table.createTBody();
      const cols = fields.map((f) => result.getChild(f.name));
      for (let r = 0; r < numRows; r++) {
        const tr = tbody.insertRow();
        for (let c = 0; c < cols.length; c++) {
          const td = tr.insertCell();
          const val = cols[c]?.get(r);
          if (val === null || val === undefined) {
            td.textContent = '∅';
            td.className = 'dv-debug-null';
          } else if (typeof val === 'object') {
            try { td.textContent = JSON.stringify(val); } catch { td.textContent = String(val); }
          } else {
            td.textContent = String(val);
          }
        }
      }
      scrollWrap.appendChild(table);
      debugTableContainer.appendChild(scrollWrap);
    } catch (err) {
      debugTableContainer.innerHTML = '';
      const errEl = document.createElement('pre');
      errEl.className = 'dv-debug-error';
      errEl.textContent = String(err);
      debugTableContainer.appendChild(errEl);
    }
  }

  debugToggleBtn.addEventListener('click', async () => {
    debugVisible = !debugVisible;
    debugTableContainer.hidden = !debugVisible;
    debugToggleBtn.textContent = debugVisible ? '▲ Hide data' : '▼ Show data';
    if (debugVisible) await renderDebugTable();
  });

  layoutEl.appendChild(debugControlsRow);
  layoutEl.appendChild(debugTableContainer);

  // ── Plot builder ───────────────────────────────────────────────────────────
  let hasLivePlot = false;

  function rebuildPlot() {
    plotContainer.innerHTML = '';
    hasLivePlot = false;
    isDirty = false;
    if (updateBtnEl) updateBtnEl.classList.remove('dv-update-btn--dirty');

    // Sync column-filter predicates into $viewFilter
    for (const col of committedFilterCols) {
      if (!activeFilters.has(col)) {
        $viewFilter.update({ source: `col:filter:${col}`, predicate: null, value: null });
      }
    }
    committedFilterCols.clear();
    for (const [col, val] of activeFilters.entries()) {
      const colType = liveColumnTypes.get(col);
      let predicate;
      if (isNumericType(colType)) {
        predicate = eq(col, literal(Number(val)));
      } else {
        predicate = eq(cast(col, 'VARCHAR'), literal(val));
      }
      $viewFilter.update({ source: `col:filter:${col}`, predicate, value: val });
      committedFilterCols.add(col);
    }

    if (!currentAcorn) {
      plotContainer.appendChild(makePlaceholder('Enable a data type in the settings bar to visualize data.'));
      return;
    }

    if (!registeredTables.has(currentAcorn.name)) {
      plotContainer.appendChild(makePlaceholder(
        `Enable "${currentAcorn.name.replace(/_/g, ' ')}" in the settings bar to load data.`,
      ));
      return;
    }

    // Guard: don't build the mark until columns are set (avoids empty SELECT)
    if (!xColValue || !yColValue) {
      plotContainer.appendChild(makePlaceholder('Select X and Y columns and click “Update plot”.'));
      return;
    }

    function colRefAxis(colName) {
      const type = liveColumnTypes.get(colName);
      if (isObjectType(type)) return cast(colName, 'VARCHAR');
      if (isTemporalType(type)) return cast(colName, 'TIMESTAMP');
      if (isNumericType(type)) return cast(colName, 'DOUBLE');
      return sql`TRY_CAST(${sqlColumn(colName)} AS DOUBLE)`;
    }

    const markOpts = buildDotMarkOptions(
      colRefAxis(xColValue),
      colRefAxis(yColValue),
      byColValue || null,
      tooltipColumns,
      sizeColValue ? colRefAxis(sizeColValue) : null,
    );

    const effectiveXLabel = plotConfig.xLabelText || xColValue;
    const effectiveYLabel = plotConfig.yLabelText || yColValue;

    const plotParts = [
      dot(from(currentAcorn.name, { filterBy: $viewFilter }), markOpts),
      width(plotConfig.plotWidth),
      height(plotConfig.plotHeight),
      xLabel(effectiveXLabel),
      yLabel(effectiveYLabel),
      style({
        background: 'transparent',
        fontSize: `${plotConfig.fontSize}px`,
      }),
    ];

    if (isTemporalType(liveColumnTypes.get(xColValue))) plotParts.push(xScale('time'));
    if (isTemporalType(liveColumnTypes.get(yColValue))) plotParts.push(yScale('time'));

    if (byColValue && plotConfig.showLegend) {
      plotParts.push(colorScheme('tableau10'));
      plotParts.push(colorLegend(true));
    } else if (byColValue) {
      plotParts.push(colorScheme('tableau10'));
    }

    // Plot title rendered as an HTML heading above the SVG so it respects
    // our theme font — vgplot has no title export.
    if (plotConfig.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'dv-plot-title';
      titleEl.textContent = plotConfig.title;
      plotContainer.appendChild(titleEl);
    }

    try {
      plotContainer.appendChild(plot(...plotParts));
      hasLivePlot = true;
    } catch (err) {
      showPlotError(err);
    }
  }

  function makePlaceholder(text) {
    const p = document.createElement('p');
    p.className = 'placeholder-note';
    p.textContent = text;
    return p;
  }

  function makeErrorEl(err) {
    const wrap = document.createElement('div');
    wrap.className = 'dv-plot-error';
    const heading = document.createElement('strong');
    heading.textContent = 'Plot error';
    const pre = document.createElement('pre');
    pre.textContent = String(err?.message ?? err);
    wrap.appendChild(heading);
    wrap.appendChild(pre);
    return wrap;
  }

  function showPlotError(err) {
    plotContainer.innerHTML = '';
    hasLivePlot = false;
    plotContainer.appendChild(makeErrorEl(err));
  }

  function makeSpinner(label) {
    const wrap = document.createElement('div');
    wrap.className = 'dv-spinner-wrap';
    const ring = document.createElement('div');
    ring.className = 'dv-spinner';
    ring.setAttribute('aria-hidden', 'true');
    const msg = document.createElement('p');
    msg.className = 'dv-spinner-label';
    msg.textContent = label;
    wrap.appendChild(ring);
    wrap.appendChild(msg);
    return wrap;
  }

  // ── Data-type change handler ───────────────────────────────────────────────
  dtSelectEl.addEventListener('change', async () => {
    const acorn = assetAcorns.find((a) => a.name === dtSelectEl.value);
    if (!acorn) return;
    currentAcorn = acorn;
    for (const col of committedFilterCols) {
      $viewFilter.update({ source: `col:filter:${col}`, predicate: null, value: null });
    }
    committedFilterCols.clear();
    activeFilters.clear();

    // Seed dropdowns from metadata columns immediately (no type info yet)
    const seedCols = getInitialColumns(acorn.columns);
    xColValue = seedCols.x;
    yColValue = seedCols.y;
    byColValue = null;
    sizeColValue = null;
    tooltipColumns = acorn.columns.includes('asset_name') ? ['asset_name'] : [];
    liveColumns = acorn.columns;
    liveColumnTypes = new Map();
    buildColumnSelectors(acorn.columns);

    // Only upgrade to real schema via DESCRIBE if the table is already registered.
    // If not registered yet, notifyTableRegistered() will do this when it fires.
    if (registeredTables.has(acorn.name)) {
      const schema = await fetchTableColumns(acorn.name);
      if (schema?.length) {
        liveColumnTypes = new Map(schema.map((c) => [c.name, c.type]));
        liveColumns = schema.map((c) => c.name);
        const realCols = getInitialColumns(liveColumns);
        xColValue = realCols.x;
        yColValue = realCols.y;
        buildColumnSelectors(liveColumns);
      }
    }

    rebuildPlot();
  });

  // Show placeholder until notifyTableRegistered is called (avoids firing a
  // query against a table that may not yet be registered by settings.js).
  rebuildPlot();

  /**
   * Called by settings.js (via app.js) after a data-type table is registered.
   * Refreshes the real column list via DESCRIBE and renders the plot.
   * @param {string} name - Acorn table name that was just successfully registered.
   */
  /**
   * Called by settings.js (via app.js) when a data-type table has started
   * loading. Shows a spinner in the plot area if this DataView is showing
   * that data type.
   * @param {string} name - Acorn table name that is now loading.
   */
  function notifyTableLoading(name) {
    if (currentAcorn?.name !== name) return;
    plotContainer.innerHTML = '';
    plotContainer.appendChild(
      makeSpinner(`Loading ${name.replace(/_/g, ' ')}…`),
    );
  }

  async function notifyTableRegistered(name) {
    // Mark this table as available regardless of which acorn is currently shown;
    // if the user later switches to it the guard in rebuildPlot() will pass.
    registeredTables.add(name);

    if (currentAcorn?.name !== name) return;

    // Upgrade dropdowns to the real DuckDB schema (names + types).
    const schema = await fetchTableColumns(name);
    if (schema?.length) {
      liveColumnTypes = new Map(schema.map((c) => [c.name, c.type]));
      liveColumns = schema.map((c) => c.name);
      const realCols = getInitialColumns(liveColumns);
      xColValue = realCols.x;
      yColValue = realCols.y;
      byColValue = null;
      tooltipColumns = liveColumns.includes('asset_name') ? ['asset_name'] : [];
      buildColumnSelectors(liveColumns);
    }
    rebuildPlot();
  }

  function onUnhandledRejection(event) {
    if (!hasLivePlot) return;
    event.preventDefault();
    showPlotError(event.reason);
  }
  window.addEventListener('unhandledrejection', onUnhandledRejection);
  removeBtn.addEventListener('click', () => {
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
  });

  return { el: container, notifyTableLoading, notifyTableRegistered, removeBtn };
}

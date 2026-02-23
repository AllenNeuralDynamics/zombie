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
  eq,
  literal,
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
 * @param {string|null} xCol      - X-axis column name.
 * @param {string|null} yCol      - Y-axis column name.
 * @param {string|null} byCol     - Color-by column name (null = static fill).
 * @param {string} [fillColor]    - Static fill colour when color-by is unset.
 * @returns {object} Encoding options to pass to the vgplot `dot` mark.
 */
export function buildDotMarkOptions(xCol, yCol, byCol, fillColor = AIND_COLORS.light_blue) {
  const opts = {
    x: xCol,
    y: yCol,
    r: 3,
    fillOpacity: 0.7,
  };
  if (byCol !== null) {
    opts.fill = byCol;
  } else {
    opts.fill = fillColor;
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
 * Returns string representations, sorted alphabetically.
 *
 * @param {string} tableName
 * @param {string} colName
 * @returns {Promise<string[]>}  Empty array on failure.
 */
async function fetchDistinctValues(tableName, colName) {
  try {
    const result = await coordinator().query(
      `SELECT DISTINCT "${colName}"::VARCHAR AS v FROM "${tableName}" WHERE "${colName}" IS NOT NULL ORDER BY 1 LIMIT 200`,
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

  // Column filter state
  let filterCol = null;
  let filterVal = '';

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

  function applyColFilter() {
    $viewFilter.update({
      source: 'col:filter',
      predicate: (filterCol && filterVal)
        ? eq(filterCol, literal(filterVal))
        : null,
      value: filterVal || null,
    });
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
  let filterColSelectEl = null;
  let filterValSelectEl = null;
  let filterValWrapperEl = null;

  /**
   * (Re)populate the filter value <select> with distinct values from DuckDB.
   * Disables the select while loading and preserves the current value if present.
   */
  async function populateFilterValues(col) {
    if (!filterValSelectEl) return;
    filterValSelectEl.disabled = true;
    filterValSelectEl.innerHTML = '';

    // "none" option always first
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = col ? 'Loading…' : '— none —';
    filterValSelectEl.appendChild(noneOpt);

    if (!col || !currentAcorn) {
      filterValSelectEl.disabled = false;
      return;
    }

    const values = await fetchDistinctValues(currentAcorn.name, col);
    filterValSelectEl.innerHTML = '';

    const none = document.createElement('option');
    none.value = '';
    none.textContent = '— none —';
    filterValSelectEl.appendChild(none);

    for (const v of values) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      opt.selected = v === filterVal;
      filterValSelectEl.appendChild(opt);
    }

    filterValSelectEl.disabled = false;
  }

  function buildColumnSelectors(columns) {
    // Remove previous selectors
    [xSelectEl, ySelectEl, bySelectEl, filterColSelectEl].forEach((el) =>
      el?.closest('label')?.remove(),
    );
    filterValWrapperEl?.remove();

    const { wrapperEl: xWrap, selectEl: xSel } = buildColumnSelect('X axis', columns, xColValue);
    const { wrapperEl: yWrap, selectEl: ySel } = buildColumnSelect('Y axis', columns, yColValue);
    const { wrapperEl: byWrap, selectEl: bySel } = buildColumnSelect('Color by', columns, byColValue, true);
    const { wrapperEl: fcWrap, selectEl: fcSel } = buildColumnSelect('Filter column', columns, filterCol, true);

    // Filter value: dropdown populated with distinct values from DuckDB
    const fvWrap = document.createElement('label');
    fvWrap.className = 'dv-select-label';
    const fvSpan = document.createElement('span');
    fvSpan.textContent = 'Filter value';
    const fvSel = document.createElement('select');
    fvSel.className = 'dv-select';
    fvSel.disabled = true; // enabled once filter column is chosen
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— none —';
    fvSel.appendChild(noneOpt);
    fvWrap.appendChild(fvSpan);
    fvWrap.appendChild(fvSel);

    xSelectEl = xSel;
    ySelectEl = ySel;
    bySelectEl = bySel;
    filterColSelectEl = fcSel;
    filterValSelectEl = fvSel;
    filterValWrapperEl = fvWrap;

    // x/y/color-by changes mark the plot dirty; rebuild triggered by Update button
    xSelectEl.addEventListener('change', () => { xColValue = xSelectEl.value || null; markDirty(); });
    ySelectEl.addEventListener('change', () => { yColValue = ySelectEl.value || null; markDirty(); });
    bySelectEl.addEventListener('change', () => { byColValue = bySelectEl.value || null; markDirty(); });
    // Filter column change: load values and apply predicate immediately (no rebuild)
    filterColSelectEl.addEventListener('change', () => {
      filterCol = filterColSelectEl.value || null;
      filterVal = '';
      populateFilterValues(filterCol);
      applyColFilter();
    });
    fvSel.addEventListener('change', () => {
      filterVal = fvSel.value;
      applyColFilter();
    });

    settingsEl.appendChild(xWrap);
    settingsEl.appendChild(yWrap);
    settingsEl.appendChild(byWrap);
    settingsEl.appendChild(fcWrap);
    settingsEl.appendChild(fvWrap);

    // If a filter column is already selected, populate values immediately
    if (filterCol) {
      populateFilterValues(filterCol);
    }
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

  // ── Plot builder ───────────────────────────────────────────────────────────
  function rebuildPlot() {
    plotContainer.innerHTML = '';
    isDirty = false;
    if (updateBtnEl) updateBtnEl.classList.remove('dv-update-btn--dirty');

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

    const markOpts = buildDotMarkOptions(xColValue, yColValue, byColValue || null);

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

    // Apply UTC time scale when axis column is a timestamp/date type so
    // Observable Plot renders human-readable date labels instead of numbers.
    if (isTemporalType(liveColumnTypes.get(xColValue))) plotParts.push(xScale({ type: 'utc' }));
    if (isTemporalType(liveColumnTypes.get(yColValue))) plotParts.push(yScale({ type: 'utc' }));

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

    plotContainer.appendChild(plot(...plotParts));
  }

  function makePlaceholder(text) {
    const p = document.createElement('p');
    p.className = 'placeholder-note';
    p.textContent = text;
    return p;
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
    filterCol = null;
    filterVal = '';

    // Seed dropdowns from metadata columns immediately (no type info yet)
    const seedCols = getInitialColumns(acorn.columns);
    xColValue = seedCols.x;
    yColValue = seedCols.y;
    byColValue = null;
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
      buildColumnSelectors(liveColumns);
    }
    rebuildPlot();
  }

  return { el: container, notifyTableLoading, notifyTableRegistered };
}

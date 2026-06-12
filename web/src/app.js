/**
 * app.js — Entry point for the main Data Explorer page (/).
 *
 * Initializes the DuckDB coordinator, fetches metadata, then renders the
 * explorer (TimeView + DataViews + settings).
 *
 * Other pages (assets, contributions, subject, smartspim) each have their own
 * entry point so they can load independently without blocking on httpfs/DuckDB.
 */

import { coordinator, wasmConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { initSettings } from './explorer/settings.js';
import { createTimeView } from './explorer/time-view.js';
import { createDataView } from './explorer/data-view.js';
import { VERSIONS_URL } from './constants.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const loadingEl = document.getElementById('loading-message');

  try {
    // 1. Connect the Mosaic coordinator to the local duckdb-server.
    coordinator().databaseConnector(wasmConnector());

    // 2. Fetch cache_registry.json and register metadata tables in DuckDB.
    const metadata = await fetchAndRegisterMetadata(coordinator(), VERSIONS_URL);

    console.info('[DataExplorer] Metadata loaded. Acorns:', metadata.acorns.map((a) => a.name));

    // Clear the initial loading message before mounting views.
    if (loadingEl) loadingEl.remove();

    // 3. Build and mount the explorer.
    const app = document.getElementById('app');
    if (!app) return;

    app.appendChild(buildExplorer(metadata));

  } catch (err) {
    console.error('[DataExplorer] Initialisation failed:', err);
    renderError(err);
  }
}

// ---------------------------------------------------------------------------
// Main explorer builder
// ---------------------------------------------------------------------------

/**
 * Build the main data-explorer element (TimeView + DataViews + settings).
 * Called once; the returned element is re-attached when navigating back to '/'.
 *
 * @param {object} metadata - Parsed cache registry metadata.
 * @returns {HTMLElement}
 */
function buildExplorer(metadata) {
  // Settings bar content
  const { $queryFilter, settingsEl, onTableLoading, onTableRegistered, onTableFailed } = initSettings(coordinator(), metadata);
  const settingsBar = document.getElementById('settings-bar');
  if (settingsBar && !settingsBar.querySelector('.settings-content')) {
    settingsBar.appendChild(settingsEl);
  }

  const fragment = document.createDocumentFragment();

  // TimeView
  const { $timeSelection, el: timeViewEl } = createTimeView($queryFilter);
  fragment.appendChild(timeViewEl);

  // DataViews container
  const dataViewsEl = document.createElement('div');
  dataViewsEl.id = 'data-views';
  dataViewsEl.className = 'data-views-container';
  fragment.appendChild(dataViewsEl);

  const addBtnEl = document.createElement('button');
  addBtnEl.type = 'button';
  addBtnEl.className = 'add-data-view-btn';
  addBtnEl.textContent = '+ Add Data View';
  fragment.appendChild(addBtnEl);

  // Wrapper div so the fragment can be cached and re-appended.
  const wrapper = document.createElement('div');
  wrapper.className = 'explorer-root';
  wrapper.appendChild(fragment);

  // DataView lifecycle
  const dataViews = [];
  let nextId = 1;

  function updateRemoveButtons() {
    const onlyOne = dataViews.length <= 1;
    for (const dv of dataViews) {
      dv.removeBtn.disabled = onlyOne;
    }
  }

  function addDataView() {
    const id = String(nextId++);
    const dv = createDataView(id, $timeSelection, metadata);

    onTableLoading(dv.notifyTableLoading);
    onTableRegistered(dv.notifyTableRegistered);
    onTableFailed(dv.notifyTableFailed);

    dv.removeBtn.addEventListener('click', () => {
      const idx = dataViews.indexOf(dv);
      if (idx === -1) return;
      dataViews.splice(idx, 1);
      dv.el.remove();
      updateRemoveButtons();
    });

    dataViews.push(dv);
    dataViewsEl.appendChild(dv.el);
    updateRemoveButtons();
  }

  addBtnEl.addEventListener('click', () => addDataView());

  // Seed with one DataView.
  addDataView();

  return wrapper;
}

// ---------------------------------------------------------------------------
// Error renderer
// ---------------------------------------------------------------------------

function renderError(err) {
  const app = document.getElementById('app');
  if (!app) return;

  // Detect WebSocket / network failures and give actionable guidance.
  const msg = String(err?.message ?? err);
  const isConnErr =
    msg.toLowerCase().includes('websocket') ||
    msg.toLowerCase().includes('connect') ||
    err?.type === 'error' ||
    err?.constructor?.name === 'CloseEvent';

  const title = isConnErr ? 'Cannot initialise DuckDB-WASM' : 'Initialisation error';
  const body = `<pre>${String(err?.stack ?? err?.message ?? err)}</pre>`;

  app.innerHTML = `
    <div class="card error">
      <h2>${title}</h2>
      ${body}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

init();

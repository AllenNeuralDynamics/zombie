/**
 * app.js — Entry point for ZOMBIE Mosaic.
 *
 * Phase 1: Initialize DuckDB-WASM, fetch metadata, render a placeholder.
 * Phase 2: Settings bar — project selector and data-type toggles.
 * Phase 3: TimeView — session timeline with intervalX brush selection.
 * Phase 4: DataView — interactive scatter plot filtered by time selection.
 * Phase 5: Multiple DataViews — add/remove with minimum-one enforcement.
 */

import { coordinator, socketConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './metadata.js';
import { initSettings } from './settings.js';
import { createTimeView } from './time-view.js';
import { createDataView } from './data-view.js';
import { SQUIRREL_URL, SERVER_WS_URL } from './constants.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const loadingEl = document.getElementById('loading-message');

  try {
    // 1. Connect the Mosaic coordinator to the local duckdb-server.
    //    The server runs DuckDB with full AWS credential chain support
    //    (AWS_PROFILE env var) and native s3:// path resolution.
    //    Start the server with: npm run server
    coordinator().databaseConnector(socketConnector(SERVER_WS_URL));

    if (loadingEl) loadingEl.textContent = 'Loading dataset catalogue…';

    // 2. Fetch squirrel.json and register metadata tables in DuckDB.
    const metadata = await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);

    console.info('[ZOMBIE] Metadata loaded. Acorns:', metadata.acorns.map((a) => a.name));

    // 3. Phase 2: Settings bar
    const { $queryFilter, settingsEl, onTableLoading, onTableRegistered } = initSettings(coordinator(), metadata);
    const settingsBar = document.getElementById('settings-bar');
    if (settingsBar) {
      settingsBar.appendChild(settingsEl);
    }

    // 4. Phase 3: TimeView
    const { $timeSelection, el: timeViewEl } = createTimeView($queryFilter);

    // Clear the loading message; mount the views.
    if (loadingEl) loadingEl.remove();

    const app = document.getElementById('app');
    if (!app) return;

    app.appendChild(timeViewEl);

    // 5. Phase 5: Multiple DataViews container + Add button
    const dataViewsEl = document.createElement('div');
    dataViewsEl.id = 'data-views';
    dataViewsEl.className = 'data-views-container';
    app.appendChild(dataViewsEl);

    const addBtnEl = document.createElement('button');
    addBtnEl.type = 'button';
    addBtnEl.className = 'add-data-view-btn';
    addBtnEl.textContent = '+ Add Data View';
    app.appendChild(addBtnEl);

    // Active DataView records — each entry holds the remove button so we
    // can disable it when only one view remains.
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

  } catch (err) {
    console.error('[ZOMBIE] Initialisation failed:', err);
    renderError(err);
  }
}

// ---------------------------------------------------------------------------
// Error renderer
// ---------------------------------------------------------------------------

function renderError(err) {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div class="card error">
      <h2>Initialisation error</h2>
      <pre>${err.message}</pre>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

init();

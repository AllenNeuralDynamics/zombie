/**
 * app.js — Entry point for ZOMBIE Mosaic.
 *
 * Phase 1: Initialize DuckDB-WASM, fetch metadata, render a placeholder.
 * Phase 2: Settings bar — project selector and data-type toggles.
 * Phase 3: TimeView — session timeline with intervalX brush selection.
 * Phase 4: DataView — interactive scatter plot filtered by time selection.
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
    const { $project, settingsEl, onTableLoading, onTableRegistered } = initSettings(coordinator(), metadata);
    const settingsBar = document.getElementById('settings-bar');
    if (settingsBar) {
      settingsBar.appendChild(settingsEl);
    }

    // 4. Phase 3: TimeView
    const { $timeSelection, el: timeViewEl } = createTimeView($project);

    // 5. Phase 4: DataView
    const { el: dataViewEl, notifyTableLoading, notifyTableRegistered } = createDataView('1', $timeSelection, metadata);
    // Notify the DataView when a table starts loading (show spinner)
    // and when it finishes (render the plot).
    onTableLoading(notifyTableLoading);
    onTableRegistered(notifyTableRegistered);

    // Clear the loading message; mount the views.
    if (loadingEl) loadingEl.remove();

    const app = document.getElementById('app');
    if (app) {
      app.appendChild(timeViewEl);

      const dataViewsEl = document.createElement('div');
      dataViewsEl.id = 'data-views';
      dataViewsEl.className = 'data-views-container';
      dataViewsEl.appendChild(dataViewEl);
      app.appendChild(dataViewsEl);
    }
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

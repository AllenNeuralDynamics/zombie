/**
 * assets-entry.js — Entry point for the standalone Assets page.
 *
 * Connects to DuckDB, loads httpfs + metadata, then renders the assets table.
 */

import { coordinator, socketConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { createAssetsView } from './assets/view.js';
import { SQUIRREL_URL, SERVER_WS_URL } from './constants.js';

async function init() {
  const loadingEl = document.getElementById('loading-message');
  const app = document.getElementById('app');
  if (!app) return;

  try {
    coordinator().databaseConnector(socketConnector(SERVER_WS_URL));
    await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    if (loadingEl) loadingEl.remove();

    app.appendChild(createAssetsView(coordinator()));
  } catch (err) {
    console.error('[Assets] Initialisation failed:', err);
    if (loadingEl) {
      loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    }
  }
}

init();

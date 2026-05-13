/**
 * sessions-entry.js — Entry point for the standalone Behavioral Sessions page.
 *
 * Connects to DuckDB, loads metadata, then renders the Sessions view.
 */

import { coordinator, socketConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { createSessionsView } from './sessions/view.js';
import { SQUIRREL_URL, SERVER_WS_URL } from './constants.js';

async function init() {
  const loadingEl = document.getElementById('loading-message');
  const app = document.getElementById('app');
  if (!app) return;

  try {
    coordinator().databaseConnector(socketConnector(SERVER_WS_URL));
    const metadata = await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    if (loadingEl) loadingEl.remove();

    app.appendChild(createSessionsView(coordinator(), metadata));
  } catch (err) {
    console.error('[Sessions] Initialisation failed:', err);
    if (loadingEl) {
      loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    }
  }
}

init();

/**
 * smartspim-entry.js — Entry point for the standalone SmartSPIM page.
 *
 * Connects to DuckDB, loads httpfs + metadata, then renders the SmartSPIM view.
 */

import { coordinator, wasmConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { createSmartSpimView } from './smartspim/view.js';
import { SQUIRREL_URL } from './constants.js';

async function init() {
  const loadingEl = document.getElementById('loading-message');
  const app = document.getElementById('app');
  if (!app) return;

  try {
    coordinator().databaseConnector(wasmConnector());
    const metadata = await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    if (loadingEl) loadingEl.remove();

    app.appendChild(createSmartSpimView(coordinator(), metadata));
  } catch (err) {
    console.error('[SmartSPIM] Initialisation failed:', err);
    if (loadingEl) {
      loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    }
  }
}

init();

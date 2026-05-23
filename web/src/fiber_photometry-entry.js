/**
 * fiber_photometry-entry.js — Entry point for the Fiber Photometry Platform page.
 */

import { coordinator, wasmConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { createFiberPhotometryView } from './fiber_photometry/view.js';
import { SQUIRREL_URL } from './constants.js';

async function init() {
  const loadingEl = document.getElementById('loading-message');
  const app = document.getElementById('app');
  if (!app) return;

  try {
    coordinator().databaseConnector(wasmConnector());
    await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    if (loadingEl) loadingEl.remove();

    app.appendChild(createFiberPhotometryView(coordinator()));
  } catch (err) {
    console.error('[FiberPhotometry] Initialisation failed:', err);
    if (loadingEl) {
      loadingEl.textContent = `Failed to load: ${err?.message ?? err}`;
      loadingEl.className = 'loading-message error';
    }
  }
}

init();

/**
 * subject-entry.js — Entry point for the standalone Subject page.
 *
 * Uses DocDB for subject data.  Optionally connects to DuckDB for the
 * subject-ID dropdown list, but renders the page even if DuckDB is unavailable.
 */

import { coordinator, socketConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { createSubjectView } from './subject/view.js';
import { SQUIRREL_URL, SERVER_WS_URL } from './constants.js';

async function init() {
  const app = document.getElementById('app');
  if (!app) return;

  // Try to connect to DuckDB for the subject-ID dropdown, but don't block
  // page rendering if it fails (the dropdown will just be empty).
  let coord = null;
  try {
    coordinator().databaseConnector(socketConnector(SERVER_WS_URL));
    await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    coord = coordinator();
  } catch (err) {
    console.warn('[Subject] DuckDB unavailable — subject dropdown will be empty:', err?.message);
  }

  app.appendChild(createSubjectView({ coordinator: coord }));
}

init();

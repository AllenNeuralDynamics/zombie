/**
 * project-entry.js — Entry point for the Project overview page.
 */

import { coordinator, wasmConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { createProjectView } from './project/view.js';
import { SQUIRREL_URL } from './constants.js';

async function init() {
  const app = document.getElementById('app');
  if (!app) return;

  let coord = null;
  try {
    coordinator().databaseConnector(wasmConnector());
    await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    coord = coordinator();
  } catch (err) {
    console.warn('[Project] DuckDB unavailable:', err?.message);
  }

  app.appendChild(createProjectView({ coordinator: coord }));
}

init();

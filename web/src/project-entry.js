/**
 * project-entry.js — Entry point for the Project overview page.
 */

import { coordinator, socketConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { createProjectView } from './project/view.js';
import { SQUIRREL_URL, SERVER_WS_URL } from './constants.js';

async function init() {
  const app = document.getElementById('app');
  if (!app) return;

  let coord = null;
  try {
    coordinator().databaseConnector(socketConnector(SERVER_WS_URL));
    await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);
    coord = coordinator();
  } catch (err) {
    console.warn('[Project] DuckDB unavailable:', err?.message);
  }

  app.appendChild(createProjectView({ coordinator: coord }));
}

init();

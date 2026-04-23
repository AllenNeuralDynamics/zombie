/**
 * contributions-entry.js — Entry point for the standalone Contributions page.
 *
 * No DuckDB or httpfs needed — this page only uses the DocDB REST API.
 */

import { createContributionsView } from './contributions/view.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const assetName = new URLSearchParams(window.location.search).get('asset_name') ?? '';
  app.appendChild(createContributionsView({ assetName }));
}

init();

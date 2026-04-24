/**
 * contributions-entry.js — Entry point for the standalone Contributions page.
 *
 * No DuckDB or httpfs needed — this page only uses the DocDB REST API.
 */

import { createContributionsView } from './contributions/view.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  const assetName = params.get('asset_name') ?? '';
  const projectName = params.get('project') ?? '';
  app.appendChild(createContributionsView({ assetName, projectName }));
}

init();

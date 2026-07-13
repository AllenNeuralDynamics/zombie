/**
 * analysis-framework-entry.js — Entry point for the /analysis-framework page.
 *
 * This dashboard queries the DocDB `analysis` database and public S3 buckets
 * via the docdb_proxy endpoints; it does not use DuckDB, so it mounts directly
 * instead of going through lib/bootstrap.js.
 */

import { createAnalysisFrameworkView } from './analysis_framework/view.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;
  const loadingEl = document.getElementById('loading-message');
  if (loadingEl) loadingEl.remove();
  app.appendChild(createAnalysisFrameworkView());
}

init();

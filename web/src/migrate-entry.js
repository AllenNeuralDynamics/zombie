/**
 * migrate-entry.js — Entry point for the hidden /migrate page.
 *
 * The page is a Preact app with its own state machine; no DuckDB is needed.
 */

import { render } from 'preact';
import { html } from 'htm/preact';
import { MigratePage } from './migrate/view.js';

const app = document.getElementById('app');
if (app) {
  app.innerHTML = '';
  render(html`<${MigratePage} />`, app);
}

/**
 * migrate-submit-entry.js — Entry point for /migrate/submit.
 */

import { render } from 'preact';
import { html } from 'htm/preact';
import { MigrateSubmitPage } from './migrate/submit-view.js';

const app = document.getElementById('app');
if (app) {
  app.innerHTML = '';
  render(html`<${MigrateSubmitPage} />`, app);
}

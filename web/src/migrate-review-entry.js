/**
 * migrate-review-entry.js — Entry point for /migrate/review.
 */

import { render } from 'preact';
import { html } from 'htm/preact';
import { MigrateReviewPage } from './migrate/review-view.js';

const app = document.getElementById('app');
if (app) {
  app.innerHTML = '';
  render(html`<${MigrateReviewPage} />`, app);
}

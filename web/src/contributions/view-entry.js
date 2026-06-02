/**
 * view-entry.js — Entry point for the contributions view page.
 */

import { createContributionsViewPage } from './view-page.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  const doi = params.get('doi') ?? '';
  app.appendChild(createContributionsViewPage({ doi }));
}

init();

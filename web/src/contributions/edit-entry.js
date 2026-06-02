/**
 * edit-entry.js — Entry point for the contributions edit (admin) page.
 */

import { createContributionsEditPage } from './edit-page.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  const doi = params.get('doi') ?? '';
  app.appendChild(createContributionsEditPage({ doi }));
}

init();

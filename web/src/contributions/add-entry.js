/**
 * add-entry.js — Entry point for the contributions add/self-service page.
 */

import { createContributionsAddPage } from './add-page.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  const doi = params.get('doi') ?? '';
  const token = params.get('token') ?? '';
  app.appendChild(createContributionsAddPage({ doi, token }));
}

init();

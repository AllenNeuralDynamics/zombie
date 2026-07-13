/**
 * add-entry.js — Entry point for the contributions add/self-service page.
 */

import { createContributionsAddPage } from './add-page.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  // New ORCID invite links use `?project=…&token=…`; legacy token links use
  // `?doi=…&token=…&author=…`. Support both.
  const project = params.get('project') ?? '';
  const doi = params.get('doi') ?? '';
  const token = params.get('token') ?? '';
  const author = params.get('author') ?? '';
  app.appendChild(createContributionsAddPage({ project, doi, token, author }));
}

init();

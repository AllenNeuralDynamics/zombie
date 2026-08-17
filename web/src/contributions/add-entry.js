/**
 * add-entry.js — Entry point for the contributions add/self-service page.
 */

import { createContributionsAddPage } from './add-page.js';

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  // Linked from the /view "Edit" button as `?project=…`. `?doi=…&author=…` is
  // also accepted for backward compatibility with older links.
  const project = params.get('project') ?? '';
  const doi = params.get('doi') ?? '';
  const author = params.get('author') ?? '';
  app.appendChild(createContributionsAddPage({ project, doi, author }));
}

init();

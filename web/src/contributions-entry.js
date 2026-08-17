/**
 * contributions-entry.js — Landing page for the Contributions section.
 *
 * Provides a simple input to enter a DOI / project name and navigate to
 * the view or edit page. If the typed value doesn't match a known project
 * name, it suggests the closest matches (fuzzy search) so typos are caught
 * before navigating to a "not found" page.
 */

import { CONTRIBUTIONS_API_BASE } from './constants.js';

/** Known project names, loaded once from the contributions API. */
let projectNames = [];

/**
 * Levenshtein edit distance between two strings (iterative, O(n*m)).
 * @returns {number}
 */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Return up to `limit` project names closest to `query`, ranked by a
 * normalized edit-distance similarity. Only reasonably-close matches are
 * returned (similarity above a threshold), so unrelated input yields nothing.
 *
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]}
 */
function fuzzyMatch(query, limit = 2) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = projectNames.map((name) => {
    const lower = name.toLowerCase();
    // Substring hits are strong signals; otherwise use edit distance.
    let similarity;
    if (lower.includes(q) || q.includes(lower)) {
      similarity = 0.9 + 0.1 * (Math.min(q.length, lower.length) / Math.max(q.length, lower.length));
    } else {
      const dist = editDistance(q, lower);
      similarity = 1 - dist / Math.max(q.length, lower.length);
    }
    return { name, similarity };
  });
  return scored
    .filter((s) => s.similarity >= 0.55)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map((s) => s.name);
}

/** True when the value exactly matches a known project (case-insensitive). */
function isKnownProject(value) {
  const v = value.trim().toLowerCase();
  return projectNames.some((n) => n.toLowerCase() === v);
}

/** DOIs are passed through untouched — don't fuzzy-match them as project names. */
function looksLikeDoi(value) {
  return /^10\.\d{4,}\//.test(value.trim()) || value.trim().toLowerCase().startsWith('doi:');
}

/** True when the value is something we can open directly: a DOI or a real project. */
function isReal(value) {
  return looksLikeDoi(value) || isKnownProject(value);
}

function init() {
  const app = document.getElementById('app');
  if (!app) return;

  app.innerHTML = `
    <div class="contributions-landing">
      <h1 class="contributions-landing-title">CRediT Author Contributions</h1>
      <p class="contributions-landing-desc">
        Enter a DOI or project name to view or edit the contribution matrix.
      </p>
      <div class="contributions-landing-form">
        <input id="cl-doi-input" type="text" class="contributions-landing-input"
               placeholder="e.g. 10.1234/example.2024 or my-project-name" autocomplete="off" />
        <div id="cl-suggest" class="contributions-landing-suggest" hidden></div>
        <div class="contributions-landing-btns">
          <button id="cl-view-btn" class="btn-primary" disabled>View</button>
          <button id="cl-edit-btn" class="btn-secondary" disabled>Edit</button>
        </div>
      </div>
    </div>
  `;

  const input = app.querySelector('#cl-doi-input');
  const viewBtn = app.querySelector('#cl-view-btn');
  const editBtn = app.querySelector('#cl-edit-btn');
  const suggestEl = app.querySelector('#cl-suggest');

  // Load the project list in the background for fuzzy matching / validation,
  // then re-evaluate the current input so buttons enable once the list arrives.
  fetch(`${CONTRIBUTIONS_API_BASE}/contributions/projects`)
    .then((res) => (res.ok ? res.json() : []))
    .then((names) => { if (Array.isArray(names)) projectNames = names; refresh(); })
    .catch(() => { /* fuzzy suggestions are best-effort */ });

  function clearSuggestions() {
    suggestEl.hidden = true;
    suggestEl.innerHTML = '';
  }

  function renderSuggestions(matches) {
    suggestEl.hidden = false;
    suggestEl.innerHTML = `
      <span class="contributions-landing-suggest-label">Matching projects:</span>
      ${matches
        .map(
          (name) =>
            `<button type="button" class="contributions-landing-suggest-btn" data-name="${
              name.replace(/"/g, '&quot;')
            }">${name}</button>`,
        )
        .join('')}
    `;
    suggestEl.querySelectorAll('.contributions-landing-suggest-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.name;
        refresh();
        input.focus();
      });
    });
  }

  // Re-evaluate button state and live suggestions for the current input.
  function refresh() {
    const value = input.value.trim();
    const real = !!value && isReal(value);

    // View only opens an existing project/DOI; Edit doubles as "create New".
    viewBtn.disabled = !real;
    editBtn.disabled = !value;
    editBtn.textContent = real ? 'Edit' : 'New';
    editBtn.title = real
      ? 'Edit this project'
      : (value ? `Create a new project "${value}"` : '');

    // Suggest close matches while the typed name isn't a real project yet.
    if (value && !real && !looksLikeDoi(value) && projectNames.length) {
      const matches = fuzzyMatch(value);
      if (matches.length) renderSuggestions(matches);
      else clearSuggestions();
    } else {
      clearSuggestions();
    }
  }

  function go(page, value) {
    window.location.href = `/contributions/${page}?doi=${encodeURIComponent(value)}`;
  }

  viewBtn.addEventListener('click', () => {
    const value = input.value.trim();
    if (value && isReal(value)) go('view', value);
  });
  editBtn.addEventListener('click', () => {
    const value = input.value.trim();
    if (value) go('edit', value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const value = input.value.trim();
    if (value && isReal(value)) go('view', value);
  });
  input.addEventListener('input', refresh);

  refresh();
}

init();

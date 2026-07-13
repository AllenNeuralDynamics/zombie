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
               placeholder="e.g. 10.1234/example.2024 or my-project-name" />
        <div id="cl-suggest" class="contributions-landing-suggest" hidden></div>
        <div class="contributions-landing-btns">
          <button id="cl-view-btn" class="btn-primary">View</button>
          <button id="cl-edit-btn" class="btn-secondary">Edit</button>
        </div>
      </div>
    </div>
  `;

  const input = app.querySelector('#cl-doi-input');
  const viewBtn = app.querySelector('#cl-view-btn');
  const editBtn = app.querySelector('#cl-edit-btn');
  const suggestEl = app.querySelector('#cl-suggest');

  // Load the project list in the background for fuzzy matching.
  fetch(`${CONTRIBUTIONS_API_BASE}/contributions/projects`)
    .then((res) => (res.ok ? res.json() : []))
    .then((names) => { if (Array.isArray(names)) projectNames = names; })
    .catch(() => { /* fuzzy suggestions are best-effort */ });

  function clearSuggestions() {
    suggestEl.hidden = true;
    suggestEl.innerHTML = '';
  }

  function go(page, value) {
    window.location.href = `/contributions/${page}?doi=${encodeURIComponent(value)}`;
  }

  function navigate(page) {
    const value = input.value.trim();
    if (!value) { input.focus(); return; }

    // Pass through DOIs, exact project matches, or when we have no list yet.
    if (looksLikeDoi(value) || projectNames.length === 0 || isKnownProject(value)) {
      go(page, value);
      return;
    }

    const matches = fuzzyMatch(value);
    if (matches.length === 0) {
      // Nothing close — let the target page report "not found".
      go(page, value);
      return;
    }

    // Offer the closest project name(s) before navigating.
    suggestEl.hidden = false;
    suggestEl.innerHTML = `
      <span class="contributions-landing-suggest-label">Did you mean:</span>
      ${matches
        .map(
          (name) =>
            `<button type="button" class="contributions-landing-suggest-btn" data-name="${
              name.replace(/"/g, '&quot;')
            }">${name}</button>`,
        )
        .join('')}
      <button type="button" class="contributions-landing-suggest-btn contributions-landing-suggest-keep"
              data-keep="1">Use "${value}" anyway</button>
    `;
    suggestEl.querySelectorAll('.contributions-landing-suggest-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const chosen = btn.dataset.keep ? value : btn.dataset.name;
        input.value = chosen;
        clearSuggestions();
        go(page, chosen);
      });
    });
  }

  viewBtn.addEventListener('click', () => navigate('view'));
  editBtn.addEventListener('click', () => navigate('edit'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigate('view');
  });
  input.addEventListener('input', clearSuggestions);
}

init();

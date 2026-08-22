/**
 * swdb/index-view.js — SWDB landing page: one card per curated dataset.
 *
 * Each card summarises one registry-published SWDB metadata table and links to
 * its dataset page at `/swdb/set?dataset=<name>`.
 */

import { escHtml } from '../lib/utils.js';
import { loadSwdbDatasetSummaries } from './data.js';
import { datasetInfo } from './sets.js';

/**
 * Build the SWDB index view.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @param {{ acorns: object[] }} metadata - Resolved cache registry.
 * @returns {HTMLElement}
 */
export function createSwdbIndexView(coord, metadata) {
  const root = document.createElement('div');
  root.className = 'swdb-index';
  root.appendChild(buildIntro());

  const cards = document.createElement('div');
  cards.className = 'swdb-card-grid';
  cards.innerHTML = '<div class="swdb-panel-status">Loading sets…</div>';
  root.appendChild(cards);

  (async () => {
    try {
      const datasets = await loadSwdbDatasetSummaries(coord, metadata);
      if (datasets.length === 0) {
        cards.innerHTML = '<div class="swdb-panel-status">No SWDB datasets are cached yet.</div>';
        return;
      }
      cards.replaceChildren(...datasets.map(buildCard));
    } catch (err) {
      cards.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'swdb-panel-status swdb-panel-status--error';
      msg.textContent = `Could not load the SWDB dataset catalog: ${err.message}`;
      cards.appendChild(msg);
      console.error('[SWDB] index load failed', err);
    }
  })();

  return root;
}

function buildIntro() {
  const el = document.createElement('section');
  el.className = 'swdb-intro';
  el.innerHTML = `
    <h1>SWDB data sets</h1>
    <p>
      Curated datasets prepared for the Summer Workshop on the Dynamic Brain. Pick a dataset to
      browse its canonical assets now; interactive dataset plots will be added here next.
    </p>
  `;
  return el;
}

function buildCard(dataset) {
  const info = datasetInfo(dataset.name);
  const card = document.createElement('a');
  card.className = 'swdb-card';
  card.href = `/swdb/set?dataset=${encodeURIComponent(dataset.name)}`;

  const span = dataset.firstDate && dataset.lastDate
    ? `${dataset.firstDate} → ${dataset.lastDate}`
    : 'dates unavailable';

  card.innerHTML = `
    <h2>${escHtml(info.title)}</h2>
    <p class="swdb-card-blurb">${escHtml(info.blurb)}</p>
    <dl class="swdb-card-stats">
      <div><dt>Assets</dt><dd>${dataset.nAssets.toLocaleString()}</dd></div>
      <div><dt>Subjects</dt><dd>${dataset.nSubjects.toLocaleString()}</dd></div>
    </dl>
    <div class="swdb-card-span">${escHtml(span)}</div>
    <div class="swdb-card-action">Open dataset <span aria-hidden="true">→</span></div>
  `;
  return card;
}

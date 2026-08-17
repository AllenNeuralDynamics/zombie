/**
 * swdb/index-view.js — SWDB landing page: one card per curated set.
 *
 * Reads only the small unpartitioned session catalog, so the page is a single
 * parquet fetch regardless of how many sets exist. Each card summarises the set
 * (assets, subjects, date span, totals, which modalities are present) and links to
 * its own page at `/swdb/set?set=<id>`.
 */

import { escHtml } from '../lib/utils.js';
import { loadSessions } from './data.js';
import { summariseSets } from './sets.js';

/**
 * Build the SWDB index view.
 *
 * @param {object} coord - Mosaic/DuckDB coordinator.
 * @returns {HTMLElement}
 */
export function createSwdbIndexView(coord) {
  const root = document.createElement('div');
  root.className = 'swdb-index';
  root.appendChild(buildIntro());

  const cards = document.createElement('div');
  cards.className = 'swdb-card-grid';
  cards.innerHTML = '<div class="swdb-panel-status">Loading sets…</div>';
  root.appendChild(cards);

  (async () => {
    try {
      const sessions = await loadSessions(coord);
      const sets = summariseSets(sessions);
      if (sets.length === 0) {
        cards.innerHTML = '<div class="swdb-panel-status">No SWDB sets are cached yet.</div>';
        return;
      }
      cards.replaceChildren(...sets.map(buildCard));
    } catch (err) {
      cards.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'swdb-panel-status swdb-panel-status--error';
      msg.textContent = `Could not load the SWDB session catalog: ${err.message}`;
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
      Curated sets of merged NWB assets prepared for the Summer Workshop on the Dynamic Brain.
      Each asset folds several modalities — behavior, DLC eye tracking, receptive-field mapping,
      optotagging and sorted units — into a single file. Pick a set to see its history and open
      individual sessions in the viewer.
    </p>
  `;
  return el;
}

const MODALITY_LABELS = {
  behavior: 'Behavior',
  eye: 'Eye tracking',
  units: 'Sorted units',
  optotagging: 'Optotagging',
  rfMapping: 'RF mapping',
};

function buildCard(set) {
  const card = document.createElement('a');
  card.className = 'swdb-card';
  card.href = `/swdb/set?set=${encodeURIComponent(set.setId)}`;

  const span = set.firstDate && set.lastDate
    ? `${set.firstDate} → ${set.lastDate}`
    : 'dates unavailable';

  const chips = Object.entries(MODALITY_LABELS)
    .filter(([key]) => set.modalities[key])
    .map(([, label]) => `<span class="swdb-chip">${escHtml(label)}</span>`)
    .join('');

  card.innerHTML = `
    <h2>${escHtml(set.title)}</h2>
    <p class="swdb-card-blurb">${escHtml(set.blurb)}</p>
    <dl class="swdb-card-stats">
      <div><dt>Assets</dt><dd>${set.nAssets}</dd></div>
      <div><dt>Subjects</dt><dd>${set.nSubjects}</dd></div>
      <div><dt>Trials</dt><dd>${set.nTrials.toLocaleString()}</dd></div>
      <div><dt>Units</dt><dd>${set.nUnits.toLocaleString()}</dd></div>
      <div><dt>Recorded</dt><dd>${set.totalHours.toFixed(0)} h</dd></div>
    </dl>
    <div class="swdb-card-span">${escHtml(span)}</div>
    <div class="swdb-chips">${chips}</div>
  `;
  return card;
}

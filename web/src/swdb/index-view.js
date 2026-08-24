/**
 * swdb/index-view.js — SWDB landing page: one card per curated dataset.
 *
 * Each card summarises one registry-published SWDB metadata table and links to
 * its dataset page at `/swdb/set?dataset=<name>`.
 */

import { escHtml } from '../lib/utils.js';
import { buildInteractiveAssetOverviewHistogram } from '../lib/charts.js';
import { loadSwdbDatasetSummaries, loadSwdbOverviewAssets } from './data.js';
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

  const overview = buildOverview();
  root.appendChild(overview.element);

  const cards = document.createElement('div');
  cards.className = 'swdb-card-grid';
  cards.innerHTML = '<div class="swdb-panel-status">Loading sets…</div>';
  root.appendChild(cards);

  (async () => {
    try {
      const datasets = await loadSwdbDatasetSummaries(coord, metadata);
      if (datasets.length === 0) {
        overview.setRows([]);
        cards.innerHTML = '<div class="swdb-panel-status">No SWDB datasets are cached yet.</div>';
        return;
      }
      cards.replaceChildren(...datasets.map(buildCard));
      cards.querySelectorAll('.swdb-card[data-dataset]').forEach((card) => {
        card.addEventListener('mouseenter', () => overview.hoverDataset(card.dataset.dataset));
        card.addEventListener('mouseleave', () => overview.clearDatasetHover());
      });
      try {
        const rows = await loadSwdbOverviewAssets(coord, metadata);
        overview.setRows(rows.map((row) => ({
          ...row,
          datasetLabel: datasetInfo(row.dataset).title,
        })));
      } catch (err) {
        overview.setError(err);
        console.error('[SWDB] overview load failed', err);
      }
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

/** Build the shared acquisition histogram with the SWDB-specific grouping toggle. */
function buildOverview() {
  const section = document.createElement('section');
  section.className = 'swdb-overview platform-overview';

  const heading = document.createElement('div');
  heading.className = 'swdb-overview-heading';
  const title = document.createElement('h2');
  title.textContent = 'Asset overview';
  heading.appendChild(title);

  const toggle = document.createElement('div');
  toggle.className = 'swdb-overview-toggle';
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Asset overview grouping');
  const modes = [
    ['dataset', 'SWDB dataset'],
    ['modality', 'Modality'],
  ];
  const buttons = new Map();
  let mode = 'dataset';
  for (const [value, label] of modes) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swdb-overview-toggle-button';
    button.textContent = label;
    button.addEventListener('click', () => {
      mode = value;
      for (const [other, otherButton] of buttons) {
        otherButton.classList.toggle('is-active', other === mode);
        otherButton.setAttribute('aria-pressed', String(other === mode));
      }
      render();
    });
    buttons.set(value, button);
    toggle.appendChild(button);
  }
  heading.appendChild(toggle);
  section.appendChild(heading);

  const body = document.createElement('div');
  body.className = 'platform-overview-body';
  const chartCol = document.createElement('div');
  chartCol.className = 'platform-overview-histogram swdb-overview-chart';
  const chart = document.createElement('div');
  chart.className = 'platform-overview-histogram-plot';
  chart.textContent = 'Loading overview…';
  chartCol.appendChild(chart);
  body.appendChild(chartCol);
  section.appendChild(body);

  buttons.get(mode).classList.add('is-active');
  buttons.get(mode).setAttribute('aria-pressed', 'true');

  let rows = [];
  let error = null;
  let resizeObserver = null;
  let interactivePlot = null;

  function render() {
    if (error) {
      chart.className = 'swdb-panel-status swdb-panel-status--error';
      chart.textContent = `Could not load the asset overview: ${error.message}`;
      return;
    }
    if (rows.length === 0) {
      chart.className = 'swdb-panel-status';
      chart.textContent = 'No dated SWDB assets are available.';
      return;
    }
    chart.className = 'platform-overview-histogram-plot';
    const width = chart.getBoundingClientRect().width || 650;
    interactivePlot = buildInteractiveAssetOverviewHistogram(rows, width, {
      groupBy: mode,
      xTicks: 'year',
      hoverFilters: mode === 'dataset',
      onHoverGroup: (group) => {
        section.dispatchEvent(new CustomEvent('swdb-dataset-hover', { detail: group }));
      },
    });
    chart.replaceChildren();
    if (interactivePlot) chart.appendChild(interactivePlot);
  }

  section.addEventListener('swdb-dataset-hover', (event) => {
    const selected = event.detail;
    section.parentElement?.querySelectorAll('.swdb-card[data-dataset]').forEach((card) => {
      const isSelected = selected == null || card.dataset.dataset === selected;
      card.classList.toggle('swdb-card--dimmed', !isSelected);
      card.classList.toggle('swdb-card--highlighted', selected != null && isSelected);
    });
  });

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(chart);
  }

  return {
    element: section,
    setRows(nextRows) {
      error = null;
      rows = nextRows;
      render();
    },
    setError(nextError) {
      error = nextError;
      render();
    },
    hoverDataset(dataset) {
      if (mode === 'dataset') interactivePlot?.setHoverGroup?.(dataset);
    },
    clearDatasetHover() {
      if (mode === 'dataset') interactivePlot?.clearHoverGroup?.();
    },
    dispose() {
      resizeObserver?.disconnect();
    },
  };
}

function buildIntro() {
  const el = document.createElement('section');
  el.className = 'swdb-intro';
  el.innerHTML = `
    <h1>SWDB data sets</h1>
  `;
  return el;
}

function buildCard(dataset) {
  const info = datasetInfo(dataset.name);
  const card = document.createElement('a');
  card.className = 'swdb-card';
  card.dataset.dataset = dataset.name;
  card.href = `/swdb/set?dataset=${encodeURIComponent(dataset.name)}`;

  const span = dataset.firstDate && dataset.lastDate
    ? `${dataset.firstDate} → ${dataset.lastDate}`
    : 'dates unavailable';
  const modalities = (dataset.modalities ?? [])
    .map((modality) => `<span class="swdb-chip">${escHtml(modality)}</span>`)
    .join('');

  card.innerHTML = `
    <h2>${escHtml(info.title)}</h2>
    <div class="swdb-card-modalities" aria-label="Modalities">
      <span class="swdb-card-modalities-label">Modalities</span>
      <div class="swdb-chips">${modalities}</div>
    </div>
    <dl class="swdb-card-stats">
      <div><dt>Assets</dt><dd>${dataset.nAssets.toLocaleString()}</dd></div>
      <div><dt>Subjects</dt><dd>${dataset.nSubjects.toLocaleString()}</dd></div>
    </dl>
    <div class="swdb-card-span">${escHtml(span)}</div>
    <div class="swdb-card-action">Open dataset <span aria-hidden="true">→</span></div>
  `;
  return card;
}

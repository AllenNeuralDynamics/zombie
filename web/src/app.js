/**
 * app.js — Entry point for ZOMBIE Mosaic.
 *
 * Initializes the DuckDB coordinator, fetches metadata, then hands off to the
 * client-side router.  Routes:
 *   /               — Main data explorer (TimeView + DataViews)
 *   /assets         — Filterable table of all data assets
 *   /contributions  — CReDIT author contribution matrix editor
 */

import { coordinator, socketConnector } from '@uwdata/vgplot';
import { fetchAndRegisterMetadata } from './lib/metadata.js';
import { initSettings } from './explorer/settings.js';
import { createTimeView } from './explorer/time-view.js';
import { createDataView } from './explorer/data-view.js';
import { createAssetsView } from './assets/view.js';
import { createContributionsView } from './contributions/view.js';
import { createSubjectView } from './subject/view.js';
import { initRouter } from './router.js';
import { SQUIRREL_URL, SERVER_WS_URL } from './constants.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const loadingEl = document.getElementById('loading-message');

  try {
    // 1. Connect the Mosaic coordinator to the local duckdb-server.
    //    The server runs DuckDB with full AWS credential chain support
    //    (AWS_PROFILE env var) and native s3:// path resolution.
    //    Start the server with: npm run server
    coordinator().databaseConnector(socketConnector(SERVER_WS_URL));

    if (loadingEl) loadingEl.textContent = 'Loading dataset catalogue…';

    // 2. Fetch squirrel.json and register metadata tables in DuckDB.
    const metadata = await fetchAndRegisterMetadata(coordinator(), SQUIRREL_URL);

    console.info('[ZOMBIE] Metadata loaded. Acorns:', metadata.acorns.map((a) => a.name));

    // Clear the initial loading message before mounting views.
    if (loadingEl) loadingEl.remove();

    // 3. Build the main explorer once (cached across route changes).
    const explorerEl = buildExplorer(metadata);

    // 4. Set up routes and start the router.
    const settingsBar = document.getElementById('settings-bar');
    const app = document.getElementById('app');
    if (!app) return;

    initRouter({
      '/': () => {
        // Show settings bar and the main explorer.
        if (settingsBar) settingsBar.style.display = '';
        app.innerHTML = '';
        app.appendChild(explorerEl);
      },
      '/assets': () => {
        // Hide settings bar; show the assets table.
        if (settingsBar) settingsBar.style.display = 'none';
        app.innerHTML = '';
        app.appendChild(createAssetsView(coordinator()));
      },
      '/contributions': () => {
        // Hide settings bar; show the contributions editor.
        if (settingsBar) settingsBar.style.display = 'none';
        app.innerHTML = '';
        const assetName = new URLSearchParams(window.location.search).get('asset_name') ?? '';
        app.appendChild(createContributionsView({ assetName }));
      },
      '/subject': () => {
        // Hide settings bar; show the subject viewer.
        if (settingsBar) settingsBar.style.display = 'none';
        app.innerHTML = '';
        app.appendChild(createSubjectView());
      },
    });

  } catch (err) {
    console.error('[ZOMBIE] Initialisation failed:', err);
    renderError(err);
  }
}

// ---------------------------------------------------------------------------
// Main explorer builder
// ---------------------------------------------------------------------------

/**
 * Build the main data-explorer element (TimeView + DataViews + settings).
 * Called once; the returned element is re-attached when navigating back to '/'.
 *
 * @param {object} metadata - Parsed squirrel metadata.
 * @returns {HTMLElement}
 */
function buildExplorer(metadata) {
  // Settings bar content
  const { $queryFilter, settingsEl, onTableLoading, onTableRegistered } = initSettings(coordinator(), metadata);
  const settingsBar = document.getElementById('settings-bar');
  if (settingsBar && !settingsBar.querySelector('.settings-content')) {
    settingsBar.appendChild(settingsEl);
  }

  const fragment = document.createDocumentFragment();

  // TimeView
  const { $timeSelection, el: timeViewEl } = createTimeView($queryFilter);
  fragment.appendChild(timeViewEl);

  // DataViews container
  const dataViewsEl = document.createElement('div');
  dataViewsEl.id = 'data-views';
  dataViewsEl.className = 'data-views-container';
  fragment.appendChild(dataViewsEl);

  const addBtnEl = document.createElement('button');
  addBtnEl.type = 'button';
  addBtnEl.className = 'add-data-view-btn';
  addBtnEl.textContent = '+ Add Data View';
  fragment.appendChild(addBtnEl);

  // Wrapper div so the fragment can be cached and re-appended.
  const wrapper = document.createElement('div');
  wrapper.className = 'explorer-root';
  wrapper.appendChild(fragment);

  // DataView lifecycle
  const dataViews = [];
  let nextId = 1;

  function updateRemoveButtons() {
    const onlyOne = dataViews.length <= 1;
    for (const dv of dataViews) {
      dv.removeBtn.disabled = onlyOne;
    }
  }

  function addDataView() {
    const id = String(nextId++);
    const dv = createDataView(id, $timeSelection, metadata);

    onTableLoading(dv.notifyTableLoading);
    onTableRegistered(dv.notifyTableRegistered);

    dv.removeBtn.addEventListener('click', () => {
      const idx = dataViews.indexOf(dv);
      if (idx === -1) return;
      dataViews.splice(idx, 1);
      dv.el.remove();
      updateRemoveButtons();
    });

    dataViews.push(dv);
    dataViewsEl.appendChild(dv.el);
    updateRemoveButtons();
  }

  addBtnEl.addEventListener('click', () => addDataView());

  // Seed with one DataView.
  addDataView();

  return wrapper;
}

// ---------------------------------------------------------------------------
// Error renderer
// ---------------------------------------------------------------------------

function renderError(err) {
  const app = document.getElementById('app');
  if (!app) return;

  // Detect WebSocket / network failures and give actionable guidance.
  const msg = String(err?.message ?? err);
  const isConnErr =
    msg.toLowerCase().includes('websocket') ||
    msg.toLowerCase().includes('connect') ||
    err?.type === 'error' ||
    err?.constructor?.name === 'CloseEvent';

  const title = isConnErr ? 'Cannot connect to DuckDB server' : 'Initialisation error';
  const body = isConnErr
    ? `<p>Could not reach the DuckDB server at <code>${SERVER_WS_URL}</code>.</p>
       <p>Start it with:</p>
       <pre>npm run server</pre>
       <p class="error-hint">Then reload this page.</p>`
    : `<pre>${String(err?.stack ?? err?.message ?? err)}</pre>`;

  app.innerHTML = `
    <div class="card error">
      <h2>${title}</h2>
      ${body}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

init();

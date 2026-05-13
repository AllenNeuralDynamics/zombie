import { queryDocDb } from './lib/docdb.js';
import { createQCView } from './qc/view.js';

async function init() {
  const app = document.getElementById('app');
  if (!app) return;

  const params = new URLSearchParams(window.location.search);
  const assetName = params.get('name');

  if (!assetName) {
    app.innerHTML = '<p class="qc-empty">No asset specified. Use ?name=&lt;asset-name&gt;</p>';
    return;
  }

  app.innerHTML = '<p class="qc-loading">Loading QC data…</p>';

  try {
    const records = await queryDocDb({ name: assetName }, { limit: 1 });
    if (!records.length) {
      app.innerHTML = `<p class="qc-error">Asset "${assetName}" not found in DocDB.</p>`;
      return;
    }
    app.innerHTML = '';
    app.appendChild(createQCView(records[0]));
  } catch (err) {
    app.innerHTML = `<p class="qc-error">Failed to load: ${err.message}</p>`;
  }
}

init();

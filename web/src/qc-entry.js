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

  await loadRecord(app, assetName);
}

async function loadRecord(app, assetName, { replaceOnStart = true, throwOnFailure = false } = {}) {
  if (replaceOnStart) app.innerHTML = '<p class="qc-loading">Loading QC data…</p>';

  try {
    const records = await queryDocDb({ name: assetName }, { limit: 1 });
    if (!records.length) {
      throw new Error(`Asset "${assetName}" not found in DocDB.`);
    }

    // Look up raw (source) asset S3 location so ephys GUI URLs can be fully resolved.
    let rawS3Loc = '';
    const sourceDataName = records[0]?.data_description?.source_data?.[0];
    if (sourceDataName) {
      try {
        const rawRecords = await queryDocDb(
          { name: sourceDataName },
          { limit: 1, projection: { location: 1 } },
        );
        if (rawRecords.length) rawS3Loc = rawRecords[0].location ?? '';
      } catch {
        // Non-fatal: proceed without the raw asset location.
      }
    }

    const projectName = records[0]?.data_description?.project_name ?? '';
    if (projectName) {
      const u = new URL(window.location.href);
      u.searchParams.set('project', projectName);
      history.replaceState({}, '', u);
    }

    const nextView = createQCView(records[0], rawS3Loc, {
      onReload: () => loadRecord(app, assetName, { replaceOnStart: false, throwOnFailure: true }),
    });
    app.replaceChildren(nextView);
  } catch (err) {
    if (replaceOnStart) renderMessage(app, 'qc-error', `Failed to load: ${err?.message ?? err}`);
    if (throwOnFailure) throw err;
  }
}

function renderMessage(container, className, message) {
  const paragraph = document.createElement('p');
  paragraph.className = className;
  paragraph.textContent = message;
  container.replaceChildren(paragraph);
}

init();

import { bootstrap } from './lib/bootstrap.js';
import { queryRows } from './lib/arrow.js';
import { ensureTable, getAcorn } from './lib/registry.js';
import { fetchDocDbRecordsByName, queryDocDb } from './lib/docdb.js';
import { buildQcPartitionQuery } from './qc/cache.js';
import { assetNamesForQcRows, buildSourceDataQuery, findRawAssetName, sourceAssetNames } from './qc/lineage.js';
import { buildCachedLineageRecords } from './qc/data.js';
import { createQCView } from './qc/view.js';

function modalityAbbreviation(metric) {
  return typeof metric?.modality === 'object' ? metric.modality?.abbreviation : metric?.modality;
}

function latestMetricStatus(metric) {
  const history = metric?.status_history;
  return Array.isArray(history) && history.length ? history.at(-1)?.status : null;
}

function overlayLiveMetrics(rows, records) {
  const recordsByName = new Map(records.map(record => [record.name, record]));
  return rows.map(row => {
    const record = recordsByName.get(row.asset_name);
    const metrics = record?.quality_control?.metrics ?? [];
    const metric = metrics.find(candidate => candidate?.name === row.name &&
      (row.stage == null || candidate.stage === row.stage) &&
      (row.modality == null || modalityAbbreviation(candidate) === row.modality));
    if (!metric) return row;
    const qualityControl = record.quality_control ?? {};
    const value = metric.value !== null && typeof metric.value === 'object'
      ? JSON.stringify(metric.value)
      : metric.value;
    return {
      ...row,
      value,
      status: latestMetricStatus(metric),
      tags: metric.tags == null ? null : JSON.stringify(metric.tags),
      metric_json: JSON.stringify(metric),
      default_grouping: qualityControl.default_grouping == null ? null : JSON.stringify(qualityControl.default_grouping),
      asset_location: record.location ?? row.asset_location,
    };
  });
}

async function fetchRelevantSourceRows(coord, assetName) {
  await ensureTable(coord, 'source_data');

  const rows = [];
  const queriedNames = new Set();
  let pendingNames = [assetName];
  while (pendingNames.length) {
    const names = [...new Set(pendingNames.map(String))]
      .filter(name => name && !queriedNames.has(name));
    if (!names.length) break;
    names.forEach(name => queriedNames.add(name));

    const matchingRows = await queryRows(coord, buildSourceDataQuery(names));
    rows.push(...matchingRows);
    pendingNames = matchingRows.flatMap(row => sourceAssetNames(row.source_data));
  }
  return rows;
}

async function loadPage(coord, app, requestedName, {
  replaceOnStart = true,
  throwOnFailure = false,
  preferLive = false,
} = {}) {
  if (replaceOnStart) app.innerHTML = '<p class="qc-loading">Loading QC data…</p>';

  try {
    let sourceRows = [];
    try {
      sourceRows = await fetchRelevantSourceRows(coord, requestedName);
    } catch (error) {
      console.warn('[quality_control] source_data cache unavailable:', error);
    }

    const rawAssetName = findRawAssetName(requestedName, sourceRows);
    if (rawAssetName !== requestedName) {
      const url = new URL(window.location.href);
      url.searchParams.set('name', rawAssetName);
      history.replaceState(history.state, '', url);
    }

    const records = await queryDocDb({ name: rawAssetName }, { limit: 1 });
    if (!records.length) throw new Error(`Asset "${rawAssetName}" not found in DocDB.`);
    const rawRecord = records[0];

    let cachedRows = [];
    try {
      cachedRows = await queryRows(coord, buildQcPartitionQuery(getAcorn('quality_control'), rawAssetName));
    } catch (error) {
      // The DocDB record remains a useful read-only fallback while a new cache
      // version is propagating.
      console.warn('[quality_control] quality_control cache unavailable:', error);
    }

    let chainRecords = buildCachedLineageRecords(cachedRows, rawRecord);
    if (preferLive) {
      const liveNames = assetNamesForQcRows(cachedRows).filter(name => name !== rawRecord.name);
      const liveRecords = [rawRecord, ...(liveNames.length
        ? await fetchDocDbRecordsByName(liveNames, { limit: 1 })
        : [])];
      cachedRows = overlayLiveMetrics(cachedRows, liveRecords);
      chainRecords = buildCachedLineageRecords(cachedRows, rawRecord);
    }

    const nextView = createQCView(rawRecord, rawRecord.location ?? '', {
      cachedRows,
      chainRecords,
      onReload: () => loadPage(coord, app, rawAssetName, {
        replaceOnStart: false,
        throwOnFailure: true,
        preferLive: true,
      }),
    });
    app.replaceChildren(nextView);
  } catch (error) {
    if (replaceOnStart) renderMessage(app, 'qc-error', `Failed to load: ${error?.message ?? error}`);
    if (throwOnFailure) throw error;
  }
}

function renderMessage(container, className, message) {
  const paragraph = document.createElement('p');
  paragraph.className = className;
  paragraph.textContent = message;
  container.replaceChildren(paragraph);
}

async function init() {
  const app = document.getElementById('app');
  if (!app) return;
  const assetName = new URLSearchParams(window.location.search).get('name');
  if (!assetName) {
    app.innerHTML = '<p class="qc-empty">No asset specified. Use ?name=&lt;asset-name&gt;</p>';
    return;
  }

  await bootstrap((coord) => loadPage(coord, app, assetName), { requiredTables: [] });
}

init();

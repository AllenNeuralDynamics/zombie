/**
 * assets-table.js — Shared utility to render a grouped assets table.
 *
 * Used by both the Subject page and the Project page.
 */

import { buildQcLink, buildMetadataLink, buildCoLink, buildS3ConsoleUrl } from '../assets/links.js';
import { formatDatetime, PAGE_SIZE } from './utils.js';
import { arrowTableToRows, queryRows } from './arrow.js';
import { ensureTable } from './registry.js';

// Re-export for backward compatibility
export { arrowTableToRows, queryRows };

/**
 * Build a DOM table element grouping raw assets with their derived children.
 *
 * @param {object[]} assets        - Flat array of asset rows from asset_basics.
 * @param {object|null} sourceMap  - Map of asset name → array of source asset names.
 * @param {object} [opts]
 * @param {function(object):void} [opts.onRowClick] - Called with the asset row when a row is clicked.
 * @returns {HTMLElement} Wrapper div containing the table.
 */
export function buildAssetsTable(assets, sourceMap, { onRowClick } = {}) {
  // Build the ordered display list: each raw asset followed by its derived children
  const assetNames = new Set(assets.map((r) => r.name));
  const rawAssets = [];
  const derivedByRaw = {};

  for (const asset of assets) {
    const sources = sourceMap?.[asset.name];
    const knownSources = sources ? sources.filter((s) => assetNames.has(s)) : [];
    if (!sources || sources.length === 0 || knownSources.length === 0) {
      rawAssets.push(asset);
    } else {
      for (const src of knownSources) {
        if (!derivedByRaw[src]) derivedByRaw[src] = [];
        derivedByRaw[src].push(asset);
      }
    }
  }

  const assignedDerived = new Set(Object.values(derivedByRaw).flat().map((r) => r.name));
  const orphanDerived = assets.filter((r) => !rawAssets.includes(r) && !assignedDerived.has(r.name));

  // Flat ordered list preserving raw→derived grouping, used for pagination
  const orderedRows = [];
  for (const raw of rawAssets) {
    orderedRows.push({ asset: raw, isChild: false });
    for (const derived of (derivedByRaw[raw.name] ?? [])) {
      orderedRows.push({ asset: derived, isChild: true });
    }
  }
  for (const orphan of orphanDerived) {
    orderedRows.push({ asset: orphan, isChild: false });
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'subject-assets-table-wrapper';

  const table = document.createElement('table');
  table.className = 'subject-assets-table detail-table';
  table.innerHTML = `<thead><tr>
    <th>Name</th>
    <th>Subject</th>
    <th>Acquired (UTC)</th>
    <th>Modalities</th>
    <th>Level</th>
    <th>Links</th>
  </tr></thead>`;

  const tbody = document.createElement('tbody');
  table.appendChild(tbody);

  const pagingBar = document.createElement('div');
  pagingBar.className = 'assets-paging';

  wrapper.appendChild(table);
  wrapper.appendChild(pagingBar);

  let page = 0;
  const totalPages = () => Math.max(1, Math.ceil(orderedRows.length / PAGE_SIZE));

  function renderPage() {
    const start = page * PAGE_SIZE;
    const pageSlice = orderedRows.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = '';
    for (const { asset, isChild } of pageSlice) {
      const tr = document.createElement('tr');
      tr.dataset.assetName = asset.name ?? '';
      if (isChild) tr.classList.add('asset-derived-row');

      const qcHref = buildQcLink(asset.name);
      const metaHref = buildMetadataLink(asset.name);
      const coHref = buildCoLink(asset.code_ocean);
      const s3Href = buildS3ConsoleUrl(asset.location);
      const linkParts = [
        s3Href ? `<a href="${s3Href}" target="_blank" rel="noopener noreferrer">S3</a>` : '',
        coHref ? `<a href="${coHref}" target="_blank" rel="noopener noreferrer">CO</a>` : '',
        metaHref ? `<a href="${metaHref}" target="_blank" rel="noopener noreferrer">Meta</a>` : '',
        qcHref ? `<a href="${qcHref}" target="_blank" rel="noopener noreferrer">QC</a>` : '',
      ].filter(Boolean).join(' ');

      const subjectCell = asset.subject_id
        ? `<a href="/view?subject_id=${encodeURIComponent(asset.subject_id)}">${asset.subject_id}</a>`
        : '';

      tr.innerHTML = `
        <td class="${isChild ? 'asset-name-child' : ''}">${isChild ? '↳ ' : ''}${asset.name ?? ''}</td>
        <td>${subjectCell}</td>
        <td>${formatDatetime(asset.acquisition_start_time)}</td>
        <td>${Array.isArray(asset.modalities) ? asset.modalities.join(', ') : (asset.modalities ?? '')}</td>
        <td>${asset.data_level ?? ''}</td>
        <td class="link-cell">${linkParts}</td>`;

      if (onRowClick) {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => onRowClick(asset));
      }
      tbody.appendChild(tr);
    }

    const dispStart = orderedRows.length === 0 ? 0 : start + 1;
    const dispEnd = Math.min(start + PAGE_SIZE, orderedRows.length);
    const tp = totalPages();
    pagingBar.innerHTML = `
      <button class="page-btn" id="at-prev" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
      <span class="page-info">${dispStart}–${dispEnd} of ${orderedRows.length.toLocaleString()}</span>
      <button class="page-btn" id="at-next" ${page >= tp - 1 ? 'disabled' : ''}>Next ›</button>`;
    pagingBar.querySelector('#at-prev').addEventListener('click', () => { page--; renderPage(); });
    pagingBar.querySelector('#at-next').addEventListener('click', () => { page++; renderPage(); });
  }

  renderPage();

  // Expose a method to jump to a specific asset by name and highlight it
  wrapper.clearHighlights = () => {
    tbody.querySelectorAll('.asset-highlighted').forEach((r) => r.classList.remove('asset-highlighted'));
  };

  wrapper.goToAsset = (name) => {
    const idx = orderedRows.findIndex((r) => r.asset.name === name);
    if (idx === -1) return;
    wrapper.clearHighlights();
    const targetPage = Math.floor(idx / PAGE_SIZE);
    if (targetPage !== page) {
      page = targetPage;
      renderPage();
    }
    const row = tbody.querySelector(`tr[data-asset-name="${CSS.escape(name)}"]`);
    if (row) {
      row.classList.add('asset-highlighted');
    }
  };

  return wrapper;
}

/**
 * Fetch assets from DuckDB for a given WHERE clause and build the source map.
 *
 * @param {object} coordinator - Mosaic coordinator.
 * @param {string} whereClause - SQL WHERE clause (without the WHERE keyword).
 * @returns {Promise<{ assets: object[], sourceMap: object|null }>}
 */
export async function fetchAssetsWithSources(coordinator, whereClause) {
  // Lazy-register source_data on first use so pages that never call this
  // helper don't pay the download cost at startup.
  await ensureTable(coordinator, 'source_data');
  const result = await coordinator.query(
    `SELECT a.name, a.subject_id, a.acquisition_start_time::VARCHAR AS acquisition_start_time,
            a.project_name, a.modalities, a.data_level, a.code_ocean, a.location,
            a.acquisition_type, sd.source_data
     FROM asset_basics a
     LEFT JOIN source_data sd ON sd.name = a.name AND sd.source_data IS NOT NULL AND sd.source_data != ''
     WHERE ${whereClause}
     ORDER BY a.acquisition_start_time DESC NULLS LAST`,
  );
  const rows = arrowTableToRows(result);

  const assets = rows.map(({ source_data: _, ...rest }) => rest);
  const sourceMap = {};
  for (const row of rows) {
    if (row.source_data) {
      sourceMap[row.name] = String(row.source_data).split(', ').filter(Boolean);
    }
  }

  return { assets, sourceMap };
}

/**
 * subject-view.js — Subject viewer page (/subject?subject_id=X).
 *
 * Fetches all DocDB records for the given subject, renders:
 *   1. Subject info card (metadata: DOB, sex, genotype, etc.)
 *   2. SVG timeline of events (surgeries, acquisitions, birth, …)
 *   3. Detail panel that updates when the user clicks a timeline event.
 *
 * Public surface:
 *   createSubjectView(opts)  — DOM factory, returns HTMLElement.
 *   generateInfoHtml(subject) — Pure HTML-string builder (exported for testing).
 *   organizeSubjectData(records, subjectId) — Record organiser (exported for testing).
 */

import { buildQcLink, buildMetadataLink, buildCoLink, buildS3ConsoleUrl, formatDatetime } from '../assets/view.js';
import { queryDocDb } from '../lib/docdb.js';
import { fetchAllSubjectIds } from '../lib/metadata.js';
import { buildTimelineEvents } from './parsers.js';
import { createSubjectTimeline } from './timeline.js';
import { renderEventDetail } from './details.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Build an HTML info card string from a subject object.
 *
 * @param {object} subject - The `subject` field of a DocDB record.
 * @returns {string} HTML string.
 */
export function generateInfoHtml(subject, projects = []) {
  if (!subject) return '<p class="detail-placeholder">No subject data.</p>';

  const id = subject.subject_id ?? 'Unknown';
  const details = subject.subject_details ?? {};

  const dob = details.date_of_birth ?? 'Unknown';
  const sex = details.sex ?? 'Unknown';
  const genotype = details.genotype ?? 'Unknown';
  const species = details.species?.name ?? 'Unknown';
  const strain = details.strain?.name ?? 'Unknown';
  const housing = details.housing ?? {};
  const cageId = housing.cage_id ?? 'Unknown';
  const roomId = housing.room_id ?? 'Unknown';

  return `
    <div class="subject-info-card">
      <h3>Subject ${id}</h3>
      <dl>
        <dt>Born</dt>       <dd>${dob}</dd>
        <dt>Sex</dt>        <dd>${sex}</dd>
        <dt>Species</dt>    <dd>${species}</dd>
        <dt>Strain</dt>     <dd>${strain}</dd>
        <dt>Genotype</dt>   <dd>${genotype}</dd>
        <dt>Housing</dt>    <dd>Cage ${cageId}, Room ${roomId}</dd>
        ${projects.length ? `<dt>Projects</dt><dd>${projects.join(', ')}</dd>` : ''}
      </dl>
    </div>`;
}

/**
 * Organise a flat list of DocDB records into the subject-data bundle expected
 * by the parser / timeline functions.
 *
 * Each DocDB record may contribute:
 *   - subject data (if record.subject.subject_id matches)
 *   - procedures (subject_procedures, specimen_procedures)
 *   - acquisition events
 *
 * @param {Array<object>} records
 * @param {string} subjectId
 * @returns {{
 *   subject: object,
 *   procedures: { subject_procedures: object[], specimen_procedures: object[] },
 *   acquisitions: object[],
 * }}
 */
export function organizeSubjectData(records, subjectId) {
  const bundle = {
    subject: {},
    procedures: { subject_procedures: [], specimen_procedures: [] },
    acquisitions: [],
  };

  const subjectProcKeys = new Set();
  const specimenProcKeys = new Set();

  for (const rec of records) {
    // Subject details — prefer the record whose subject_id matches
    if (rec.subject?.subject_id === subjectId && !bundle.subject.subject_id) {
      bundle.subject = rec.subject;
    }

    // Procedures — deduplicate across records by type + dates
    if (rec.procedures) {
      for (const proc of (rec.procedures.subject_procedures ?? [])) {
        const key = `${proc.object_type ?? ''}|${proc.start_date ?? ''}`;
        if (!subjectProcKeys.has(key)) {
          subjectProcKeys.add(key);
          bundle.procedures.subject_procedures.push(proc);
        }
      }
      for (const proc of (rec.procedures.specimen_procedures ?? [])) {
        const key = `${proc.procedure_type ?? proc.object_type ?? ''}|${proc.specimen_id ?? ''}|${proc.start_date ?? ''}|${proc.end_date ?? ''}`;
        if (!specimenProcKeys.has(key)) {
          specimenProcKeys.add(key);
          bundle.procedures.specimen_procedures.push(proc);
        }
      }
    }

    // Acquisitions — store asset name alongside acquisition data
    if (rec.acquisition?.acquisition_start_time) {
      bundle.acquisitions.push({ ...rec.acquisition, _assetName: rec.name ?? '' });
    }
  }

  return bundle;
}

// ---------------------------------------------------------------------------
// Main view factory
// ---------------------------------------------------------------------------

/**
 * Create the subject-viewer page element.
 *
 * @param {object} [opts]
 * @param {string} [opts.subjectId]    - Subject ID; falls back to ?subject_id= URL param.
 * @param {object} [opts.coordinator]  - Mosaic coordinator for querying asset_basics subject list.
 * @returns {HTMLElement}
 */
export function createSubjectView(opts = {}) {
  const { coordinator } = opts;
  const initialId =
    opts.subjectId ??
    new URLSearchParams(window.location.search).get('subject_id') ??
    '';

  const root = document.createElement('div');
  root.className = 'subject-view';

  // ── Header + selector ─────────────────────────────────────────────────────
  const headerEl = document.createElement('div');
  headerEl.className = 'view-header';
  headerEl.innerHTML = '<h2>Subject Viewer</h2>';

  const selectorEl = document.createElement('div');
  selectorEl.className = 'subject-selector';
  selectorEl.innerHTML = `
    <label for="subject-id-input">Subject ID</label>
    <input id="subject-id-input" list="subject-id-list"
           placeholder="Type or select a subject ID…"
           autocomplete="off" spellcheck="false"
           aria-label="Subject ID" />
    <datalist id="subject-id-list"></datalist>`;
  headerEl.appendChild(selectorEl);
  root.appendChild(headerEl);

  // ── Content area (replaced on each selection) ─────────────────────────────
  const contentEl = document.createElement('div');
  contentEl.className = 'subject-content';
  root.appendChild(contentEl);

  // ── Populate datalist ─────────────────────────────────────────────────────
  const input = selectorEl.querySelector('input');
  const datalist = selectorEl.querySelector('datalist');

  if (coordinator) {
    fetchAllSubjectIds(coordinator).then((ids) => {
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        datalist.appendChild(opt);
      }
    });
  }

  // Pre-set the value synchronously for the initial render (before async load)
  if (initialId) input.value = initialId;

  // ── Sync input → URL → content ────────────────────────────────────────────
  let loadAbortController = null;

  function handleSubjectChange() {
    const newId = input.value.trim();
    console.debug('[SubjectView] input changed → newId:', newId, 'prev aborted:', loadAbortController?.signal?.aborted);
    const params = new URLSearchParams(window.location.search);
    if (newId) {
      params.set('subject_id', newId);
    } else {
      params.delete('subject_id');
    }
    try {
      const url = new URL(window.location.href);
      url.search = params.toString();
      history.pushState({}, '', url);
    } catch {
      // pushState can throw in restricted contexts (e.g. Firefox strict mode).
    }
    if (loadAbortController) loadAbortController.abort();
    loadAbortController = new AbortController();
    _loadSubject(contentEl, newId, coordinator, loadAbortController.signal);
  }

  input.addEventListener('change', handleSubjectChange);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });

  // ── Initial load ──────────────────────────────────────────────────────────
  loadAbortController = new AbortController();
  _loadSubject(contentEl, initialId, coordinator, loadAbortController.signal);

  return root;
}

async function _loadSubject(contentEl, subjectId, coordinator, signal) {
  console.debug('[SubjectView] _loadSubject start:', subjectId, 'aborted:', signal?.aborted);
  // Clear previous content and show loading indicator
  contentEl.innerHTML = '';

  if (!subjectId) {
    contentEl.innerHTML = `
      <div class="error-banner">
        No subject ID selected. Pick one from the dropdown or use <code>?subject_id=&lt;id&gt;</code> in the URL.
      </div>`;
    return;
  }

  const loadingEl = document.createElement('div');
  loadingEl.className = 'subject-loading';
  loadingEl.textContent = 'Loading subject data…';
  contentEl.appendChild(loadingEl);

  try {
    // Query DocDB for all records matching this subject
    const records = await queryDocDb({ 'subject.subject_id': subjectId }, { signal });
    console.debug('[SubjectView] queryDocDb returned', records.length, 'records for', subjectId, 'aborted:', signal?.aborted);

    if (!records.length) {
      loadingEl.replaceWith(_errorEl(`No records found for subject ID "${subjectId}".`));
      return;
    }

    // Organise into a bundle
    const bundle = organizeSubjectData(records, subjectId);

    // Build timeline events
    const events = buildTimelineEvents(bundle);

    // Render
    const infoEl = document.createElement('div');
    infoEl.innerHTML = generateInfoHtml(bundle.subject);

    const timelineSection = document.createElement('div');
    timelineSection.className = 'subject-timeline-section';
    timelineSection.innerHTML = '<h3>Timeline</h3>';

    const detailSection = document.createElement('div');
    detailSection.className = 'subject-detail-section';
    detailSection.innerHTML = '<h3>Event Details</h3>';

    const detailContainer = document.createElement('div');
    detailContainer.className = 'subject-detail-container';
    detailSection.appendChild(detailContainer);

    const assetsSection = document.createElement('div');
    assetsSection.className = 'subject-assets-section';
    assetsSection.innerHTML = '<h3>Assets</h3><p class="subject-loading">Loading assets…</p>';

    // Render the initial placeholder
    renderEventDetail(null, detailContainer);

    let assetsTableEl = null;

    const timelineSvg = createSubjectTimeline(events, {
      onSelect: (ev) => {
        renderEventDetail(ev, detailContainer, { subjectId });
        if (assetsTableEl) {
          const targetName = ev?.type === 'Acquisition' ? (ev.data?._assetName ?? '') : '';
          assetsTableEl.querySelectorAll('tr[data-asset-name]').forEach((r) => {
            const isTarget = targetName && r.dataset.assetName === targetName;
            r.classList.toggle('asset-highlighted', isTarget);
            if (isTarget) r.scrollIntoView({ block: 'nearest' });
          });
        }
      },
    });

    timelineSection.appendChild(timelineSvg);

    // Replace loading message
    loadingEl.replaceWith(infoEl);
    contentEl.appendChild(timelineSection);
    contentEl.appendChild(detailSection);
    contentEl.appendChild(assetsSection);

    // Async: fetch DuckDB asset data (projects + grouped assets table)
    if (coordinator) {
      _fetchAndRenderAssets(coordinator, subjectId, infoEl, assetsSection, bundle.subject).then((tableEl) => {
        assetsTableEl = tableEl;
      }).catch((err) => {
        console.error('[SubjectView] Asset fetch failed:', err);
        assetsSection.innerHTML = `<h3>Assets</h3><p class="error-banner">Failed to load assets: ${err.message}</p>`;
      });
    } else {
      assetsSection.innerHTML = '<h3>Assets</h3><p class="detail-placeholder">No data connection available.</p>';
    }

  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      console.debug('[SubjectView] load aborted for', subjectId);
      return;
    }
    console.error('[SubjectView] Failed to load subject data:', err);
    loadingEl.replaceWith(_errorEl(`Failed to load data: ${err.message}`));
  }
}

function _arrowTableToRows(result) {
  const rows = [];
  const fields = result.schema.fields.map((f) => f.name);
  for (let i = 0; i < result.numRows; i++) {
    const row = {};
    for (const f of fields) {
      const col = result.getChild(f);
      row[f] = col ? col.get(i) : null;
    }
    rows.push(row);
  }
  return rows;
}

async function _fetchAndRenderAssets(coordinator, subjectId, infoEl, assetsSection, subject) {
  const safeId = subjectId.replace(/'/g, "''");
  let assets = [];
  let sourceMap = null;

  try {
    const result = await coordinator.query(
      `SELECT name, acquisition_start_time::VARCHAR AS acquisition_start_time, project_name, modalities, data_level, code_ocean, location
       FROM asset_basics
       WHERE subject_id = '${safeId}'
       ORDER BY acquisition_start_time`,
    );
    assets = _arrowTableToRows(result);
  } catch (err) {
    assetsSection.innerHTML = `<h3>Assets</h3><p class="error-banner">Failed to load assets: ${err.message}</p>`;
    return null;
  }

  // Update subject info card with project names
  const projects = [...new Set(assets.map((r) => r.project_name).filter(Boolean))].sort();
  infoEl.innerHTML = generateInfoHtml(subject, projects);

  // Try to get source_data grouping
  if (assets.length) {
    const quotedNames = assets.map((r) => `'${String(r.name ?? '').replace(/'/g, "''")}'`).join(', ');
    try {
      const sdResult = await coordinator.query(
        `SELECT name, source_data
         FROM source_data
         WHERE name IN (${quotedNames}) AND source_data IS NOT NULL AND source_data != ''`,
      );
      sourceMap = {};
      const sdRows = _arrowTableToRows(sdResult);
      for (const row of sdRows) {
        sourceMap[row.name] = String(row.source_data).split(', ').filter(Boolean);
      }
    } catch {
      sourceMap = null;
    }
  }

  assetsSection.innerHTML = '<h3>Assets</h3>';
  const tableEl = _buildAssetsTable(assets, sourceMap);
  assetsSection.appendChild(tableEl);
  return tableEl;
}

function _buildAssetsTable(assets, sourceMap) {
  const assetNames = new Set(assets.map((r) => r.name));

  // Determine raw vs derived
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

  // Assets not assigned to any raw group (derived from out-of-subject assets)
  const assignedDerived = new Set(Object.values(derivedByRaw).flat().map((r) => r.name));
  const orphanDerived = assets.filter(
    (r) => !assetNames.has(r.name) || (!rawAssets.includes(r) && !assignedDerived.has(r.name)),
  );

  const wrapper = document.createElement('div');
  wrapper.className = 'subject-assets-table-wrapper';

  const table = document.createElement('table');
  table.className = 'subject-assets-table detail-table';

  table.innerHTML = `<thead><tr>
    <th>Name</th>
    <th>Acquired (UTC)</th>
    <th>Project</th>
    <th>Modalities</th>
    <th>Level</th>
    <th>Links</th>
  </tr></thead>`;

  const tbody = document.createElement('tbody');

  function _assetRow(asset, isChild) {
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

    tr.innerHTML = `
      <td class="${isChild ? 'asset-name-child' : ''}">${isChild ? '↳ ' : ''}${asset.name ?? ''}</td>
      <td>${formatDatetime(asset.acquisition_start_time)}</td>
      <td>${asset.project_name ?? ''}</td>
      <td>${asset.modalities ?? ''}</td>
      <td>${asset.data_level ?? ''}</td>
      <td class="link-cell">${linkParts}</td>`;
    return tr;
  }

  for (const raw of rawAssets) {
    tbody.appendChild(_assetRow(raw, false));
    for (const derived of (derivedByRaw[raw.name] ?? [])) {
      tbody.appendChild(_assetRow(derived, true));
    }
  }

  for (const orphan of orphanDerived) {
    tbody.appendChild(_assetRow(orphan, false));
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  return wrapper;
}

function _errorEl(msg) {
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.textContent = msg;
  return el;
}

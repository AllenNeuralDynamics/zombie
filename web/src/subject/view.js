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

import { buildAssetsTable, fetchAssetsWithSources } from '../lib/assets-table.js';
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
        ${projects.length ? `<dt>Projects</dt><dd>${projects.map((p) => `<a href="/view?project=${encodeURIComponent(p)}">${p}</a>`).join(', ')}</dd>` : ''}
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
    procedures: { subject_procedures: [], specimen_procedures: [], coordinate_system: null },
    acquisitions: [],
    instruments: new Map(), // instrument_id → instrument data
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
      if (!bundle.procedures.coordinate_system && rec.procedures.coordinate_system) {
        bundle.procedures.coordinate_system = rec.procedures.coordinate_system;
      }
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

    // Instrument — index by instrument_id
    if (rec.instrument?.instrument_id && !bundle.instruments.has(rec.instrument.instrument_id)) {
      bundle.instruments.set(rec.instrument.instrument_id, rec.instrument);
    }

    // Acquisitions — store asset name alongside acquisition data.
    // Derived assets are excluded: they duplicate the source raw acquisition on
    // the timeline and cause overlapping bubbles.
    if (
      rec.acquisition?.acquisition_start_time &&
      rec.data_description?.data_level !== 'derived'
    ) {
      bundle.acquisitions.push({ ...rec.acquisition, _assetName: rec.name ?? '', _modalities: rec.data_description?.modalities ?? [] });
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
  const { coordinator, embedded = false, onSubjectLoaded = null } = opts;
  const initialId =
    opts.subjectId ??
    new URLSearchParams(window.location.search).get('subject_id') ??
    '';

  const root = document.createElement('div');
  root.className = 'subject-view';

  // ── Header + selector ─────────────────────────────────────────────────────
  const headerEl = document.createElement('div');
  headerEl.className = 'view-header';
  if (!embedded) headerEl.innerHTML = '<h2>Subject Viewer</h2>';

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
    if (!embedded) {
      // The combined view owns the URL when embedded.
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
    }
    if (loadAbortController) loadAbortController.abort();
    loadAbortController = new AbortController();
    _loadSubject(contentEl, newId, coordinator, loadAbortController.signal, { onSubjectLoaded });
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
  _loadSubject(contentEl, initialId, coordinator, loadAbortController.signal, { onSubjectLoaded });

  // Imperative API for the combined view: load a subject programmatically,
  // optionally pre-selecting a specific acquisition on the timeline.
  root.loadSubject = (id, { acquisitionName = null } = {}) => {
    if (id && id === input.value.trim()) {
      // Same subject already loaded — just jump to the acquisition if given.
      if (acquisitionName) root._pendingAcquisition = acquisitionName;
      root._selectAcquisition?.(acquisitionName);
      return;
    }
    input.value = id ?? '';
    root._pendingAcquisition = acquisitionName;
    if (loadAbortController) loadAbortController.abort();
    loadAbortController = new AbortController();
    _loadSubject(contentEl, id ?? '', coordinator, loadAbortController.signal, { onSubjectLoaded, root });
  };

  return root;
}

async function _loadSubject(contentEl, subjectId, coordinator, signal, { onSubjectLoaded = null, root = null } = {}) {
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

    let bundle;
    let hasProceduresFallback = false;

    if (!records.length) {
      loadingEl.className = 'loading-message';
      loadingEl.textContent = 'No DocDB records found. Trying procedures service\u2026';
      let procData = null;
      let subjectData = null;
      try {
        [procData, subjectData] = await Promise.all([
          _fetchMetadataServiceFallback(`procedures/${encodeURIComponent(subjectId)}`, signal),
          _fetchMetadataServiceFallback(`subject/${encodeURIComponent(subjectId)}`, signal),
        ]);
      } catch (err) {
        if (err?.name === 'AbortError' || signal?.aborted) {
          console.debug('[SubjectView] fallback aborted for', subjectId);
          return;
        }
        console.warn('[SubjectView] Procedures fallback failed:', err);
      }
      if (signal?.aborted) return;
      if (!procData || (!procData.subject_procedures?.length && !procData.specimen_procedures?.length)) {
        loadingEl.replaceWith(_errorEl(`No records found for subject ID "${subjectId}".`));
        return;
      }
      bundle = {
        subject: subjectData ?? { subject_id: subjectId },
        procedures: {
          subject_procedures: procData.subject_procedures ?? [],
          specimen_procedures: procData.specimen_procedures ?? [],
          coordinate_system: null,
        },
        acquisitions: [],
        instruments: new Map(),
      };
      hasProceduresFallback = true;
    } else {
      bundle = organizeSubjectData(records, subjectId);
    }

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
    assetsSection.innerHTML = hasProceduresFallback
      ? '<h3>Assets</h3><p class="detail-placeholder">Asset data unavailable (procedures-only fallback).</p>'
      : '<h3>Assets</h3><p class="subject-loading">Loading assets\u2026</p>';

    // Render the initial placeholder
    renderEventDetail(null, detailContainer);

    let assetsTableEl = null;

    const timelineSvg = createSubjectTimeline(events, {
      onSelect: (ev) => {
        renderEventDetail(ev, detailContainer, { subjectId, proceduresCoordSys: bundle.procedures.coordinate_system, coordinator, instruments: bundle.instruments });
        if (assetsTableEl && ev?.type === 'Acquisition') {
          const targetName = ev.data?._assetName ?? '';
          if (targetName) assetsTableEl.goToAsset?.(targetName);
        }
      },
    });

    timelineSection.appendChild(timelineSvg);

    // Expose acquisition selection to the combined view and honour any
    // acquisition requested before this load completed (e.g. project dot click).
    if (root) {
      root._selectAcquisition = (name) => timelineSvg.selectAcquisition?.(name);
      if (root._pendingAcquisition) {
        const target = root._pendingAcquisition;
        root._pendingAcquisition = null;
        // Defer until the bubble strip has laid out.
        requestAnimationFrame(() => timelineSvg.selectAcquisition?.(target));
      }
    }

    // Replace loading message
    loadingEl.replaceWith(infoEl);
    contentEl.appendChild(timelineSection);
    contentEl.appendChild(detailSection);
    contentEl.appendChild(assetsSection);

    // Async: fetch DuckDB asset data (projects + grouped assets table)
    if (!hasProceduresFallback && coordinator) {
      _fetchAndRenderAssets(coordinator, subjectId, infoEl, assetsSection, bundle.subject).then((result) => {
        if (!result) return;
        const { tableEl, assets } = result;
        assetsTableEl = tableEl;
        // Report the most-recent asset's project to the combined view so it can
        // populate the project section when the subject was opened first.
        if (onSubjectLoaded) {
          const mostRecentProject = assets.find((a) => a.project_name)?.project_name ?? null;
          onSubjectLoaded({ subjectId, mostRecentProject });
        }
        // Enrich acquisition event data with S3 location and Code Ocean from DuckDB
        if (assets?.length) {
          const assetByName = new Map(assets.map((a) => [a.name, a]));
          for (const ev of events) {
            if (ev.type === 'Acquisition' && ev.data?._assetName) {
              const asset = assetByName.get(ev.data._assetName);
              if (asset) {
                ev.data._codeOcean = asset.code_ocean ?? null;
                ev.data._location = asset.location ?? null;
                ev.data._project_name = asset.project_name ?? null;
              }
            }
          }
        }
      }).catch((err) => {
        console.error('[SubjectView] Asset fetch failed:', err);
        assetsSection.innerHTML = `<h3>Assets</h3><p class="error-banner">Failed to load assets: ${err.message}</p>`;
      });
    } else if (!hasProceduresFallback) {
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

async function _fetchAndRenderAssets(coordinator, subjectId, infoEl, assetsSection, subject) {
  const safeId = subjectId.replace(/'/g, "''");
  let assets = [];
  let sourceMap = null;

  try {
    ({ assets, sourceMap } = await fetchAssetsWithSources(coordinator, `subject_id = '${safeId}'`));
  } catch (err) {
    assetsSection.innerHTML = `<h3>Assets</h3><p class="error-banner">Failed to load assets: ${err.message}</p>`;
    return null;
  }

  // Update subject info card with project names
  const projects = [...new Set(assets.map((r) => r.project_name).filter(Boolean))].sort();
  infoEl.innerHTML = generateInfoHtml(subject, projects);

  assetsSection.innerHTML = '<h3>Assets</h3>';
  const tableEl = buildAssetsTable(assets, sourceMap);
  assetsSection.appendChild(tableEl);
  return { tableEl, assets };
}

async function _fetchMetadataServiceFallback(path, signal) {
  const url = `https://aind-metadata-service/api/v2/${path}`;
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), 180_000);
  if (signal) {
    signal.addEventListener('abort', () => timeoutController.abort(), { once: true });
  }
  try {
    const resp = await fetch(url, { signal: timeoutController.signal });
    clearTimeout(timeoutId);
    return await resp.json();
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

function _errorEl(msg) {
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.textContent = msg;
  return el;
}

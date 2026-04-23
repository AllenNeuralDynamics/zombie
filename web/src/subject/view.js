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
export function generateInfoHtml(subject) {
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

  // Calculate approximate age
  let ageStr = 'Unknown';
  if (dob !== 'Unknown') {
    try {
      const birthMs = new Date(dob).getTime();
      if (!isNaN(birthMs)) {
        const days = Math.floor((Date.now() - birthMs) / 86_400_000);
        ageStr = `${days} days (${Math.floor(days / 7)} weeks)`;
      }
    } catch {
      // leave as Unknown
    }
  }

  return `
    <div class="subject-info-card">
      <h3>Subject ${id}</h3>
      <dl>
        <dt>Born</dt>       <dd>${dob} (${ageStr})</dd>
        <dt>Sex</dt>        <dd>${sex}</dd>
        <dt>Species</dt>    <dd>${species}</dd>
        <dt>Strain</dt>     <dd>${strain}</dd>
        <dt>Genotype</dt>   <dd>${genotype}</dd>
        <dt>Housing</dt>    <dd>Cage ${cageId}, Room ${roomId}</dd>
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

  for (const rec of records) {
    // Subject details — prefer the record whose subject_id matches
    if (rec.subject?.subject_id === subjectId && !bundle.subject.subject_id) {
      bundle.subject = rec.subject;
    }

    // Procedures
    if (rec.procedures) {
      const sp = rec.procedures.subject_procedures ?? [];
      const spc = rec.procedures.specimen_procedures ?? [];
      bundle.procedures.subject_procedures.push(...sp);
      bundle.procedures.specimen_procedures.push(...spc);
    }

    // Acquisitions
    if (rec.acquisition?.acquisition_start_time) {
      bundle.acquisitions.push(rec.acquisition);
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
    <label for="subject-id-select">Subject ID</label>
    <select id="subject-id-select" aria-label="Select subject ID">
      <option value="">— select a subject —</option>
    </select>`;
  headerEl.appendChild(selectorEl);
  root.appendChild(headerEl);

  // ── Content area (replaced on each selection) ─────────────────────────────
  const contentEl = document.createElement('div');
  contentEl.className = 'subject-content';
  root.appendChild(contentEl);

  // ── Populate dropdown ─────────────────────────────────────────────────────
  const select = selectorEl.querySelector('select');

  if (coordinator) {
    fetchAllSubjectIds(coordinator).then((ids) => {
      for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        if (id === initialId) opt.selected = true;
        select.appendChild(opt);
      }
      // If initialId wasn't found in the list, still show it as selected
      if (initialId && !ids.includes(initialId)) {
        const opt = document.createElement('option');
        opt.value = initialId;
        opt.textContent = initialId;
        opt.selected = true;
        select.insertBefore(opt, select.options[1]);
      }
    });
  } else if (initialId) {
    // No coordinator — pre-populate with the current ID only so the dropdown
    // shows something sensible even without the full list.
    const opt = document.createElement('option');
    opt.value = initialId;
    opt.textContent = initialId;
    opt.selected = true;
    select.appendChild(opt);
  }

  // Pre-set the value synchronously for the initial render (before async load)
  if (initialId) select.value = initialId;

  // ── Sync dropdown → URL → content ─────────────────────────────────────────
  select.addEventListener('change', () => {
    const newId = select.value;
    const params = new URLSearchParams(window.location.search);
    if (newId) {
      params.set('subject_id', newId);
    } else {
      params.delete('subject_id');
    }
    history.pushState(null, '', `${window.location.pathname}?${params.toString()}`);
    _loadSubject(contentEl, newId);
  });

  // ── Initial load ──────────────────────────────────────────────────────────
  _loadSubject(contentEl, initialId);

  return root;
}

async function _loadSubject(contentEl, subjectId) {
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
    const records = await queryDocDb({ 'subject.subject_id': subjectId });

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

    // Render the initial placeholder
    renderEventDetail(null, detailContainer);

    const timelineSvg = createSubjectTimeline(events, {
      width: 900,
      height: 90,
      onSelect: (ev) => {
        renderEventDetail(ev, detailContainer, { subjectId });
        // Highlight selected rect
        contentEl.querySelectorAll('.timeline-event rect').forEach((r) => {
          r.setAttribute('opacity', '0.45');
        });
      },
    });

    timelineSection.appendChild(timelineSvg);

    // Replace loading message
    loadingEl.replaceWith(infoEl);
    contentEl.appendChild(timelineSection);
    contentEl.appendChild(detailSection);

  } catch (err) {
    console.error('[SubjectView] Failed to load subject data:', err);
    loadingEl.replaceWith(_errorEl(`Failed to load data: ${err.message}`));
  }
}

function _errorEl(msg) {
  const el = document.createElement('div');
  el.className = 'error-banner';
  el.textContent = msg;
  return el;
}

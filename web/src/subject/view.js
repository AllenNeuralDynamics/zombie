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
 * @param {string} [opts.subjectId] - Subject ID; falls back to ?subject_id= URL param.
 * @returns {HTMLElement}
 */
export function createSubjectView(opts = {}) {
  const subjectId =
    opts.subjectId ??
    new URLSearchParams(window.location.search).get('subject_id') ??
    '';

  const root = document.createElement('div');
  root.className = 'subject-view';

  // Header
  root.innerHTML = `
    <div class="view-header">
      <h2>Subject Viewer</h2>
      ${subjectId ? `<span class="view-subtitle">Subject ID: <strong>${subjectId}</strong></span>` : ''}
    </div>
    <div class="subject-loading">Loading subject data…</div>`;

  if (!subjectId) {
    root.innerHTML += `
      <div class="error-banner">
        No subject ID specified. Use <code>?subject_id=&lt;id&gt;</code> in the URL.
      </div>`;
    root.querySelector('.subject-loading').remove();
    return root;
  }

  // Async load
  _loadSubject(root, subjectId);
  return root;
}

async function _loadSubject(root, subjectId) {
  const loadingEl = root.querySelector('.subject-loading');

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
        root.querySelectorAll('.timeline-event rect').forEach((r) => {
          r.setAttribute('opacity', '0.45');
        });
        // The clicked g element is the parent of the rect — find it by iteration
        // (we don't have a reference here, so just reset all then let the next click re-highlight)
      },
    });

    timelineSection.appendChild(timelineSvg);

    // Replace loading message
    loadingEl.replaceWith(infoEl);
    root.appendChild(timelineSection);
    root.appendChild(detailSection);

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

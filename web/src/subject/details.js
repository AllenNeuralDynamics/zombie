/**
 * subject-details.js — Event detail renderers for the subject timeline.
 *
 * `renderEventDetail(event, container, context)` clears `container` and
 * populates it with the appropriate HTML / Canvas for the selected event.
 *
 * Pure helpers (`buildBirthDetail`, `buildAcquisitionDetail`, etc.) return
 * HTML strings and are exported for unit testing in a Node environment.
 */

import {
  hasBrainInjections,
  hasFiberImplants,
  extractInjectionsFromSurgery,
  extractFibersFromSurgery,
} from './parsers.js';
import { createBrainVizCanvas } from './brain-viz.js';
import { createBrainViz3D } from './brain-viz-3d.js';
import { createEphysViz3D, extractEphysProbes } from './ephys-viz-3d.js';
import { buildQcLink, buildMetadataLink, buildCoLink, buildS3ConsoleUrl } from '../assets/view.js';

// ---------------------------------------------------------------------------
// Pure HTML-string builders (Node-testable)
// ---------------------------------------------------------------------------

function fmtDate(date) {
  if (!date) return 'Unknown';
  return date instanceof Date
    ? date.toISOString().slice(0, 10)
    : String(date);
}

function fmtDateTime(date) {
  if (!date) return 'Unknown';
  return date instanceof Date
    ? date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
    : String(date);
}

/**
 * Build an HTML string for a Birth event detail card.
 *
 * @param {object} event
 * @returns {string}
 */
export function buildBirthDetail(event) {
  return `
    <div class="detail-card">
      <h4>Birth</h4>
      <dl>
        <dt>Date</dt><dd>${fmtDate(event.start)}</dd>
        <dt>Details</dt><dd>${event.details ?? ''}</dd>
      </dl>
    </div>`;
}

/**
 * Check whether an acquisition data object contains at least one Ephys assembly config.
 * @param {object} acquisitionData
 * @returns {boolean}
 */
export function hasEphysAssemblies(acquisitionData) {
  for (const stream of (acquisitionData?.data_streams ?? [])) {
    for (const cfg of (stream?.configurations ?? [])) {
      if (cfg?.object_type === 'Ephys assembly config') return true;
    }
  }
  return false;
}

/**
 * Build an HTML string for the overview card of an Acquisition event.
 *
 * @param {object} event
 * @returns {string}
 */
export function buildAcquisitionDetail(event) {
  const { start, end, event: label, modalities, data = {} } = event;
  const durationHrs = start && end ? ((end - start) / 3_600_000).toFixed(2) : 'N/A';
  const assetName = data._assetName ?? null;
  const qcHref = buildQcLink(assetName);
  const metaHref = buildMetadataLink(assetName);
  const coHref = buildCoLink(data._codeOcean ?? null);
  const s3Href = buildS3ConsoleUrl(data._location ?? null);
  const linkParts = [
    s3Href ? `<a href="${s3Href}" target="_blank" rel="noopener noreferrer">S3</a>` : '',
    coHref ? `<a href="${coHref}" target="_blank" rel="noopener noreferrer">Code Ocean</a>` : '',
    metaHref ? `<a href="${metaHref}" target="_blank" rel="noopener noreferrer">Metadata</a>` : '',
    qcHref ? `<a href="${qcHref}" target="_blank" rel="noopener noreferrer">QC Portal</a>` : '',
  ].filter(Boolean).join(' · ');
  const extra = [
    data.acquisition_type ? `<dt>Acquisition type</dt><dd>${data.acquisition_type}</dd>` : '',
    data.session_type ? `<dt>Session type</dt><dd>${data.session_type}</dd>` : '',
    data.protocol_name ? `<dt>Protocol</dt><dd>${data.protocol_name}</dd>` : '',
    data.experimenter_full_name
      ? `<dt>Experimenter</dt><dd>${[].concat(data.experimenter_full_name).join(', ')}</dd>`
      : '',
    data.reward_consumed_total != null
      ? `<dt>Reward consumed</dt><dd>${data.reward_consumed_total} ${data.reward_consumed_unit ?? ''}</dd>`
      : '',
    modalities?.length ? `<dt>Modalities</dt><dd>${modalities.join(', ')}</dd>` : '',
    linkParts ? `<dt>Links</dt><dd>${linkParts}</dd>` : '',
  ].join('');
  return `
    <div class="detail-card">
      <h4>${label}</h4>
      <dl>
        <dt>Start</dt><dd>${fmtDateTime(start)}</dd>
        <dt>End</dt><dd>${fmtDateTime(end)}</dd>
        <dt>Duration</dt><dd>${durationHrs} hours</dd>
        ${extra}
      </dl>
    </div>`;
}

/**
 * Build an HTML string for a Session event detail card.
 *
 * @param {object} event
 * @returns {string}
 */
export function buildSessionDetail(event) {
  return `
    <div class="detail-card">
      <h4>${event.event ?? 'Session'}</h4>
      <dl>
        <dt>Date</dt><dd>${fmtDateTime(event.start)}</dd>
        <dt>Details</dt><dd>${event.details ?? ''}</dd>
      </dl>
    </div>`;
}

/**
 * Build an HTML string for a generic sub-procedure card.
 *
 * @param {object} event
 * @returns {string}
 */
export function buildSubProcedureDetail(event) {
  return `
    <div class="detail-card">
      <h4>${event.event ?? 'Procedure'}</h4>
      <dl>
        <dt>Type</dt><dd>${event.type ?? 'Unknown'}</dd>
        <dt>Date</dt><dd>${fmtDate(event.start)}</dd>
        <dt>Details</dt><dd>${event.details ?? ''}</dd>
      </dl>
    </div>`;
}

/**
 * Build an HTML string for a specimen-procedure card.
 *
 * @param {object} event
 * @returns {string}
 */
export function buildSpecimenProcedureDetail(event) {
  const durationDays = event.start && event.end
    ? Math.round((event.end - event.start) / 86_400_000)
    : 'N/A';
  const notes = event.data?.notes ?? '';
  return `
    <div class="detail-card">
      <h4>${event.event ?? 'Specimen Procedure'}</h4>
      <dl>
        <dt>Type</dt><dd>${event.type ?? 'Unknown'}</dd>
        <dt>Start</dt><dd>${fmtDate(event.start)}</dd>
        <dt>End</dt><dd>${fmtDate(event.end)}</dd>
        <dt>Duration</dt><dd>${durationDays} days</dd>
        <dt>Details</dt><dd>${event.details ?? ''}</dd>
        ${notes ? `<dt>Notes</dt><dd>${notes}</dd>` : ''}
      </dl>
    </div>`;
}

// ---------------------------------------------------------------------------
// Tab widget (lightweight, CSS-only tabs via JS show/hide)
// ---------------------------------------------------------------------------

/**
 * Create a simple tab widget element.
 *
 * @param {Array<{label: string, content: HTMLElement|string}>} tabs
 * @returns {HTMLElement}
 */
function createTabWidget(tabs) {
  const container = document.createElement('div');
  container.className = 'detail-tabs';

  const tabBar = document.createElement('div');
  tabBar.className = 'detail-tab-bar';

  const panels = tabs.map(({ label, content }) => {
    const panel = document.createElement('div');
    panel.className = 'detail-tab-panel';
    panel.style.display = 'none';
    if (typeof content === 'string') {
      panel.innerHTML = content;
    } else {
      panel.appendChild(content);
    }
    return panel;
  });

  tabs.forEach(({ label }, i) => {
    const btn = document.createElement('button');
    btn.className = 'detail-tab-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      panels.forEach((p, j) => { p.style.display = j === i ? '' : 'none'; });
      tabBar.querySelectorAll('.detail-tab-btn').forEach((b, j) => {
        b.classList.toggle('active', j === i);
      });
    });
    tabBar.appendChild(btn);
    container.appendChild(panels[i]);
  });

  // Show first tab by default
  if (panels.length) {
    panels[0].style.display = '';
    tabBar.querySelectorAll('.detail-tab-btn')[0]?.classList.add('active');
  }

  container.insertBefore(tabBar, container.firstChild);
  return container;
}

// ---------------------------------------------------------------------------
// Surgery detail (complex — includes brain-viz / fiber-viz canvases)
// ---------------------------------------------------------------------------

function buildSurgeryOverviewHtml(event) {
  const { start, details, data = {} } = event;
  const title = event.event === 'Terminal Surgery' ? 'Terminal Surgery' : 'Surgery Overview';
  const anaes = data.anaesthesia;
  const extra = [
    anaes
      ? `<dt>Anaesthesia</dt><dd>${anaes.anaesthetic_type ?? 'Unknown'} at ${anaes.level ?? 'Unknown'} for ${anaes.duration ?? '?'} ${anaes.duration_unit ?? ''}</dd>`
      : '',
    data.animal_weight_prior != null
      ? `<dt>Weight before</dt><dd>${data.animal_weight_prior} ${data.weight_unit ?? 'g'}</dd>`
      : '',
    data.animal_weight_post != null
      ? `<dt>Weight after</dt><dd>${data.animal_weight_post} ${data.weight_unit ?? 'g'}</dd>`
      : '',
    data.workstation_id
      ? `<dt>Workstation</dt><dd>${data.workstation_id}</dd>`
      : '',
    data.experimenters?.length
      ? `<dt>Experimenters</dt><dd>${data.experimenters.join(', ')}</dd>`
      : '',
  ].join('');
  return `
    <div class="detail-card">
      <h4>${title}</h4>
      <dl>
        <dt>Date</dt><dd>${fmtDate(start)}</dd>
        <dt>Procedures</dt><dd>${details ?? ''}</dd>
        ${extra}
      </dl>
    </div>`;
}

function fmtDetailValue(value) {
  if (value == null || value === '') return 'Unknown';
  return String(value);
}

function fmtDetailList(value) {
  const vals = Array.isArray(value)
    ? value.filter((v) => v != null && v !== '')
    : [];
  return vals.length ? vals.join(', ') : 'Unknown';
}

function fmtDetailBoolean(value) {
  if (value == null) return 'Unknown';
  return value ? 'Yes' : 'No';
}

export function buildCraniotomySubProcHtml(subProc) {
  const size = subProc.size != null
    ? `${subProc.size} ${subProc.size_unit ?? ''}`.trim()
    : 'Unknown';
  return `<div class="detail-card"><h4>Craniotomy</h4><dl>
    <dt>Type</dt><dd>${fmtDetailValue(subProc.craniotomy_type)}</dd>
    <dt>Coordinate system</dt><dd>${fmtDetailValue(subProc.coordinate_system_name)}</dd>
    <dt>Position</dt><dd>${fmtDetailList(subProc.position)}</dd>
    <dt>Size</dt><dd>${size}</dd>
    <dt>Protective material</dt><dd>${fmtDetailValue(subProc.protective_material)}</dd>
    <dt>Implant part number</dt><dd>${fmtDetailValue(subProc.implant_part_number)}</dd>
    <dt>Dura removed</dt><dd>${fmtDetailBoolean(subProc.dura_removed)}</dd>
    <dt>Protocol</dt><dd>${fmtDetailValue(subProc.protocol_id)}</dd>
  </dl></div>`;
}

export function buildHeadframeSubProcHtml(subProc) {
  return `<div class="detail-card"><h4>Headframe</h4><dl>
    <dt>Headframe type</dt><dd>${fmtDetailValue(subProc.headframe_type)}</dd>
    <dt>Headframe part number</dt><dd>${fmtDetailValue(subProc.headframe_part_number)}</dd>
    <dt>Headframe material</dt><dd>${fmtDetailValue(subProc.headframe_material)}</dd>
    <dt>Well type</dt><dd>${fmtDetailValue(subProc.well_type)}</dd>
    <dt>Well part number</dt><dd>${fmtDetailValue(subProc.well_part_number)}</dd>
    <dt>Protocol</dt><dd>${fmtDetailValue(subProc.protocol_id)}</dd>
  </dl></div>`;
}

function buildSubProcHtml(subProc) {
  const type = subProc.object_type ?? 'Unknown';
  if (type === 'Perfusion') {
    const specimens = (subProc.output_specimen_ids ?? []).join(', ') || 'Unknown';
    return `<div class="detail-card"><h4>Perfusion</h4><dl>
      <dt>Protocol</dt><dd>${subProc.protocol_id ?? 'Not specified'}</dd>
      <dt>Output specimens</dt><dd>${specimens}</dd>
    </dl></div>`;
  }
  if (type === 'Generic surgery procedure') {
    return `<div class="detail-card"><h4>Generic Procedure</h4><dl>
      <dt>Description</dt><dd>${subProc.description ?? 'No description'}</dd>
      ${subProc.notes ? `<dt>Notes</dt><dd>${subProc.notes}</dd>` : ''}
    </dl></div>`;
  }
  if (type === 'Craniotomy') {
    return buildCraniotomySubProcHtml(subProc);
  }
  if (type === 'Headframe') {
    return buildHeadframeSubProcHtml(subProc);
  }
  return `<div class="detail-card"><h4>${type}</h4><p>No additional details available.</p></div>`;
}

function createInjectionVizPanel(surgeryData, subjectId) {
  const container = document.createElement('div');
  const injections = extractInjectionsFromSurgery(surgeryData).sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  if (!injections.length) {
    container.innerHTML = '<p class="detail-empty">No injection data found.</p>';
    return container;
  }

  // Coordinate table
  const tableHtml = `
    <table class="detail-table">
      <thead><tr>
        <th>Injection</th><th>AP (mm)</th><th>ML (mm)</th><th>DV (mm)</th>
        <th>Material</th><th>Volume</th><th>Position</th>
      </tr></thead>
      <tbody>${injections.map((inj) => {
        const vol = inj.dynamics
          ? `${inj.dynamics.volume.toFixed(1)} ${inj.dynamics.volumeUnit}`
          : 'N/A';
        return `<tr>
          <td>${inj.name}</td>
          <td>${inj.ap.toFixed(2)}</td><td>${inj.ml.toFixed(2)}</td><td>${inj.dv.toFixed(2)}</td>
          <td>${inj.materialNames.join(', ') || 'Unknown'}</td>
          <td>${vol}</td>
          <td>${inj.position}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  container.innerHTML = `<h4>Brain Injections (Subject: ${subjectId})</h4>${tableHtml}`;

  // Canvas scatter
  const points = injections.map((inj) => [inj.ml, inj.ap]);
  const labels = injections.map((inj) => inj.name);
  const { canvas } = createBrainVizCanvas(points, labels, {
    title: 'Brain Injection Locations (Top View)',
  });
  container.appendChild(canvas);
  return container;
}

function createFiberVizPanel(surgeryData, subjectId, proceduresCoordSys = null) {
  const container = document.createElement('div');
  const fibers = extractFibersFromSurgery(surgeryData, proceduresCoordSys).sort(
    (a, b) => a.name.localeCompare(b.name),
  );

  if (!fibers.length) {
    container.innerHTML = '<p class="detail-empty">No fiber data found.</p>';
    return container;
  }

  const tableHtml = `
    <table class="detail-table">
      <thead><tr>
        <th>Fiber</th><th>AP (mm)</th><th>ML (mm)</th><th>DV (mm)</th>
        <th>Depth (mm)</th><th>Angle (°)</th><th>Target</th>
      </tr></thead>
      <tbody>${fibers.map((f) => `<tr>
        <td>${f.name}</td>
        <td>${f.ap.toFixed(2)}</td>
        <td>${f.ml.toFixed(2)}</td>
        <td>${f.dv != null ? f.dv.toFixed(2) : 'N/A'}</td>
        <td>${f.depth != null ? f.depth.toFixed(2) : 'N/A'}</td>
        <td>${Math.abs(f.angle) > 0.1 ? f.angle.toFixed(1) : '0'}</td>
        <td>${f.targetedStructure}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  container.innerHTML = `<h4>Fiber Implants (Subject: ${subjectId})</h4>${tableHtml}`;

  const points = fibers.map((f) => [f.ml, f.ap]);
  const labels = fibers.map((f) => f.name);
  const { canvas } = createBrainVizCanvas(points, labels, {
    title: 'Fiber Implant Locations (Top View)',
  });

  // Side-by-side layout: 2D canvas on left, 3D viewer on right
  // (proceduresCoordSys drives the coordinate parsing in the 3D viewer)
  const vizRow = document.createElement('div');
  vizRow.style.cssText = 'display:flex;gap:12px;align-items:flex-start;margin-top:8px';

  const canvas2dWrap = document.createElement('div');
  canvas2dWrap.style.cssText = 'flex:0 0 auto';
  canvas2dWrap.appendChild(canvas);
  vizRow.appendChild(canvas2dWrap);

  const viz3d = createBrainViz3D(surgeryData, proceduresCoordSys);
  viz3d.style.cssText += ';flex:1 1 400px;min-width:300px';
  vizRow.appendChild(viz3d);

  container.appendChild(vizRow);
  return container;
}

// ---------------------------------------------------------------------------
// Ephys assembly panel (for Acquisition events with ecephys data)
// ---------------------------------------------------------------------------

/**
 * Build an HTML string for a single ephys probe info card.
 * Pure function, Node-testable.
 *
 * @param {object} probe - Probe object from extractEphysProbes().
 * @param {number} index - Probe index (for color reference).
 * @returns {string}
 */
export function buildEphysProbeCard(probe, index) {
  const primary = probe.primaryStructure
    ? `${probe.primaryStructure.name} (${probe.primaryStructure.acronym})`
    : 'Not specified';
  const others = probe.otherStructures.length
    ? probe.otherStructures.map((s) => `${s.name} (${s.acronym})`).join(', ')
    : null;
  const moduleAngles = probe.modules
    .filter((m) => m && (m.arc_angle != null || m.module_angle != null))
    .map((m) => {
      const parts = [];
      if (m.arc_angle != null) parts.push(`arc ${m.arc_angle}°`);
      if (m.module_angle != null) parts.push(`module ${m.module_angle}°`);
      if (m.rotation_angle != null) parts.push(`rotation ${m.rotation_angle}°`);
      return parts.join(', ');
    })
    .join('; ');

  return `
    <div class="detail-card">
      <h4>Probe ${index + 1}: ${probe.name}</h4>
      <dl>
        <dt>Primary target</dt><dd>${primary}</dd>
        ${others ? `<dt>Other targets</dt><dd>${others}</dd>` : ''}
        ${probe.dye ? `<dt>Dye</dt><dd>${probe.dye}</dd>` : ''}
        ${moduleAngles ? `<dt>Module angles</dt><dd>${moduleAngles}</dd>` : ''}
        ${probe.notes ? `<dt>Notes</dt><dd>${probe.notes}</dd>` : ''}
      </dl>
    </div>`;
}

/**
 * Create the ephys details panel (info cards + 3D viewer).
 * @param {object} acquisitionData - Raw acquisition object.
 * @returns {HTMLElement}
 */
function createEphysPanel(acquisitionData) {
  const container = document.createElement('div');
  const probes = extractEphysProbes(acquisitionData);

  if (!probes.length) {
    container.innerHTML = '<p class="detail-empty">No ephys probe data found.</p>';
    return container;
  }

  // Info cards for each probe
  const cardsHtml = probes.map((p, i) => buildEphysProbeCard(p, i)).join('');
  container.innerHTML = cardsHtml;

  // 3D viewer below the cards
  const viz3d = createEphysViz3D(acquisitionData);
  viz3d.style.cssText += ';margin-top:12px';
  container.appendChild(viz3d);

  return container;
}

/**
 * Render an Acquisition event detail: overview card, with an optional
 * "Ephys Assembly" tab when ephys data is present.
 */
function renderAcquisitionDetail(event, container) {
  const { data = {} } = event;

  if (!hasEphysAssemblies(data)) {
    // Simple case: just the overview card
    container.innerHTML = buildAcquisitionDetail(event);
    return;
  }

  // Tab layout: Overview + Ephys Assembly
  const overviewEl = document.createElement('div');
  overviewEl.innerHTML = buildAcquisitionDetail(event);

  const tabDefs = [
    { label: 'Overview',        content: overviewEl },
    { label: 'Ephys Assembly',  content: createEphysPanel(data) },
  ];

  container.innerHTML = '';
  container.appendChild(createTabWidget(tabDefs));
}

function renderSurgeryDetail(event, container, { subjectId = 'Unknown', proceduresCoordSys = null } = {}) {
  const { data = {} } = event;
  const tabDefs = [];

  // Overview tab
  const overviewEl = document.createElement('div');
  overviewEl.innerHTML = buildSurgeryOverviewHtml(event);
  tabDefs.push({ label: 'Overview', content: overviewEl });

  // One tab per plain sub-procedure (skip Probe implant + Brain injection — they get dedicated tabs)
  for (const sub of data.procedures ?? []) {
    if (!sub) continue;
    const type = sub.object_type ?? 'Unknown';
    if (type === 'Probe implant' || type === 'Brain injection') continue;
    const el = document.createElement('div');
    el.innerHTML = buildSubProcHtml(sub);
    tabDefs.push({ label: type, content: el });
  }

  // Brain injections tab
  if (hasBrainInjections(data)) {
    tabDefs.push({ label: 'Brain Injections', content: createInjectionVizPanel(data, subjectId) });
  }

  // Fiber locations tab (2D top-down)
  if (hasFiberImplants(data)) {
    tabDefs.push({ label: 'Fiber Locations', content: createFiberVizPanel(data, subjectId, proceduresCoordSys) });
  }

  container.innerHTML = '';
  container.appendChild(createTabWidget(tabDefs));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Render event detail HTML/DOM into `container`.
 *
 * @param {object|null} event - Selected timeline event (from buildTimelineEvents).
 * @param {HTMLElement} container - Element to render into (will be cleared).
 * @param {object} [context]
 * @param {string} [context.subjectId] - Subject ID for headings in viz panels.
 */
export function renderEventDetail(event, container, context = {}) {
  if (!event) {
    container.innerHTML = '<p class="detail-placeholder">Click on a timeline event to see details.</p>';
    return;
  }

  const type = event.type ?? 'Unknown';

  switch (type) {
    case 'Birth':
      container.innerHTML = buildBirthDetail(event);
      break;

    case 'Surgery':
      renderSurgeryDetail(event, container, context);
      break;

    case 'Acquisition':
      renderAcquisitionDetail(event, container);
      break;

    case 'Session':
      container.innerHTML = buildSessionDetail(event);
      break;

    case 'Perfusion':
    case 'Brain injection':
    case 'Generic surgery procedure':
    case 'Probe implant':
      container.innerHTML = buildSubProcedureDetail(event);
      break;

    default:
      // Specimen procedures and anything else
      if (['Fixation', 'Delipidation', 'Refractive index matching'].includes(type)) {
        container.innerHTML = buildSpecimenProcedureDetail(event);
      } else {
        container.innerHTML = buildSubProcedureDetail(event);
      }
  }
}

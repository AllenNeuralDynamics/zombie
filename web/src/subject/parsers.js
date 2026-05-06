/**
 * subject-parsers.js — Event parsers for the subject timeline.
 *
 * Ported from:
 *   src/zombie/subject_contents/procedures/parsers.py
 *   src/zombie/subject_contents/procedures/brain_injection_parser.py
 *   src/zombie/subject_contents/procedures/fiber_implant_parser.py
 *
 * All functions are pure and side-effect-free; suitable for unit testing
 * in a Node environment without DOM.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default event duration (ms) when no end date is provided — 1 day. */
export const NO_END_DATE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Color map for timeline event types (matches CSS class usage in timeline).
 * Used by subject-timeline.js and subject-details.js.
 */
export const EVENT_COLORS = {
  Birth: '#9C27B0',
  Surgery: '#F44336',
  Acquisition: '#2196F3',
  Session: '#4CAF50',
  Perfusion: '#FF5722',
  'Brain injection': '#E91E63',
  'Probe implant': '#00BCD4',
  'Generic surgery procedure': '#FF9800',
  Fixation: '#607D8B',
  Delipidation: '#795548',
  'Refractive index matching': '#009688',
};

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Safely convert a value to a finite float.
 *
 * @param {unknown} value
 * @param {number} [defaultVal=0]
 * @returns {number}
 */
export function safeFloat(value, defaultVal = 0) {
  if (value == null) return defaultVal;
  const n = Number(value);
  return isFinite(n) ? n : defaultVal;
}

/**
 * Normalise a timestamp string or Date to a JS Date.
 *
 * @param {string|Date|null|undefined} ts
 * @returns {Date|null}
 */
export function normalizeTimestamp(ts) {
  if (!ts) return null;
  const d = ts instanceof Date ? ts : new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Timeline event parsers
// ---------------------------------------------------------------------------

/**
 * Parse birth event from a subject record.
 *
 * @param {object} subject - Subject portion of a DocDB record.
 * @returns {object|null} Timeline event object or null.
 */
export function parseBirth(subject) {
  if (!subject) return null;
  const details = subject.subject_details ?? {};
  const dob = details.date_of_birth;
  if (!dob) return null;

  const start = normalizeTimestamp(dob);
  if (!start) return null;

  return {
    start,
    end: new Date(start.getTime() + NO_END_DATE_DURATION_MS),
    event: 'Birth',
    type: 'Birth',
    details: `Subject ${subject.subject_id ?? 'Unknown'} born`,
    data: details,
    dateOnly: true,
  };
}

/**
 * Parse a Surgery/Procedure event from a subject_procedures entry.
 *
 * @param {object} proc
 * @returns {object|null}
 */
export function parseProcedure(proc) {
  if (!proc) return null;
  const procType = proc.object_type ?? 'Procedure';
  const start = normalizeTimestamp(proc.start_date);
  if (!start) return null;

  const end = proc.end_date
    ? (normalizeTimestamp(proc.end_date) ?? new Date(start.getTime() + NO_END_DATE_DURATION_MS))
    : new Date(start.getTime() + NO_END_DATE_DURATION_MS);

  let detailStr;
  if (procType === 'Surgery') {
    const subProcs = (proc.procedures ?? []).filter(Boolean);
    const parts = subProcs.map((sp) => sp.object_type ?? 'Unknown');
    detailStr = parts.length ? parts.join(', ') : 'Surgery';
  } else {
    detailStr = procType;
  }

  return { start, end, event: procType, type: procType, details: detailStr, data: proc, dateOnly: true };
}

/**
 * Parse an acquisition event (with start + end times).
 *
 * @param {object} acquisition
 * @returns {object|null}
 */
export function parseAcquisition(acquisition) {
  if (!acquisition) return null;
  const start = normalizeTimestamp(acquisition.acquisition_start_time);
  const end = normalizeTimestamp(acquisition.acquisition_end_time);
  if (!start || !end) return null;

  const acqType = acquisition.acquisition_type ?? acquisition.session_type ?? 'Acquisition';
  const protocol = acquisition.protocol_name ?? '';
  const label = protocol ? `${acqType} (${protocol})` : acqType;
  const durationHrs = (end - start) / 3_600_000;

  return {
    start,
    end,
    event: label,
    type: 'Acquisition',
    details: `Duration: ${durationHrs.toFixed(1)} hours`,
    data: acquisition,
  };
}

/**
 * Parse a session from a data_description record.
 *
 * @param {object} dataDesc
 * @returns {object|null}
 */
export function parseSession(dataDesc) {
  if (!dataDesc) return null;
  const start = normalizeTimestamp(dataDesc.creation_time);
  if (!start) return null;

  return {
    start,
    end: new Date(start.getTime() + 4 * 3_600_000),
    event: 'Session',
    type: 'Session',
    details: `Data session: ${dataDesc.name ?? 'Unknown'}`,
    data: dataDesc,
  };
}

/**
 * Parse a perfusion sub-procedure.
 *
 * @param {object} proc
 * @param {string|Date|null} [surgeryDate]
 * @returns {object|null}
 */
export function parsePerfusion(proc, surgeryDate = null) {
  if (!proc) return null;
  const start = normalizeTimestamp(surgeryDate ?? proc.start_date);
  if (!start) return null;

  const specimens = proc.output_specimen_ids ?? [];
  return {
    start,
    end: new Date(start.getTime() + 3_600_000),
    event: 'Perfusion',
    type: 'Perfusion',
    details: `Perfusion (specimen: ${specimens.length ? specimens.join(', ') : 'Unknown'})`,
    data: proc,
    dateOnly: true,
  };
}

/**
 * Parse a brain injection sub-procedure.
 *
 * @param {object} proc
 * @param {string|Date|null} [surgeryDate]
 * @returns {object|null}
 */
export function parseBrainInjection(proc, surgeryDate = null) {
  if (!proc) return null;
  const start = normalizeTimestamp(surgeryDate ?? proc.start_date);
  if (!start) return null;

  const materials = (proc.injection_materials ?? [])
    .filter((m) => m?.object_type === 'Viral material')
    .map((m) => m.name ?? 'Unknown');
  const positions = proc.relative_position ?? [];

  return {
    start,
    end: new Date(start.getTime() + 2 * 3_600_000),
    event: 'Brain injection',
    type: 'Brain injection',
    details: `Brain injection (${positions.join(', ') || 'Unknown'}): ${materials.join(', ') || 'Unknown'}`,
    data: proc,
    dateOnly: true,
  };
}

/**
 * Parse a generic surgery sub-procedure.
 *
 * @param {object} proc
 * @param {string|Date|null} [surgeryDate]
 * @returns {object|null}
 */
export function parseGenericSurgeryProcedure(proc, surgeryDate = null) {
  if (!proc) return null;
  const start = normalizeTimestamp(surgeryDate ?? proc.start_date);
  if (!start) return null;

  const description = proc.description ?? 'Generic surgery procedure';
  const notes = proc.notes ?? '';

  return {
    start,
    end: new Date(start.getTime() + 2 * 3_600_000),
    event: 'Generic surgery procedure',
    type: 'Generic surgery procedure',
    details: notes ? `${description} - ${notes}` : description,
    data: proc,
    dateOnly: true,
  };
}

/**
 * Parse a specimen procedure.
 *
 * @param {object} proc
 * @returns {object|null}
 */
export function parseSpecimenProcedure(proc) {
  if (!proc) return null;
  const start = normalizeTimestamp(proc.start_date);
  if (!start) return null;

  const end = proc.end_date
    ? (normalizeTimestamp(proc.end_date) ?? new Date(start.getTime() + NO_END_DATE_DURATION_MS))
    : new Date(start.getTime() + NO_END_DATE_DURATION_MS);

  const procedureType = proc.procedure_type ?? 'Unknown';
  const procedureName = proc.procedure_name ?? 'Unknown';
  const specimenId = proc.specimen_id ?? 'Unknown';
  const reagents = (proc.procedure_details ?? [])
    .filter((d) => d?.object_type === 'Reagent')
    .map((d) => (d.lot_number ? `${d.name ?? 'Unknown'} (lot: ${d.lot_number})` : (d.name ?? 'Unknown')));

  const parts = [procedureName];
  if (reagents.length) parts.push(`Reagents: ${reagents.join(', ')}`);
  if (specimenId !== 'Unknown') parts.push(`Specimen: ${specimenId}`);

  return { start, end, event: procedureType, type: procedureType, details: parts.join(' - '), data: proc, dateOnly: true };
}

/**
 * Parse a fiber/probe implant sub-procedure.
 *
 * @param {object} proc
 * @param {string|Date|null} [surgeryDate]
 * @returns {object|null}
 */
export function parseFiberImplant(proc, surgeryDate = null) {
  if (!proc) return null;
  const start = normalizeTimestamp(surgeryDate ?? proc.start_date);
  if (!start) return null;

  const dc = proc.device_config;
  const detailStr = dc ? `Fiber probe implant (${dc.device_name ?? 'Unknown'})` : 'Probe implant';

  return {
    start,
    end: new Date(start.getTime() + 2 * 3_600_000),
    event: 'Probe implant',
    type: 'Probe implant',
    details: detailStr,
    data: proc,
    hasFiberVisualization: true,
    dateOnly: true,
  };
}

/**
 * Build the full list of timeline events from a subject data bundle.
 *
 * @param {object} subjectData - Bundle: { subject, procedures, acquisitions }
 * @returns {Array<object>} Sorted array of timeline event objects.
 */
export function buildTimelineEvents(subjectData) {
  if (!subjectData) return [];
  const events = [];

  // Birth
  const birth = parseBirth(subjectData.subject ?? {});
  if (birth) events.push(birth);

  // Subject procedures (top-level: Surgery, Headframe, etc.)
  const subjectProcedures = subjectData.procedures?.subject_procedures ?? [];
  for (const proc of subjectProcedures) {
    const ev = parseProcedure(proc);
    if (ev) events.push(ev);
  }

  // Specimen procedures
  const specimenProcedures = subjectData.procedures?.specimen_procedures ?? [];
  for (const proc of specimenProcedures) {
    const ev = parseSpecimenProcedure(proc);
    if (ev) events.push(ev);
  }

  // Acquisitions
  const acquisitions = subjectData.acquisitions ?? [];
  for (const acq of acquisitions) {
    const ev = parseAcquisition(acq);
    if (ev) events.push(ev);
  }

  events.sort((a, b) => a.start - b.start);
  return events;
}

// ---------------------------------------------------------------------------
// Brain injection helpers (ported from brain_injection_parser.py)
// ---------------------------------------------------------------------------

/**
 * Extract AP/ML/DV coordinates from a brain injection procedure.
 *
 * @param {object} injectionProc
 * @returns {[number, number, number]} [ap, ml, dv]
 */
export function extractInjectionCoordinates(injectionProc) {
  const coordinates = injectionProc?.coordinates ?? [];
  if (!coordinates.length) return [0, 0, 0];
  const coordSet = coordinates[0];
  if (!Array.isArray(coordSet) || !coordSet.length) return [0, 0, 0];
  const translation = coordSet[0];
  if (!translation || translation.object_type !== 'Translation') return [0, 0, 0];
  const vals = translation.translation ?? [];
  return vals.length >= 3
    ? [safeFloat(vals[0]), safeFloat(vals[1]), safeFloat(vals[2])]
    : [0, 0, 0];
}

/**
 * Extract viral material list from an injection procedure.
 *
 * @param {object} injectionProc
 * @returns {Array<object>}
 */
export function extractInjectionMaterials(injectionProc) {
  return (injectionProc?.injection_materials ?? [])
    .filter((m) => m?.object_type === 'Viral material')
    .map((m) => {
      const tars = m.tars_identifiers ?? {};
      return {
        name: m.name ?? 'Unknown',
        titer: m.titer ?? 'Unknown',
        titerUnit: m.titer_unit ?? '',
        tarsId: tars.virus_tars_id ?? '',
        lotNumber: tars.prep_lot_number ?? '',
      };
    });
}

/**
 * Extract injection dynamics from a procedure.
 *
 * @param {object} injectionProc
 * @returns {object|null}
 */
export function extractInjectionDynamics(injectionProc) {
  const dynamics = injectionProc?.dynamics ?? [];
  if (!dynamics.length) return null;
  const dyn = dynamics[0];
  if (!dyn) return null;
  return {
    profile: dyn.profile ?? 'Unknown',
    volume: safeFloat(dyn.volume),
    volumeUnit: dyn.volume_unit ?? 'nL',
    duration: dyn.duration != null ? safeFloat(dyn.duration) : null,
    durationUnit: dyn.duration_unit ?? 's',
  };
}

/**
 * Get numeric injection index from name for sort ordering.
 *
 * @param {object} injectionData
 * @returns {number}
 */
export function getInjectionIndex(injectionData) {
  const name = injectionData?.name ?? '';
  if (name.includes('_')) {
    const n = parseInt(name.split('_').at(-1), 10);
    if (!isNaN(n)) return n;
  }
  return 999;
}

/**
 * Extract all brain injection data from a surgery.
 *
 * @param {object} surgeryData
 * @returns {Array<object>}
 */
export function extractInjectionsFromSurgery(surgeryData) {
  return (surgeryData?.procedures ?? [])
    .map((proc, idx) => {
      if (!proc || proc.object_type !== 'Brain injection') return null;
      const [ap, ml, dv] = extractInjectionCoordinates(proc);
      const materials = extractInjectionMaterials(proc);
      const dynamics = extractInjectionDynamics(proc);
      return {
        name: `Injection_${idx}`,
        ap,
        ml,
        dv,
        unit: 'millimeter',
        reference: proc.coordinate_system_name ?? 'Unknown',
        position: (proc.relative_position ?? []).join(', ') || 'Unknown',
        materials,
        materialNames: materials.map((m) => m.name),
        dynamics,
        protocolId: proc.protocol_id ?? 'Not specified',
      };
    })
    .filter(Boolean);
}

/**
 * Check if a surgery has any brain injection procedures.
 *
 * @param {object} surgeryData
 * @returns {boolean}
 */
export function hasBrainInjections(surgeryData) {
  return (surgeryData?.procedures ?? []).some((p) => p?.object_type === 'Brain injection');
}

// ---------------------------------------------------------------------------
// Fiber implant helpers (ported from fiber_implant_parser.py)
// ---------------------------------------------------------------------------

/**
 * Extract fiber metadata from a device config.
 *
 * @param {object} deviceConfig
 * @returns {object}
 */
export function extractFiberMetadata(deviceConfig) {
  let ap = 0, ml = 0, dv = null, depth = null, angle = 0;
  for (const t of deviceConfig?.transform ?? []) {
    if (t?.object_type === 'Translation') {
      const vals = t.translation ?? [];
      if (vals.length >= 3) { ap = safeFloat(vals[0]); ml = safeFloat(vals[1]); dv = safeFloat(vals[2]); }
      if (vals.length >= 4) { depth = Math.abs(safeFloat(vals[3])); }
    } else if (t?.object_type === 'Rotation') {
      const r = t.rotation ?? [];
      if (r.length >= 1) angle = safeFloat(r[0]);
    }
  }
  return {
    name: deviceConfig?.device_name ?? 'Unknown',
    ap,
    ml,
    dv,
    depth,
    angle,
    unit: 'millimeter',
    reference: (deviceConfig?.coordinate_system ?? {}).origin ?? 'Bregma',
    targetedStructure: (deviceConfig?.primary_targeted_structure ?? {}).name
      ?? 'Not specified in surgical request form',
  };
}

/**
 * Extract all fiber implant data from a surgery.
 *
 * @param {object} surgeryData
 * @returns {Array<object>}
 */
export function extractFibersFromSurgery(surgeryData) {
  return (surgeryData?.procedures ?? [])
    .filter((p) => p?.object_type === 'Probe implant' && p.device_config)
    .map((p) => extractFiberMetadata(p.device_config));
}

/**
 * Check if a surgery has any fiber/probe implant procedures.
 *
 * @param {object} surgeryData
 * @returns {boolean}
 */
export function hasFiberImplants(surgeryData) {
  return (surgeryData?.procedures ?? []).some((p) => p?.object_type === 'Probe implant');
}

/**
 * Get numeric fiber index from name for sort ordering.
 *
 * @param {object} fiber
 * @returns {number}
 */
export function getFiberIndex(fiber) {
  const n = parseInt((fiber?.name ?? '').split('_').at(-1), 10);
  return isNaN(n) ? 999 : n;
}

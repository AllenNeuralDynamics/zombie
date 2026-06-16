/**
 * subject-parsers.test.js — Unit tests for subject-parsers.js pure helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  safeFloat,
  normalizeTimestamp,
  parseBirth,
  parseProcedure,
  parseAcquisition,
  parseSession,
  parseSpecimenProcedure,
  buildTimelineEvents,
  extractInjectionCoordinates,
  extractInjectionMaterials,
  extractInjectionDynamics,
  extractInjectionsFromSurgery,
  hasBrainInjections,
  extractFiberMetadata,
  extractFibersFromSurgery,
  hasFiberImplants,
  getFiberIndex,
  getInjectionIndex,
} from '../subject/parsers.js';

// ---------------------------------------------------------------------------
// safeFloat
// ---------------------------------------------------------------------------

describe('safeFloat', () => {
  it('converts numeric strings', () => expect(safeFloat('3.14')).toBeCloseTo(3.14));
  it('returns default for null', () => expect(safeFloat(null)).toBe(0));
  it('returns default for NaN string', () => expect(safeFloat('abc')).toBe(0));
  it('accepts custom default', () => expect(safeFloat(null, -1)).toBe(-1));
});

// ---------------------------------------------------------------------------
// normalizeTimestamp
// ---------------------------------------------------------------------------

describe('normalizeTimestamp', () => {
  it('parses ISO date string', () => {
    const d = normalizeTimestamp('2025-01-15');
    expect(d).toBeInstanceOf(Date);
    expect(isNaN(d.getTime())).toBe(false);
  });

  it('passes through a Date object unchanged', () => {
    const orig = new Date('2025-06-01T00:00:00Z');
    expect(normalizeTimestamp(orig)).toBe(orig);
  });

  it('returns null for null/undefined/empty', () => {
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp(undefined)).toBeNull();
    expect(normalizeTimestamp('')).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(normalizeTimestamp('not-a-date')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseBirth
// ---------------------------------------------------------------------------

describe('parseBirth', () => {
  it('returns null for falsy input', () => {
    expect(parseBirth(null)).toBeNull();
    expect(parseBirth({})).toBeNull();
  });

  it('returns null when date_of_birth missing', () => {
    expect(parseBirth({ subject_id: '123', subject_details: {} })).toBeNull();
  });

  it('parses a valid birth record', () => {
    const ev = parseBirth({
      subject_id: '804670',
      subject_details: { date_of_birth: '2025-04-29' },
    });
    expect(ev).not.toBeNull();
    expect(ev.type).toBe('Birth');
    expect(ev.event).toBe('Birth');
    expect(ev.start).toBeInstanceOf(Date);
    expect(ev.end.getTime()).toBeGreaterThan(ev.start.getTime());
    expect(ev.details).toContain('804670');
  });
});

// ---------------------------------------------------------------------------
// parseProcedure
// ---------------------------------------------------------------------------

describe('parseProcedure', () => {
  it('returns null for falsy input', () => expect(parseProcedure(null)).toBeNull());
  it('returns null when start_date missing', () => {
    expect(parseProcedure({ object_type: 'Surgery' })).toBeNull();
  });

  it('parses a surgery procedure', () => {
    const ev = parseProcedure({
      object_type: 'Surgery',
      start_date: '2025-03-01',
      procedures: [
        { object_type: 'Probe implant' },
        { object_type: 'Brain injection' },
      ],
    });
    expect(ev.type).toBe('Surgery');
    expect(ev.details).toContain('Probe implant');
    expect(ev.details).toContain('Brain injection');
  });

  it('labels surgery as Terminal Surgery when perfusion is present', () => {
    const ev = parseProcedure({
      object_type: 'Surgery',
      start_date: '2025-03-01',
      procedures: [
        { object_type: 'Perfusion' },
      ],
    });
    expect(ev.type).toBe('Surgery');
    expect(ev.event).toBe('Terminal Surgery');
  });

  it('uses end_date when provided', () => {
    const ev = parseProcedure({
      object_type: 'Headframe',
      start_date: '2025-01-10',
      end_date: '2025-01-11',
    });
    expect(ev.end.toISOString().slice(0, 10)).toBe('2025-01-11');
  });
});

// ---------------------------------------------------------------------------
// parseAcquisition
// ---------------------------------------------------------------------------

describe('parseAcquisition', () => {
  it('returns null for missing times', () => {
    expect(parseAcquisition(null)).toBeNull();
    expect(parseAcquisition({ acquisition_type: 'Ephys' })).toBeNull();
  });

  it('parses a valid acquisition', () => {
    const ev = parseAcquisition({
      acquisition_start_time: '2025-06-01T10:00:00Z',
      acquisition_end_time: '2025-06-01T14:00:00Z',
      session_type: 'Ephys',
    });
    expect(ev.type).toBe('Acquisition');
    expect(ev.event).toContain('Ephys');
    expect(Array.isArray(ev.modalities)).toBe(true);
  });

  it('includes protocol in label when present', () => {
    const ev = parseAcquisition({
      acquisition_start_time: '2025-06-01T10:00:00Z',
      acquisition_end_time: '2025-06-01T12:00:00Z',
      acquisition_type: 'behavior',
      protocol_name: 'BCI',
    });
    expect(ev.event).toBe('behavior (BCI)');
  });
});

// ---------------------------------------------------------------------------
// parseSession
// ---------------------------------------------------------------------------

describe('parseSession', () => {
  it('returns null for missing creation_time', () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession({ name: 'foo' })).toBeNull();
  });

  it('parses a session', () => {
    const ev = parseSession({ creation_time: '2025-05-01T08:00:00Z', name: 'my-session' });
    expect(ev.type).toBe('Session');
    expect(ev.details).toContain('my-session');
    // 4-hour duration
    expect(ev.end.getTime() - ev.start.getTime()).toBe(4 * 3_600_000);
  });
});

// ---------------------------------------------------------------------------
// parseSpecimenProcedure
// ---------------------------------------------------------------------------

describe('parseSpecimenProcedure', () => {
  it('returns null without start_date', () => expect(parseSpecimenProcedure({})).toBeNull());

  it('parses a specimen procedure with reagents', () => {
    const ev = parseSpecimenProcedure({
      start_date: '2025-02-01',
      end_date: '2025-02-05',
      procedure_type: 'Fixation',
      procedure_name: 'Paraformaldehyde',
      procedure_details: [{ object_type: 'Reagent', name: 'PFA', lot_number: 'L123' }],
    });
    expect(ev.type).toBe('Fixation');
    expect(ev.details).toContain('PFA');
    expect(ev.details).toContain('L123');
  });
});

// ---------------------------------------------------------------------------
// buildTimelineEvents
// ---------------------------------------------------------------------------

describe('buildTimelineEvents', () => {
  it('returns [] for null input', () => {
    expect(buildTimelineEvents(null)).toEqual([]);
  });

  it('collects birth + procedures + acquisitions and sorts by start', () => {
    const bundle = {
      subject: {
        subject_id: '42',
        subject_details: { date_of_birth: '2020-01-01' },
      },
      procedures: {
        subject_procedures: [
          { object_type: 'Surgery', start_date: '2021-06-15' },
        ],
        specimen_procedures: [],
      },
      acquisitions: [
        {
          acquisition_start_time: '2022-03-01T09:00:00Z',
          acquisition_end_time: '2022-03-01T13:00:00Z',
        },
      ],
    };
    const events = buildTimelineEvents(bundle);
    expect(events.length).toBe(3);
    expect(events[0].type).toBe('Birth');
    expect(events[1].type).toBe('Surgery');
    expect(events[2].type).toBe('Acquisition');
  });
});

// ---------------------------------------------------------------------------
// Brain injection helpers
// ---------------------------------------------------------------------------

describe('extractInjectionCoordinates', () => {
  it('returns [0,0,0] for empty input', () => {
    expect(extractInjectionCoordinates({})).toEqual([0, 0, 0]);
    expect(extractInjectionCoordinates(null)).toEqual([0, 0, 0]);
  });

  it('extracts AP/ML/DV from Translation transform', () => {
    const proc = {
      coordinates: [[{ object_type: 'Translation', translation: [1.5, -0.5, 2.0] }]],
    };
    expect(extractInjectionCoordinates(proc)).toEqual([1.5, -0.5, 2.0]);
  });
});

describe('extractInjectionMaterials', () => {
  it('returns [] for no materials', () => {
    expect(extractInjectionMaterials({})).toEqual([]);
  });

  it('filters to Viral material only', () => {
    const proc = {
      injection_materials: [
        { object_type: 'Viral material', name: 'AAV9-GCaMP8s', tars_identifiers: {} },
        { object_type: 'Other', name: 'Saline', tars_identifiers: {} },
      ],
    };
    const mats = extractInjectionMaterials(proc);
    expect(mats).toHaveLength(1);
    expect(mats[0].name).toBe('AAV9-GCaMP8s');
  });
});

describe('extractInjectionDynamics', () => {
  it('returns null for empty dynamics', () => {
    expect(extractInjectionDynamics({})).toBeNull();
  });

  it('extracts volume and profile', () => {
    const proc = { dynamics: [{ profile: 'linear', volume: 100, volume_unit: 'nL' }] };
    const d = extractInjectionDynamics(proc);
    expect(d.volume).toBe(100);
    expect(d.profile).toBe('linear');
    expect(d.volumeUnit).toBe('nL');
  });
});

describe('hasBrainInjections', () => {
  it('returns false for surgery with no injections', () => {
    expect(hasBrainInjections({ procedures: [{ object_type: 'Probe implant' }] })).toBe(false);
  });

  it('returns true when Brain injection present', () => {
    expect(hasBrainInjections({ procedures: [{ object_type: 'Brain injection' }] })).toBe(true);
  });
});

describe('extractInjectionsFromSurgery', () => {
  it('extracts injection data', () => {
    const surgery = {
      procedures: [
        {
          object_type: 'Brain injection',
          coordinates: [[{ object_type: 'Translation', translation: [1.0, -0.5, 3.0] }]],
          injection_materials: [
            { object_type: 'Viral material', name: 'AAV9', tars_identifiers: {} },
          ],
          relative_position: ['left'],
        },
      ],
    };
    const injs = extractInjectionsFromSurgery(surgery);
    expect(injs).toHaveLength(1);
    expect(injs[0].ap).toBe(1.0);
    expect(injs[0].ml).toBe(-0.5);
    expect(injs[0].materialNames).toContain('AAV9');
    expect(injs[0].position).toBe('left');
  });
});

// ---------------------------------------------------------------------------
// Fiber implant helpers
// ---------------------------------------------------------------------------

describe('hasFiberImplants', () => {
  it('returns false when no probe implants', () => {
    expect(hasFiberImplants({ procedures: [{ object_type: 'Brain injection' }] })).toBe(false);
  });

  it('returns true when Probe implant present', () => {
    expect(hasFiberImplants({ procedures: [{ object_type: 'Probe implant' }] })).toBe(true);
  });
});

describe('extractFiberMetadata', () => {
  it('extracts AP/ML/DV from Translation and angle from Rotation', () => {
    const dc = {
      device_name: 'FP_0',
      transform: [
        { object_type: 'Translation', translation: [2.0, 1.5, -4.0] },
        { object_type: 'Rotation', rotation: [15, 0, 0] },
      ],
      primary_targeted_structure: { name: 'V1' },
    };
    const f = extractFiberMetadata(dc);
    expect(f.name).toBe('FP_0');
    expect(f.ap).toBe(2.0);
    expect(f.ml).toBe(1.5);
    expect(f.dv).toBe(-4.0);
    expect(f.angle).toBe(15);
    expect(f.targetedStructure).toBe('V1');
  });

  it('reads angle from t.angles (new backend format)', () => {
    const dc = {
      device_name: 'FP_0',
      transform: [
        { object_type: 'Translation', translation: [0.5, -0.9, 3.9] },
        { object_type: 'Rotation', angles: [10.0, 0.0, 0.0], angles_unit: 'degrees' },
      ],
    };
    const f = extractFiberMetadata(dc);
    expect(f.angle).toBe(10.0);
  });

  it('parses AP/ML/depth correctly with BREGMA_ARD surgery coord sys', () => {
    const bregmaArd = {
      axes: [
        { direction: 'Posterior_to_anterior' },
        { direction: 'Left_to_right' },
        { direction: 'Up_to_down' },
      ],
    };
    const dc = {
      device_name: 'Fiber_0',
      transform: [
        { object_type: 'Translation', translation: [0.5, -0.9, 3.9] },
        { object_type: 'Rotation', angles: [10.0, 0.0, 0.0], angles_unit: 'degrees' },
      ],
    };
    const f = extractFiberMetadata(dc, bregmaArd);
    expect(f.ap).toBeCloseTo(0.5);
    expect(f.ml).toBeCloseTo(-0.9);
    expect(f.depth).toBeCloseTo(3.9);
    expect(f.dv).toBeNull();
    expect(f.angle).toBe(10.0);
  });
});

describe('extractFibersFromSurgery', () => {
  it('skips entries without device_config', () => {
    const surgery = { procedures: [{ object_type: 'Probe implant' }] };
    expect(extractFibersFromSurgery(surgery)).toHaveLength(0);
  });

  it('extracts fibers with device_config', () => {
    const surgery = {
      procedures: [
        {
          object_type: 'Probe implant',
          device_config: {
            device_name: 'FP_0',
            transform: [{ object_type: 'Translation', translation: [1, 0.5, -3] }],
            primary_targeted_structure: { name: 'V1' },
          },
        },
      ],
    };
    const fibers = extractFibersFromSurgery(surgery);
    expect(fibers).toHaveLength(1);
    expect(fibers[0].name).toBe('FP_0');
  });

  it('uses surgeryData.coordinate_system when defined, ignoring proceduresCoordSys', () => {
    const surgeryCoordSys = {
      axes: [
        { direction: 'Posterior_to_anterior' },
        { direction: 'Left_to_right' },
        { direction: 'Inferior_to_superior' },
      ],
    };
    const topLevelCoordSys = {
      axes: [
        { direction: 'Left_to_right' },
        { direction: 'Posterior_to_anterior' },
        { direction: 'Inferior_to_superior' },
      ],
    };
    const surgery = {
      coordinate_system: surgeryCoordSys,
      procedures: [
        {
          object_type: 'Probe implant',
          device_config: {
            device_name: 'FP_0',
            transform: [{ object_type: 'Translation', translation: [1, 2, 3] }],
          },
        },
      ],
    };
    const fibers = extractFibersFromSurgery(surgery, topLevelCoordSys);
    expect(fibers[0].ap).toBe(1);
    expect(fibers[0].ml).toBe(2);
    expect(fibers[0].dv).toBe(3);
  });

  it('falls back to proceduresCoordSys when surgeryData has no coordinate_system', () => {
    const topLevelCoordSys = {
      axes: [
        { direction: 'Left_to_right' },
        { direction: 'Posterior_to_anterior' },
        { direction: 'Inferior_to_superior' },
      ],
    };
    const surgery = {
      procedures: [
        {
          object_type: 'Probe implant',
          device_config: {
            device_name: 'FP_0',
            transform: [{ object_type: 'Translation', translation: [1, 2, 3] }],
          },
        },
      ],
    };
    const fibers = extractFibersFromSurgery(surgery, topLevelCoordSys);
    expect(fibers[0].ml).toBe(1);
    expect(fibers[0].ap).toBe(2);
    expect(fibers[0].dv).toBe(3);
  });
});

describe('getFiberIndex / getInjectionIndex', () => {
  it('extracts numeric index from name', () => {
    expect(getFiberIndex({ name: 'FP_2' })).toBe(2);
    expect(getInjectionIndex({ name: 'Injection_3' })).toBe(3);
  });

  it('returns 999 for non-parseable names', () => {
    expect(getFiberIndex({ name: 'Unknown' })).toBe(999);
    expect(getInjectionIndex({})).toBe(999);
  });
});

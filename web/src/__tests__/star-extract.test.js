/**
 * star-extract.test.js — Unit tests for the pure STAR Methods extractor.
 *
 * Verifies fidelity to the Cell Press STAR Methods structure: four narrative
 * sections plus a Key Resources Table using only canonical category headings.
 */

import { describe, it, expect } from 'vitest';
import { collectByType, extractStarMethods, KRT_CATEGORIES } from '../star/extract.js';

const krtRows = (star, title) => star.krt.find((s) => s.title === title)?.rows ?? [];
const factValue = (facts, label) => facts.find((f) => f.label === label)?.value;

describe('collectByType', () => {
  it('collects matching objects at any nesting depth, across arrays and objects', () => {
    const tree = {
      object_type: 'Root',
      a: [{ object_type: 'Code', name: 'x' }, { b: { object_type: 'Code', name: 'y' } }],
      c: { object_type: 'Code', name: 'z' },
    };
    expect(collectByType(tree, 'Code').map((f) => f.name).sort()).toEqual(['x', 'y', 'z']);
  });

  it('returns [] for null / primitives', () => {
    expect(collectByType(null, 'Code')).toEqual([]);
    expect(collectByType(42, 'Code')).toEqual([]);
  });
});

describe('extractStarMethods', () => {
  const record = {
    name: 'behavior_1_2026-01-01',
    location: 's3://bucket/behavior_1',
    other_identifiers: { 'Code Ocean': ['abc-123'] },
    subject: {
      subject_id: '1',
      subject_details: {
        object_type: 'Mouse subject',
        sex: 'Female',
        genotype: 'Chat-IRES-Cre/wt',
        date_of_birth: '2026-01-01',
        strain: { name: 'C57BL/6J', registry: 'MGI', registry_identifier: 'MGI:3028467' },
        species: { name: 'Mus musculus', registry: 'NCBI', registry_identifier: 'NCBI:txid10090' },
        breeding_info: { maternal_id: '10', paternal_id: '11' },
        housing: { cage_id: '900', room_id: '217' },
        source: { name: 'Allen Institute' },
      },
    },
    procedures: {
      subject_procedures: [
        {
          object_type: 'Surgery',
          start_date: '2026-04-08',
          ethics_review_id: '2414',
          protocol_id: 'dx.doi.org/10.17504/protocols.io.abc/v2',
          anaesthesia: { object_type: 'Anaesthetic', anaesthetic_type: 'isoflurane', level: 1.5, duration: 90, duration_unit: 'minute' },
          procedures: [
            { object_type: 'Craniotomy', craniotomy_type: 'Dual hemisphere craniotomy' },
            {
              object_type: 'Injection',
              injection_materials: [{ object_type: 'Viral material', name: 'AAV-GCaMP', addgene_id: '12345', titer: 1e13, titer_unit: 'gc/mL' }],
            },
          ],
        },
      ],
    },
    data_description: {
      license: 'CC-BY-4.0',
      data_level: 'raw',
      project_name: 'Test Project',
      institution: { name: 'AIND' },
      modalities: [{ name: 'Behavior', abbreviation: 'behavior' }],
      investigators: [{ name: 'Jane Doe' }],
    },
    acquisition: {
      acquisition_type: 'Uncoupled Baiting',
      instrument_id: '323_11C',
      acquisition_start_time: '2026-07-08T14:04:44',
      acquisition_end_time: '2026-07-08T16:44:36',
      experimenters: [{ name: 'John Roe' }],
      ethics_review_id: ['2414'],
      data_streams: [
        {
          modalities: [{ name: 'Behavior' }],
          active_devices: ['Camera', 'Speaker'],
          code: [{ object_type: 'Code', name: 'aind-behavior', url: 'https://github.com/x', version: '1.2.3' }],
          configurations: [{ object_type: 'Speaker config', device_name: 'Stimulus Speaker' }],
        },
      ],
      stimulus_epochs: [
        {
          stimulus_name: 'go cue',
          performance_metrics: { trials_total: 697, trials_finished: 657, trials_rewarded: 299, reward_consumed_during_epoch: 986.7, reward_consumed_unit: 'microliter' },
        },
      ],
      subject_details: { mouse_platform_name: 'mouse_tube_foraging', animal_weight_post: 19.5, weight_unit: 'gram' },
    },
  };

  const star = extractStarMethods(record);

  it('KRT uses only the canonical Cell Press category headings, in order', () => {
    expect(star.krt.map((s) => s.title)).toEqual(KRT_CATEGORIES);
    // No custom/invented headings.
    expect(star.krt.some((s) => /procedures|protocols|instruments/i.test(s.title))).toBe(false);
  });

  it('KRT: organism row carries genotype, strain and a Subject ID identifier', () => {
    const rows = krtRows(star, 'Experimental models: Organisms/strains');
    expect(rows).toHaveLength(1);
    expect(rows[0].resource).toContain('Chat-IRES-Cre/wt');
    expect(rows[0].resource).toContain('C57BL/6J');
    expect(rows[0].identifier.text).toBe('Subject ID: 1');
  });

  it('KRT: viral material found at depth, formatted as an Addgene RRID', () => {
    const rows = krtRows(star, 'Bacterial and virus strains');
    expect(rows[0].resource).toBe('AAV-GCaMP');
    expect(rows[0].identifier.text).toContain('RRID:Addgene_12345');
  });

  it('KRT: anaesthetic listed as a chemical', () => {
    expect(krtRows(star, 'Chemicals, peptides, and recombinant proteins')[0].resource).toBe('isoflurane');
  });

  it('KRT: deposited data includes the S3 asset and other identifiers', () => {
    const rows = krtRows(star, 'Deposited data');
    expect(rows.some((r) => r.resource.startsWith('Raw data:'))).toBe(true);
    const co = rows.find((r) => r.identifier?.text === 'abc-123');
    expect(co.resource).toBe('Code Ocean identifier');
    expect(rows.some((r) => /this paper/i.test(r.resource))).toBe(false);
  });

  it('KRT: software with version; instruments/devices go under "Other"', () => {
    expect(krtRows(star, 'Software and algorithms').some((r) => r.resource === 'aind-behavior')).toBe(true);
    const other = krtRows(star, 'Other');
    expect(other.some((r) => r.resource === 'Instrument: 323_11C')).toBe(true);
    expect(other.some((r) => r.resource === 'Device: Camera')).toBe(true);
  });

  it('section 1: experimental model details incl. ethics protocol and computed age', () => {
    expect(factValue(star.model, 'Species')).toContain('Mus musculus');
    expect(factValue(star.model, 'Sex')).toBe('Female');
    expect(factValue(star.model, 'Date of birth')).toMatch(/age \d+ days/);
    expect(factValue(star.model, 'Housing')).toContain('cage 900');
    expect(factValue(star.model, 'Ethics review / IACUC protocol')).toContain('2414');
  });

  it('section 2: method details capture procedures (with nested) and streams', () => {
    const surgery = star.methodDetails.procedures.find((p) => p.name === 'Surgery');
    expect(surgery.detail).toContain('isoflurane');
    expect(surgery.detail).toContain('Craniotomy');
    expect(surgery.detail).toContain('Injection');
    expect(star.methodDetails.streams).toHaveLength(1);
    expect(star.methodDetails.instrument).toBe('323_11C');
  });

  it('section 3: quantification pulls performance metrics + subject measures', () => {
    const epoch = star.quantification.epochs[0];
    expect(epoch.metrics.find((m) => m.label === 'Trials (total)').value).toBe(697);
    expect(star.quantification.subject.some((m) => m.label === 'Weight post')).toBe(true);
  });

  it('section 4: additional resources expose protocol DOIs as resolvable links', () => {
    const r = star.additionalResources.find((x) => x.href);
    expect(r.href).toBe('https://dx.doi.org/10.17504/protocols.io.abc/v2');
  });

  it('does not throw on a nearly-empty record', () => {
    expect(() => extractStarMethods({})).not.toThrow();
    expect(() => extractStarMethods({ subject: null, procedures: null })).not.toThrow();
  });
});

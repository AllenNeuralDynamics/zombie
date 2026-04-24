/**
 * subject-view.test.js — Unit tests for pure helpers in subject-view.js.
 */

import { describe, it, expect } from 'vitest';
import { generateInfoHtml, organizeSubjectData } from '../subject/view.js';

// ---------------------------------------------------------------------------
// generateInfoHtml
// ---------------------------------------------------------------------------

describe('generateInfoHtml', () => {
  it('handles null gracefully', () => {
    const html = generateInfoHtml(null);
    expect(html).toContain('No subject data');
  });

  it('renders subject_id in the heading', () => {
    const html = generateInfoHtml({ subject_id: '804670', subject_details: {} });
    expect(html).toContain('804670');
  });

  it('renders sex, species, strain, genotype', () => {
    const html = generateInfoHtml({
      subject_id: '99',
      subject_details: {
        sex: 'Female',
        date_of_birth: '2024-01-01',
        species: { name: 'Mus musculus' },
        strain: { name: 'C57BL/6J' },
        genotype: 'Cre/wt',
        housing: { cage_id: 'C1', room_id: 'R2' },
      },
    });
    expect(html).toContain('Female');
    expect(html).toContain('Mus musculus');
    expect(html).toContain('C57BL/6J');
    expect(html).toContain('Cre/wt');
    expect(html).toContain('C1');
  });

  it('renders Unknown for all missing details', () => {
    const html = generateInfoHtml({ subject_id: '1' });
    // Should still render without throwing
    expect(html).toContain('Unknown');
  });
});

// ---------------------------------------------------------------------------
// organizeSubjectData
// ---------------------------------------------------------------------------

describe('organizeSubjectData', () => {
  it('returns empty bundle for empty records', () => {
    const bundle = organizeSubjectData([], '123');
    expect(bundle.subject).toEqual({});
    expect(bundle.procedures.subject_procedures).toEqual([]);
    expect(bundle.acquisitions).toEqual([]);
  });

  it('extracts subject from matching record', () => {
    const records = [
      { subject: { subject_id: '42', subject_details: { sex: 'Male' } } },
    ];
    const bundle = organizeSubjectData(records, '42');
    expect(bundle.subject.subject_id).toBe('42');
    expect(bundle.subject.subject_details.sex).toBe('Male');
  });

  it('ignores subject from non-matching record', () => {
    const records = [
      { subject: { subject_id: '99', subject_details: {} } },
    ];
    const bundle = organizeSubjectData(records, '42');
    expect(bundle.subject.subject_id).toBeUndefined();
  });

  it('collects procedures from multiple records', () => {
    const records = [
      {
        procedures: {
          subject_procedures: [{ object_type: 'Surgery', start_date: '2025-01-01' }],
          specimen_procedures: [],
        },
      },
      {
        procedures: {
          subject_procedures: [{ object_type: 'Headframe', start_date: '2024-06-01' }],
          specimen_procedures: [{ procedure_type: 'Fixation', start_date: '2025-02-01' }],
        },
      },
    ];
    const bundle = organizeSubjectData(records, '42');
    expect(bundle.procedures.subject_procedures).toHaveLength(2);
    expect(bundle.procedures.specimen_procedures).toHaveLength(1);
  });

  it('collects acquisitions', () => {
    const records = [
      {
        acquisition: {
          acquisition_start_time: '2025-06-01T10:00:00Z',
          acquisition_end_time: '2025-06-01T14:00:00Z',
        },
      },
      {
        acquisition: {
          // No start_time — should be skipped
          acquisition_end_time: '2025-06-02T14:00:00Z',
        },
      },
    ];
    const bundle = organizeSubjectData(records, '42');
    expect(bundle.acquisitions).toHaveLength(1);
  });

  it('excludes derived assets from acquisitions', () => {
    const records = [
      {
        name: 'raw-asset',
        data_description: { data_level: 'raw' },
        acquisition: {
          acquisition_start_time: '2025-06-01T10:00:00Z',
          acquisition_end_time: '2025-06-01T14:00:00Z',
        },
      },
      {
        name: 'derived-asset',
        data_description: { data_level: 'derived' },
        acquisition: {
          acquisition_start_time: '2025-06-01T10:00:00Z',
          acquisition_end_time: '2025-06-01T14:00:00Z',
        },
      },
      {
        name: 'no-level-asset',
        acquisition: {
          acquisition_start_time: '2025-06-02T10:00:00Z',
          acquisition_end_time: '2025-06-02T14:00:00Z',
        },
      },
    ];
    const bundle = organizeSubjectData(records, '42');
    expect(bundle.acquisitions).toHaveLength(2);
    expect(bundle.acquisitions.map((a) => a._assetName)).toEqual(['raw-asset', 'no-level-asset']);
  });

  it('uses first matching subject record only', () => {
    const records = [
      { subject: { subject_id: '42', subject_details: { sex: 'Male' } } },
      { subject: { subject_id: '42', subject_details: { sex: 'Female' } } },
    ];
    const bundle = organizeSubjectData(records, '42');
    // First one wins
    expect(bundle.subject.subject_details.sex).toBe('Male');
  });
});

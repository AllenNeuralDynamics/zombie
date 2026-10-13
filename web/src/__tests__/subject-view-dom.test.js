/**
 * subject-view-dom.test.js — Integration tests for createSubjectView DOM behaviour.
 *
 * Uses JSDOM so we can test the dropdown change → _loadSubject flow and the
 * timeline bubble click → onSelect → renderEventDetail flow.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/docdb.js', () => ({
  queryDocDb: vi.fn(),
}));

vi.mock('../lib/metadata.js', () => ({
  fetchAllSubjectIds: vi.fn(),
}));

import { queryDocDb } from '../lib/docdb.js';
import { fetchAllSubjectIds } from '../lib/metadata.js';
import { createSubjectView } from '../subject/view.js';

const MINIMAL_RECORD = (subjectId, assetName) => ({
  name: assetName,
  subject: {
    subject_id: subjectId,
    subject_details: { date_of_birth: '2020-01-01', sex: 'Male' },
  },
  procedures: { subject_procedures: [], specimen_procedures: [] },
  acquisition: {
    acquisition_start_time: '2024-01-01T10:00:00Z',
    acquisition_end_time: '2024-01-01T12:00:00Z',
    acquisition_type: 'Ephys',
  },
});

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('surgery restoration', () => {
  it('restores the event and tab and reports subsequent tab changes', async () => {
    vi.clearAllMocks();
    vi.stubGlobal('requestAnimationFrame', callback => { callback(); return 0; });
    const record = MINIMAL_RECORD('42', 'asset-42');
    record.procedures.subject_procedures = [{ object_type: 'Surgery', start_date: '2024-01-01', procedures: [{ object_type: 'Headframe', headframe_type: 'Test' }] }];
    queryDocDb.mockResolvedValue([record]);
    fetchAllSubjectIds.mockResolvedValue([]);
    const onTimelineSelect = vi.fn();
    const onSurgeryTabSelect = vi.fn();
    try {
      const view = createSubjectView({ subjectId: '42', embedded: true, initialSurgery: '2024-01-01T00:00:00.000Z~0', initialSurgeryTab: 'Headframe', onTimelineSelect, onSurgeryTabSelect });
      document.body.appendChild(view);
      await flushPromises();
      expect(onTimelineSelect).toHaveBeenCalledWith(expect.objectContaining({ type: 'Surgery' }), { surgeryKey: '2024-01-01T00:00:00.000Z~0' });
      const active = view.querySelector('.detail-tab-btn.active');
      expect(active?.textContent).toBe('Headframe');
      const overview = [...view.querySelectorAll('.detail-tab-btn')].find(button => button.textContent === 'Overview');
      overview.click();
      expect(onSurgeryTabSelect).toHaveBeenLastCalledWith('Overview');
    } finally {
      vi.unstubAllGlobals();
      document.body.innerHTML = '';
    }
  });
});

describe('createSubjectView — timeline click', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryDocDb.mockResolvedValue([MINIMAL_RECORD('42', 'my-asset_42')]);
    fetchAllSubjectIds.mockResolvedValue([]);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clicking a timeline bubble selects it (adds tl-bubble--selected class)', async () => {
    const view = createSubjectView({ subjectId: '42' });
    document.body.appendChild(view);
    await flushPromises();

    const bubbles = view.querySelectorAll('.tl-bubble');
    expect(bubbles.length).toBeGreaterThan(0);

    const first = bubbles[0];
    first.click();

    expect(first.classList.contains('tl-bubble--selected')).toBe(true);
  });

  it('clicking a bubble updates the detail panel', async () => {
    const view = createSubjectView({ subjectId: '42' });
    document.body.appendChild(view);
    await flushPromises();

    const detailContainer = view.querySelector('.subject-detail-container');
    expect(detailContainer.querySelector('.detail-placeholder')).not.toBeNull();

    const bubbles = view.querySelectorAll('.tl-bubble');
    bubbles[0].click();

    expect(detailContainer.querySelector('.detail-card')).not.toBeNull();
  });

  it('clicking a second bubble deselects the first', async () => {
    const twoRecords = [
      MINIMAL_RECORD('42', 'asset-a'),
      { ...MINIMAL_RECORD('42', 'asset-b'), acquisition: { acquisition_start_time: '2024-03-01T10:00:00Z', acquisition_end_time: '2024-03-01T12:00:00Z', acquisition_type: 'Behavior' } },
    ];
    queryDocDb.mockResolvedValue(twoRecords);

    const view = createSubjectView({ subjectId: '42' });
    document.body.appendChild(view);
    await flushPromises();

    const bubbles = view.querySelectorAll('.tl-bubble');
    if (bubbles.length < 2) return;

    bubbles[0].click();
    expect(bubbles[0].classList.contains('tl-bubble--selected')).toBe(true);

    bubbles[1].click();
    expect(bubbles[0].classList.contains('tl-bubble--selected')).toBe(false);
    expect(bubbles[1].classList.contains('tl-bubble--selected')).toBe(true);
  });

  it('shows Terminal Surgery label when surgery contains perfusion', async () => {
    queryDocDb.mockResolvedValue([
      {
        ...MINIMAL_RECORD('42', 'my-asset_42'),
        procedures: {
          subject_procedures: [
            {
              object_type: 'Surgery',
              start_date: '2024-01-02',
              procedures: [{ object_type: 'Perfusion' }],
            },
          ],
          specimen_procedures: [],
        },
      },
    ]);

    const view = createSubjectView({ subjectId: '42' });
    document.body.appendChild(view);
    await flushPromises();

    const labels = [...view.querySelectorAll('.tl-bubble-type')].map((el) => el.textContent);
    expect(labels).toContain('Terminal Surgery');

    const surgeryBubble = [...view.querySelectorAll('.tl-bubble')].find((el) =>
      el.querySelector('.tl-bubble-type')?.textContent === 'Terminal Surgery'
    );
    expect(surgeryBubble).toBeDefined();

    surgeryBubble.click();
    const heading = view.querySelector('.subject-detail-container .detail-card h4');
    expect(heading?.textContent).toBe('Terminal Surgery');
  });
});

describe('organizeSubjectData — unique procedures', () => {
  it('deduplicates identical subject procedures across records', async () => {
    const { organizeSubjectData } = await import('../subject/view.js');
    const proc = { object_type: 'Surgery', start_date: '2024-01-01' };
    const records = [
      { subject: { subject_id: '1' }, procedures: { subject_procedures: [proc], specimen_procedures: [] } },
      { subject: { subject_id: '1' }, procedures: { subject_procedures: [proc], specimen_procedures: [] } },
    ];
    const bundle = organizeSubjectData(records, '1');
    expect(bundle.procedures.subject_procedures).toHaveLength(1);
  });

  it('keeps distinct subject procedures', async () => {
    const { organizeSubjectData } = await import('../subject/view.js');
    const records = [
      { subject: { subject_id: '1' }, procedures: { subject_procedures: [{ object_type: 'Surgery', start_date: '2024-01-01' }], specimen_procedures: [] } },
      { subject: { subject_id: '1' }, procedures: { subject_procedures: [{ object_type: 'Headframe', start_date: '2024-02-01' }], specimen_procedures: [] } },
    ];
    const bundle = organizeSubjectData(records, '1');
    expect(bundle.procedures.subject_procedures).toHaveLength(2);
  });
});

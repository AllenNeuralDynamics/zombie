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

function makeFakeArrowResult(rows) {
  const fields = rows.length ? Object.keys(rows[0]).map((name) => ({ name })) : [];
  return {
    schema: { fields },
    numRows: rows.length,
    getChild(name) {
      return { get: (i) => rows[i]?.[name] ?? null };
    },
  };
}

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createSubjectView — dropdown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAllSubjectIds.mockResolvedValue(['123', '456', '789']);
    queryDocDb.mockResolvedValue([MINIMAL_RECORD('123', 'test-asset_123')]);
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a select element', () => {
    const view = createSubjectView({});
    document.body.appendChild(view);
    const select = view.querySelector('select');
    expect(select).not.toBeNull();
  });

  it('populates dropdown from fetchAllSubjectIds when coordinator is provided', async () => {
    const coord = { query: vi.fn().mockResolvedValue(makeFakeArrowResult([])) };
    const view = createSubjectView({ coordinator: coord });
    document.body.appendChild(view);
    await flushPromises();
    const options = [...view.querySelectorAll('select option')].map((o) => o.value);
    expect(options).toContain('123');
    expect(options).toContain('456');
  });

  it('changing the dropdown clears content and starts loading', async () => {
    queryDocDb.mockResolvedValue([MINIMAL_RECORD('456', 'test-asset_456')]);
    const view = createSubjectView({});
    document.body.appendChild(view);

    const opt = document.createElement('option');
    opt.value = '456';
    view.querySelector('select').appendChild(opt);

    const select = view.querySelector('select');
    const content = view.querySelector('.subject-content');

    select.value = '456';
    select.dispatchEvent(new Event('change'));

    expect(content.querySelector('.subject-loading')).not.toBeNull();

    await flushPromises();

    expect(queryDocDb).toHaveBeenCalledWith({ 'subject.subject_id': '456' }, expect.any(Object));
    expect(content.querySelector('.subject-info-card')).not.toBeNull();
  });

  it('changing dropdown a second time replaces content with new subject', async () => {
    queryDocDb
      .mockResolvedValueOnce([MINIMAL_RECORD('123', 'asset-123')])
      .mockResolvedValueOnce([MINIMAL_RECORD('456', 'asset-456')]);

    const view = createSubjectView({ subjectId: '123' });
    document.body.appendChild(view);
    await flushPromises();

    const content = view.querySelector('.subject-content');
    expect(content.textContent).toContain('123');

    const opt = document.createElement('option');
    opt.value = '456';
    view.querySelector('select').appendChild(opt);

    const select = view.querySelector('select');
    select.value = '456';
    select.dispatchEvent(new Event('change'));
    await flushPromises();

    expect(queryDocDb).toHaveBeenCalledTimes(2);
    expect(queryDocDb).toHaveBeenLastCalledWith({ 'subject.subject_id': '456' }, expect.any(Object));
    expect(content.querySelector('.subject-info-card')).not.toBeNull();
  });

  it('rapid dropdown changes abort stale loads and show the latest subject', async () => {
    let resolveFirst;
    const firstDone = new Promise((res) => { resolveFirst = res; });

    // Initial load for '123' blocks; second call for '789' resolves immediately.
    queryDocDb
      .mockImplementationOnce(() => firstDone)
      .mockResolvedValueOnce([MINIMAL_RECORD('789', 'asset-789')]);

    const view = createSubjectView({ subjectId: '123' });
    document.body.appendChild(view);

    const select = view.querySelector('select');
    const content = view.querySelector('.subject-content');

    const opt = document.createElement('option');
    opt.value = '789';
    select.appendChild(opt);

    // Change to '789' — aborts the still-pending '123' load.
    select.value = '789';
    select.dispatchEvent(new Event('change'));

    // Now resolve the stale '123' fetch — its result should be ignored.
    resolveFirst([MINIMAL_RECORD('123', 'asset-123')]);

    await flushPromises();
    await flushPromises();

    expect(content.querySelector('.subject-info-card')).not.toBeNull();
    expect(content.textContent).toContain('789');
    expect(content.textContent).not.toContain('123');
  });

  it('shows error banner when no records are found', async () => {
    queryDocDb.mockResolvedValue([]);
    const view = createSubjectView({ subjectId: '999' });
    document.body.appendChild(view);
    await flushPromises();

    const content = view.querySelector('.subject-content');
    expect(content.querySelector('.error-banner')).not.toBeNull();
  });

  it('shows error banner when queryDocDb rejects', async () => {
    queryDocDb.mockRejectedValue(new Error('network error'));
    const view = createSubjectView({ subjectId: '123' });
    document.body.appendChild(view);
    await flushPromises();

    const content = view.querySelector('.subject-content');
    expect(content.querySelector('.error-banner')).not.toBeNull();
    expect(content.textContent).toContain('network error');
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

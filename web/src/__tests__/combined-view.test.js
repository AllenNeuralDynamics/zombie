/**
 * combined-view.test.js — asset-only deep-link resolution.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../project/view.js', () => ({
  createProjectView: vi.fn(() => {
    const el = document.createElement('div');
    el.loadProject = vi.fn();
    el.highlightAsset = vi.fn();
    el.highlightSubject = vi.fn();
    return el;
  }),
}));

vi.mock('../subject/view.js', () => ({
  createSubjectView: vi.fn(() => {
    const el = document.createElement('div');
    el.loadSubject = vi.fn();
    return el;
  }),
}));

vi.mock('../lib/arrow.js', () => ({
  queryRows: vi.fn(),
}));

import { queryRows } from '../lib/arrow.js';
import { createSubjectView } from '../subject/view.js';
import { createCombinedView } from '../combined/view.js';

function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createCombinedView — asset-only deep links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/view?asset=asset-only');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves the subject from asset_basics and syncs subject_id into the URL', async () => {
    queryRows.mockResolvedValue([{ subject_id: '713655' }]);

    const root = createCombinedView({ coordinator: {} });
    document.body.appendChild(root);
    await flushPromises();

    expect(queryRows).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("WHERE name = 'asset-only'"),
    );
    const subjectView = createSubjectView.mock.results[0].value;
    expect(subjectView.loadSubject).toHaveBeenCalledWith('713655', {
      acquisitionName: 'asset-only',
    });
    expect(new URL(window.location.href).searchParams.get('subject_id')).toBe('713655');
    expect(new URL(window.location.href).searchParams.get('asset')).toBe('asset-only');
  });
});

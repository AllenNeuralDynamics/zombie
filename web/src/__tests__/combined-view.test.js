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
import { createProjectView } from '../project/view.js';
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
    queryRows.mockResolvedValue([{ subject_id: '713655', project_name: null }]);

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

describe('createCombinedView — project name from an asset deep link', () => {
  const ASSET = '427836_2019-04-24_13-06-45_filtered_2026-04-09_08-20-51';
  const PROJECT = 'V1 deep dive';

  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', `/view?asset=${ASSET}`);
  });

  afterEach(() => { document.body.innerHTML = ''; });

  const sections = (root) => [...root.querySelectorAll('.combined-section')];
  const projectSection = (root) => sections(root)[0];
  const detailText = (section) =>
    section.querySelector('.combined-section-detail')?.textContent ?? '';

  it('names the asset project but leaves the section collapsed', async () => {
    queryRows.mockResolvedValue([{ subject_id: '427836', project_name: PROJECT }]);

    const root = createCombinedView({ coordinator: {} });
    document.body.appendChild(root);
    await flushPromises();

    const project = projectSection(root);
    expect(detailText(project)).toBe(PROJECT);
    expect(project.open).toBe(false);
    // Naming it must not load it, nor put it in the URL.
    const projectView = createProjectView.mock.results[0].value;
    expect(projectView.loadProject).not.toHaveBeenCalled();
    expect(new URL(window.location.href).searchParams.get('project')).toBe(null);
  });

  it('loads the resolved project on first expand', async () => {
    queryRows.mockResolvedValue([{ subject_id: '427836', project_name: PROJECT }]);

    const root = createCombinedView({ coordinator: {} });
    document.body.appendChild(root);
    await flushPromises();

    const project = projectSection(root);
    project.open = true;
    project.dispatchEvent(new Event('toggle'));

    const projectView = createProjectView.mock.results[0].value;
    expect(projectView.loadProject).toHaveBeenCalledWith(PROJECT);
    expect(new URL(window.location.href).searchParams.get('project')).toBe(PROJECT);
  });

  it('opens the project section when ?project= is given', () => {
    window.history.replaceState({}, '', `/view?project=${encodeURIComponent(PROJECT)}`);
    const root = createCombinedView({ coordinator: {} });
    document.body.appendChild(root);
    expect(projectSection(root).open).toBe(true);
    expect(detailText(projectSection(root))).toBe(PROJECT);
  });

  it('does not let the asset project override an explicit ?project=', async () => {
    window.history.replaceState({}, '', `/view?project=Explicit&asset=${ASSET}`);
    queryRows.mockResolvedValue([{ subject_id: '427836', project_name: PROJECT }]);

    const root = createCombinedView({ coordinator: {} });
    document.body.appendChild(root);
    await flushPromises();

    expect(detailText(projectSection(root))).toBe('Explicit');
  });

  it('stays collapsed and unnamed when the asset is not in asset_basics', async () => {
    queryRows.mockResolvedValue([]);

    const root = createCombinedView({ coordinator: {} });
    document.body.appendChild(root);
    await flushPromises();

    const subjectView = createSubjectView.mock.results[0].value;
    expect(subjectView.loadSubject).not.toHaveBeenCalled();
    expect(detailText(projectSection(root))).toBe('');
    expect(projectSection(root).open).toBe(false);
  });
});

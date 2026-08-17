/**
 * contributions-edit-page.test.js — Access-gating tests for the contributions
 * edit page (EditApp).
 *
 * These cover the decision that determines whether a project is treated as
 * NEW (auto-created, creator registered as admin) or EXISTING (loaded), which
 * is the logic that was silently failing for admins opening a fresh project.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocked collaborators — declared before importing the module under test.
vi.mock('../lib/auth.js', () => ({
  getCurrentUser: vi.fn(),
  loginWithOrcid: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../contributions/fetch.js', () => ({
  fetchContributions: vi.fn(),
}));

vi.mock('../contributions/view.js', () => ({
  createContributionsView: vi.fn(() => {
    const el = document.createElement('div');
    el.className = 'mock-editor';
    return el;
  }),
}));

import { getCurrentUser } from '../lib/auth.js';
import { fetchContributions } from '../contributions/fetch.js';
import { createContributionsView } from '../contributions/view.js';
import { createContributionsEditPage } from '../contributions/edit-page.js';

/** Build a fake Response-like object. */
function res(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Flush queued microtasks AND macrotasks so Preact `useEffect` callbacks (and
 * the async access chain they trigger) run to completion.
 */
async function flush() {
  for (let i = 0; i < 15; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Mount the edit page for a doi and let effects settle. */
async function mount(doi) {
  const el = createContributionsEditPage({ doi });
  document.body.appendChild(el);
  await flush();
  return el;
}

/** Route fetchContributions responses by URL. */
function routeFetch({ access, get }) {
  fetchContributions.mockImplementation((url) => {
    if (url.includes('/contributions/access')) return Promise.resolve(access);
    if (url.includes('/contributions/get')) return Promise.resolve(get);
    return Promise.resolve(res(200, {}));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('EditApp — access gating', () => {
  it('shows the login gate when not authenticated', async () => {
    getCurrentUser.mockResolvedValue(null);
    const el = await mount('some-project');
    expect(el.querySelector('.cv-modal-title')?.textContent).toContain('Log in');
    expect(createContributionsView).not.toHaveBeenCalled();
  });

  it('mounts the editor for an admin of an EXISTING project (isNew=false)', async () => {
    getCurrentUser.mockResolvedValue({ orcid: '0000', name: 'Dan' });
    routeFetch({
      access: res(200, { is_admin: true }),
      get: res(200, { project_name: 'existing', contributors: [] }),
    });
    await mount('existing');
    expect(createContributionsView).toHaveBeenCalledTimes(1);
    expect(createContributionsView).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'existing', isAdmin: true, isNew: false }),
    );
  });

  it('mounts the editor as NEW for an admin opening a non-existent project (isNew=true)', async () => {
    // This is the regression: a global admin gets is_admin:true, but the
    // project does not exist yet, so it must be created — not loaded.
    getCurrentUser.mockResolvedValue({ orcid: '0000', name: 'Dan' });
    routeFetch({
      access: res(200, { is_admin: true }),
      get: res(404, { error: 'not found' }),
    });
    await mount('dan-test2');
    expect(createContributionsView).toHaveBeenCalledTimes(1);
    expect(createContributionsView).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'dan-test2', isAdmin: true, isNew: true }),
    );
  });

  it('mounts the editor as NEW for a non-admin creator of a fresh project', async () => {
    getCurrentUser.mockResolvedValue({ orcid: '0000', name: 'Dan' });
    routeFetch({
      access: res(200, { is_admin: false }),
      get: res(404, { error: 'not found' }),
    });
    await mount('brand-new');
    expect(createContributionsView).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: 'brand-new', isAdmin: true, isNew: true }),
    );
  });

  it('denies a non-admin on an EXISTING project (no editor)', async () => {
    getCurrentUser.mockResolvedValue({ orcid: '0000', name: 'Dan' });
    routeFetch({
      access: res(200, { is_admin: false }),
      get: res(200, { project_name: 'existing', contributors: [] }),
    });
    const el = await mount('existing');
    expect(createContributionsView).not.toHaveBeenCalled();
    expect(el.querySelector('.cv-modal-title')?.textContent).toContain('No access');
  });
});

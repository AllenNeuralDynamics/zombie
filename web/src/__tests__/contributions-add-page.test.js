/**
 * contributions-add-page.test.js — Tests for the self-service add wizard
 * (AddApp), covering the author-supplied contact email: it must prefill from
 * the stored record, stay editable, and reach the saved payload.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/auth.js', () => ({
  getCurrentUser: vi.fn(),
  loginWithOrcid: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../lib/local-dev.js', () => ({
  isLocalDevelopment: vi.fn(() => false),
}));

import { getCurrentUser } from '../lib/auth.js';
import { isLocalDevelopment } from '../lib/local-dev.js';
import { createContributionsAddPage } from '../contributions/add-page.js';

/** Flush microtasks + macrotasks so Preact effects and fetches settle. */
async function flush() {
  for (let i = 0; i < 15; i += 1) await new Promise((r) => setTimeout(r, 0));
}

const STORED = {
  project_name: 'proj',
  contributors: [
    {
      author: {
        name: 'Alice Smith',
        registry_identifier: '0000-0001',
        email: 'alice@example.org',
      },
      credit_levels: [{ role: 'software', level: 'lead' }],
      is_admin: true,
    },
    {
      author: { name: 'Bob Jones', email: 'bob@example.org' },
      credit_levels: [],
    },
  ],
};

function mockFetch() {
  global.fetch = vi.fn().mockImplementation((url, opts = {}) => {
    if ((opts.method || 'GET') === 'POST') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ commit: 'abc1234567' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => STORED });
  });
}

/** Mount the wizard as Alice (matched by ORCID → lands on the full editor). */
async function mountAsAlice() {
  getCurrentUser.mockResolvedValue({ orcid: '0000-0001', name: 'Alice Smith' });
  mockFetch();
  const el = createContributionsAddPage({ project: 'proj' });
  document.body.appendChild(el);
  await flush();
  return el;
}

beforeEach(() => {
  vi.clearAllMocks();
  isLocalDevelopment.mockReturnValue(false);
  localStorage.clear();
  document.body.innerHTML = '';
  document.cookie = '';
});

describe('AddApp — author email', () => {
  it('skips the login gate on localhost development', async () => {
    isLocalDevelopment.mockReturnValue(true);
    mockFetch();

    const el = createContributionsAddPage({ project: 'proj' });
    document.body.appendChild(el);
    await flush();

    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(el.querySelector('.cv-modal-title')).toBeNull();
    expect(el.querySelector('.cv-wizard-step-title')).not.toBeNull();
  });

  it('keeps local self-service edits in preview without posting to the service', async () => {
    isLocalDevelopment.mockReturnValue(true);
    mockFetch();

    const el = createContributionsAddPage({ project: 'proj', author: 'Alice Smith' });
    document.body.appendChild(el);
    await flush();

    const saveButton = [...el.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Local preview');
    expect(saveButton).toBeDefined();
    expect(saveButton.disabled).toBe(true);
    saveButton.disabled = false;
    saveButton.click();
    await flush();
    expect(global.fetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('uses the shared author sections while keeping admin-only author level hidden', async () => {
    const el = await mountAsAlice();
    const editor = el.querySelector('.cv-author-editor');
    expect(editor.textContent).toContain('Profile');
    expect(editor.textContent).toContain('Roles & details');
    expect(editor.textContent).toContain('Sections');
    expect(editor.querySelector('#cwe-name')).not.toBeNull();
    expect(editor.querySelector('#cwe-orcid')).not.toBeNull();
    expect(editor.querySelector('#cwe-join-date')).not.toBeNull();
    expect(editor.querySelector('#cwe-leave-date')).not.toBeNull();
    expect(editor.querySelector('#cwe-author-level')).toBeNull();
    expect(editor.querySelector('[aria-label="Software description"]')).not.toBeNull();
  });

  it('prefills the email stored on the visitor’s own contributor record', async () => {
    const el = await mountAsAlice();
    expect(el.querySelector('#cwe-email').value).toBe('alice@example.org');
  });

  it('saves an edited email onto the visitor’s author record', async () => {
    const el = await mountAsAlice();
    const input = el.querySelector('#cwe-email');
    input.value = 'alice.smith@allen.org';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    el.querySelector('.cv-wizard-nav .btn-primary')?.click();
    await flush();

    const postCall = global.fetch.mock.calls.find(
      ([, opts]) => (opts?.method || 'GET') === 'POST',
    );
    expect(postCall).toBeDefined();
    const payload = JSON.parse(postCall[1].body);
    expect(postCall[0]).toContain('/contributions/author?project=proj');
    expect(payload.author.name).toBe('Alice Smith');
    expect(payload.author.email).toBe('alice.smith@allen.org');
  });

  it('sends only the edited author, leaving project preservation to the server', async () => {
    const el = await mountAsAlice();
    el.querySelector('.cv-wizard-nav .btn-primary')?.click();
    await flush();

    const postCall = global.fetch.mock.calls.find(
      ([, opts]) => (opts?.method || 'GET') === 'POST',
    );
    const payload = JSON.parse(postCall[1].body);
    expect(payload).not.toHaveProperty('contributors');
    expect(payload.author.name).toBe('Alice Smith');
    expect(payload.author.email).toBe('alice@example.org');
    expect(JSON.stringify(payload)).not.toContain('Bob Jones');
  });

  it('sets the entered name to the selected ORCID public name', async () => {
    getCurrentUser.mockResolvedValue({ orcid: '0000-0002-1825-0097', name: 'Jane Example' });
    const project = {
      project_name: 'proj',
      contributors: [{ author: { name: 'Project Admin', registry_identifier: '0000-0002' }, is_admin: true }],
    };
    global.fetch = vi.fn().mockImplementation((url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/contributions/orcid/search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ results: [
            { orcid: '0000-0002-1825-0097', name: 'Jane Canonical' },
          ] }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => project });
    });

    const el = createContributionsAddPage({ project: 'proj' });
    document.body.appendChild(el);
    await flush();
    [...el.querySelectorAll('button')].find((button) => button.textContent.includes('Search ORCID')).click();
    await flush();
    [...el.querySelectorAll('button')].find((button) => button.textContent.includes('Use ORCID name')).click();
    await flush();

    expect(el.querySelector('#cw-name').value).toBe('Jane Canonical');
    expect(el.querySelector('#cw-orcid').value).toBe('0000-0002-1825-0097');
  });

  it('shows the public name in the shared modal when an ORCID iD is pasted', async () => {
    getCurrentUser.mockResolvedValue({ orcid: '0000-0002-1825-0097', name: 'Jane Example' });
    const project = {
      project_name: 'proj',
      contributors: [{ author: { name: 'Project Admin', registry_identifier: '0000-0002' }, is_admin: true }],
    };
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes('/contributions/orcid/profile')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ orcid: '0000-0002-1825-0097', name: 'Jane Canonical' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => project });
    });

    const el = createContributionsAddPage({ project: 'proj' });
    document.body.appendChild(el);
    await flush();
    const orcidInput = el.querySelector('#cw-orcid');
    orcidInput.value = '0000-0002-1825-0097';
    orcidInput.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    expect(el.querySelector('[role="dialog"]').textContent).toContain('Jane Canonical');
    expect(el.querySelector('[role="dialog"]').textContent).toContain('Confirm ORCID identity');
    [...el.querySelectorAll('button')].find((button) => button.textContent.includes('Use ORCID name')).click();
    await flush();
    expect(el.querySelector('#cw-name').value).toBe('Jane Canonical');
  });

  it('asks before linking a fuzzy-matched unlinked contributor record', async () => {
    getCurrentUser.mockResolvedValue({ orcid: '0000-0007', name: 'Carol Smith' });
    const project = {
      project_name: 'proj',
      contributors: [
        {
          author: { name: 'Project Admin', registry_identifier: '0000-0002' },
          credit_levels: [],
          is_admin: true,
        },
        {
          author: { name: 'Carol Smyth', affiliation: ['AIND'] },
          credit_levels: [{ role: 'software', level: 'lead' }],
          is_admin: false,
        },
      ],
    };
    global.fetch = vi.fn().mockImplementation((url, options = {}) => {
      if ((options.method || 'GET') === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ commit: 'linked123' }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => project });
    });

    const el = createContributionsAddPage({ project: 'proj' });
    document.body.appendChild(el);
    await flush();
    expect(el.querySelector('[role="dialog"]').textContent).toContain('Is this your contributor record?');
    expect(el.querySelector('[role="dialog"]').textContent).toContain('Carol Smyth');

    [...el.querySelectorAll('button')].find((button) => button.textContent.includes('Link this record')).click();
    await flush();

    const linkCall = global.fetch.mock.calls.find(([url]) => String(url).includes('/contributions/author/link'));
    expect(linkCall).toBeDefined();
    expect(JSON.parse(linkCall[1].body)).toEqual({ author_name: 'Carol Smyth' });
    expect(el.querySelector('#cwe-name').value).toBe('Carol Smyth');
    expect(el.querySelector('#cwe-orcid').value).toBe('0000-0007');
    expect(el.querySelector('[role="dialog"]')).toBeNull();
  });

  it('prevents ORCID resolution from creating a duplicate contributor name', async () => {
    const orcid = '0000-0002-1825-0097';
    getCurrentUser.mockResolvedValue({ orcid, name: 'Carol Smith' });
    const project = {
      project_name: 'proj',
      contributors: [
        { author: { name: 'Project Admin', registry_identifier: '0000-0002' }, is_admin: true },
        { author: { name: 'Carol Smith' }, credit_levels: [], is_admin: false },
      ],
    };
    global.fetch = vi.fn().mockImplementation((url) => {
      if (String(url).includes('/contributions/orcid/profile')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ orcid, name: 'Carol Smith' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => project });
    });

    const el = createContributionsAddPage({ project: 'proj' });
    document.body.appendChild(el);
    await flush();
    [...el.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Continue as a new contributor')).click();
    await flush();
    const input = el.querySelector('#cw-orcid, #cwe-orcid');
    input.value = orcid;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    [...el.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Use ORCID name')).click();
    await flush();

    expect(el.querySelector('[role="alert"]').textContent)
      .toContain('A contributor with this name is already listed');
  });
});

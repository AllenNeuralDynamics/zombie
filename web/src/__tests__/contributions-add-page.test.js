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

import { getCurrentUser } from '../lib/auth.js';
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
  localStorage.clear();
  document.body.innerHTML = '';
  document.cookie = '';
});

describe('AddApp — author email', () => {
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
});

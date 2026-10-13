import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ instances: [] }));

vi.mock('@azure/msal-browser', () => ({
  PublicClientApplication: class MockPublicClientApplication {
    constructor(config) {
      this.config = config;
      state.instances.push(this);
    }

    initialize() { return Promise.resolve(); }
    handleRedirectPromise() { return Promise.resolve(null); }
    getActiveAccount() { return null; }
    getAllAccounts() { return []; }
  },
}));

vi.mock('../constants.js', () => ({
  QC_AUTH_REDIRECT_URI: '/auth/callback',
  QC_SPA_CLIENT_ID: 'client-id',
  QC_SPA_TENANT_ID: 'tenant-id',
}));

import { initQcAuth } from '../lib/qc-spa-auth.js';

describe('QC SPA auth', () => {
  it('keeps the MSAL account cache available across page contexts', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } });
    await initQcAuth();

    expect(state.instances).toHaveLength(1);
    expect(state.instances[0].config.cache.cacheLocation).toBe('localStorage');
  });
});

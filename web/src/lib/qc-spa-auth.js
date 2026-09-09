/** MSAL browser auth isolated from the QC portal's existing auth flows. */

import { PublicClientApplication } from '@azure/msal-browser';
import {
  QC_AUTH_REDIRECT_URI,
  QC_SPA_CLIENT_ID,
  QC_SPA_TENANT_ID,
} from '../constants.js';

const RETURN_PATH_KEY = 'qc-spa-return-path';
// Request only sign-in plus standard OIDC profile claims so the editor can
// show the user's human display name. Do not request email, offline_access,
// Graph, or a custom API permission: tenant membership is the authorization boundary.
const OIDC_SCOPES = ['openid', 'profile'];
let client = null;
let initPromise = null;

function authConfig() {
  if (!QC_SPA_CLIENT_ID || !QC_SPA_TENANT_ID) return null;
  return {
    auth: {
      clientId: QC_SPA_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${QC_SPA_TENANT_ID}`,
      redirectUri: QC_AUTH_REDIRECT_URI,
      postLogoutRedirectUri: window.location.origin + '/quality_control',
      protocolMode: 'OIDC',
      OIDCOptions: { defaultScopes: OIDC_SCOPES },
    },
    cache: { cacheLocation: 'sessionStorage' },
  };
}

/** Return a same-origin path, never an arbitrary redirect URL. */
export function safeQcReturnPath(path, fallback = '/quality_control') {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return fallback;
  try {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}

export async function initQcAuth() {
  if (initPromise) return initPromise;
  const config = authConfig();
  if (!config) return null;
  client = new PublicClientApplication(config);
  initPromise = client.initialize().then(async () => {
    const result = await client.handleRedirectPromise();
    if (result?.account) client.setActiveAccount(result.account);
    if (!client.getActiveAccount() && client.getAllAccounts()[0]) {
      client.setActiveAccount(client.getAllAccounts()[0]);
    }
    return result;
  });
  return initPromise;
}

export async function getQcAccount() {
  await initQcAuth();
  const account = client?.getActiveAccount() ?? client?.getAllAccounts()[0] ?? null;
  if (!client || !account) return null;

  // Refresh the cached account's standard profile claims when possible. This
  // also upgrades sessions created before the profile scope was requested.
  try {
    const result = await client.acquireTokenSilent({ account, scopes: OIDC_SCOPES });
    if (result?.account || result?.idTokenClaims) {
      return {
        ...account,
        ...(result.account || {}),
        idTokenClaims: result.idTokenClaims || result.account?.idTokenClaims || account.idTokenClaims,
      };
    }
  } catch {
    // The cached account is still a valid signed-in state if silent refresh is unavailable.
  }
  return account;
}

export async function loginForQc(nextPath = window.location.pathname + window.location.search) {
  await initQcAuth();
  if (!client) throw new Error('QC SPA authentication is not configured');
  sessionStorage.setItem(RETURN_PATH_KEY, safeQcReturnPath(nextPath));
  await client.loginRedirect({ scopes: OIDC_SCOPES });
}

/** Return the signed Entra identity token for the configured client application. */
export async function getQcIdentityToken({ forceRefresh = false } = {}) {
  await initQcAuth();
  const account = await getQcAccount();
  if (!client || !account) throw new Error('Log in to edit QC');
  const result = await client.acquireTokenSilent({
    account,
    scopes: OIDC_SCOPES,
    forceRefresh,
  });
  if (!result.idToken) throw new Error('Entra login did not return an identity token');
  return result.idToken;
}

export async function logoutQc() {
  await initQcAuth();
  if (client) await client.logoutRedirect();
}

export function consumeQcReturnPath() {
  const value = sessionStorage.getItem(RETURN_PATH_KEY);
  sessionStorage.removeItem(RETURN_PATH_KEY);
  return safeQcReturnPath(value);
}

/**
 * auth.js — ORCID login helpers for the contributions pages.
 *
 * Authentication is handled by the aind-metadata-viz backend via OpenID
 * Connect (ORCID). The backend issues a signed session cookie; the frontend
 * only needs to (a) send the user to the login endpoint and (b) read back who
 * is logged in. Every authenticated request must include credentials so the
 * session cookie is sent.
 */

import { CONTRIBUTIONS_API_BASE } from '../constants.js';

/**
 * Return the current logged-in user, or null if not authenticated.
 * @returns {Promise<{orcid:string,name:?string,is_admin:boolean}|null>}
 */
export async function getCurrentUser() {
  try {
    const res = await fetch(`${CONTRIBUTIONS_API_BASE}/auth/me`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Redirect the browser to ORCID to log in. After login the backend returns
 * the user to `nextUrl` (defaults to the current page).
 * @param {string} [nextUrl]
 */
export function loginWithOrcid(nextUrl) {
  const next = nextUrl || window.location.href;
  const url = `${CONTRIBUTIONS_API_BASE}/auth/orcid/login?next=${encodeURIComponent(next)}`;
  window.location.assign(url);
}

/** Log the current user out, then run `onDone` (optional). */
export async function logout(onDone) {
  try {
    await fetch(`${CONTRIBUTIONS_API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch (_) {
    /* ignore */
  }
  if (onDone) onDone();
}

/**
 * Join a project using an invite token (grants permanent edit membership).
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function joinProject(project, token) {
  try {
    const res = await fetch(
      `${CONTRIBUTIONS_API_BASE}/contributions/join`
        + `?project=${encodeURIComponent(project)}&token=${encodeURIComponent(token)}`,
      { method: 'POST', credentials: 'include' },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || `Join failed (${res.status})` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

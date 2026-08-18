/**
 * qc-auth.js — QC-portal login helpers for the /migrate pages.
 *
 * The mirror image of `lib/auth.js` (ORCID login for the contributions pages).
 * The QC portal issues an HttpOnly session cookie on
 * `.allenneuraldynamics.org`, so the frontend only needs to (a) send the user
 * to the login endpoint and (b) read back who is logged in. Every
 * authenticated request just needs `credentials: 'include'` — there is no
 * token to read, stash, or attach.
 *
 * See METADATA-AUTH.md in aind-qc-portal.
 */

import { QC_PORTAL_BASE } from '../constants.js';

/**
 * Return the logged-in QC-portal user, or null if not authenticated.
 * @returns {Promise<{user:string}|null>}
 */
export async function getQcUser() {
  try {
    const res = await fetch(`${QC_PORTAL_BASE}/metadata/me`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/**
 * Send the browser to the QC portal to log in. The portal establishes the
 * cross-subdomain session (bouncing through its own OAuth login first if
 * needed) and returns here.
 * @param {string} [nextUrl] Absolute https URL to come back to.
 */
export function loginToQcPortal(nextUrl) {
  const next = nextUrl || window.location.href;
  window.location.assign(`${QC_PORTAL_BASE}/metadata/login?redirect=${encodeURIComponent(next)}`);
}

/** Clear the QC-portal session cookie, then run `onDone` (optional). */
export async function logoutQcPortal(onDone) {
  try {
    await fetch(`${QC_PORTAL_BASE}/metadata/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch (_) {
    /* ignore */
  }
  if (onDone) onDone();
}

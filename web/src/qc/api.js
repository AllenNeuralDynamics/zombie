import { QC_API_BASE } from '../constants.js';
import { getQcIdentityToken } from '../lib/qc-spa-auth.js';

export class QcApiError extends Error {
  constructor(status, code, detail = '') {
    super(detail || code || `QC API request failed (${status})`);
    this.name = 'QcApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

async function readResponse(response) {
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON upstream failure */ }
  if (response.ok) return body ?? {};
  throw new QcApiError(response.status, body?.error ?? 'request_failed', body?.detail ?? '');
}

/** POST one narrow QC edit request, retrying once after identity-token renewal on 401. */
export async function submitQcEdit(payload, { fetchImpl = fetch } = {}) {
  let token = await getQcIdentityToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetchImpl(`${QC_API_BASE}/api/qc/submit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    try {
      return await readResponse(response);
    } catch (error) {
      if (error instanceof QcApiError && error.status === 401 && attempt === 0) {
        token = await getQcIdentityToken({ forceRefresh: true });
        continue;
      }
      throw error;
    }
  }
  throw new QcApiError(401, 'unauthenticated');
}

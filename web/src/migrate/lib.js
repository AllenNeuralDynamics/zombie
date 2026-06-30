/**
 * migrate/lib.js — Shared helpers + components for the /migrate/* pages.
 *
 * Pure helpers (canonicalJson, deepEqual, diffJson, …) are exported for
 * unit testing. Network helpers wrap DocDB queries and the internal
 * aind-metadata-service, with a 24h localStorage cache on service responses.
 */

import { html } from 'htm/preact';
import { queryDocDb } from '../lib/docdb.js';

export const DOCDB_BASES = {
  v1: 'https://api.allenneuraldynamics.org/v1/metadata_index/data_assets',
  v2: 'https://api.allenneuraldynamics.org/v2/metadata_index/data_assets',
};

const METADATA_SERVICE_BASE = 'https://aind-metadata-service';
export const METADATA_SERVICE_PATHS = {
  v1: {
    subject: (id) => `${METADATA_SERVICE_BASE}/subject/${encodeURIComponent(id)}`,
    procedures: (id) => `${METADATA_SERVICE_BASE}/procedures/${encodeURIComponent(id)}`,
    funding: (id) => `${METADATA_SERVICE_BASE}/funding/${encodeURIComponent(id)}`,
    // v1 has no /investigators endpoint — the investigator list is embedded in
    // the funding response as a comma-separated string, so we fetch funding and
    // derive it in normalizeServiceSection().
    investigators: (id) => `${METADATA_SERVICE_BASE}/funding/${encodeURIComponent(id)}`,
  },
  v2: {
    subject: (id) => `${METADATA_SERVICE_BASE}/api/v2/subject/${encodeURIComponent(id)}`,
    procedures: (id) => `${METADATA_SERVICE_BASE}/api/v2/procedures/${encodeURIComponent(id)}`,
    funding: (id) => `${METADATA_SERVICE_BASE}/api/v2/funding/${encodeURIComponent(id)}`,
    investigators: (id) => `${METADATA_SERVICE_BASE}/api/v2/investigators/${encodeURIComponent(id)}`,
  },
};

export const ENDPOINTS = ['subject', 'procedures', 'funding', 'investigators'];
export const DB_VERSIONS = ['v1', 'v2'];

/**
 * Per-endpoint configuration:
 *   lookup     — which record field identifies the asset for the metadata
 *                service ('subject' → subject.subject_id, 'project' →
 *                data_description.project_name).
 *   targetPath — where in the DocDB record the candidate value lives. subject
 *                and procedures are top-level sections; funding and
 *                investigators are nested sub-fields of data_description.
 */
export const ENDPOINT_CONFIG = {
  subject: { lookup: 'subject', targetPath: ['subject'] },
  procedures: { lookup: 'subject', targetPath: ['procedures'] },
  funding: { lookup: 'project', targetPath: ['data_description', 'funding_source'] },
  investigators: { lookup: 'project', targetPath: ['data_description', 'investigators'] },
};

/** Read the identifier the metadata service expects for a given endpoint. */
export function lookupIdForEndpoint(record, endpoint) {
  const cfg = ENDPOINT_CONFIG[endpoint];
  if (!cfg) return null;
  return cfg.lookup === 'project'
    ? record?.data_description?.project_name ?? null
    : record?.subject?.subject_id ?? null;
}

/** Human label for the lookup field, used in error messages. */
export function lookupLabelForEndpoint(endpoint) {
  return ENDPOINT_CONFIG[endpoint]?.lookup === 'project'
    ? 'data_description.project_name'
    : 'subject.subject_id';
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit testing
// ---------------------------------------------------------------------------

export function readCookie(name) {
  const parts = (document.cookie || '').split('; ');
  for (const part of parts) {
    if (part.startsWith(`${name}=`)) return decodeURIComponent(part.slice(name.length + 1));
  }
  return null;
}

/** Clear the QC-portal auth cookies locally. The cookies are set on
 * `.allenneuraldynamics.org`, so we have to delete them with the matching
 * Domain attribute (an undated attempt without Domain is also issued in case
 * a previous deploy set them host-only). Used after the QC portal returns
 * `401 invalid_token` so the UI reverts to the "Validate token" flow.
 */
export function clearAuthCookies() {
  const names = ['qc_auth_token', 'qc_auth_token_expires_at'];
  const expired = 'expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
  for (const name of names) {
    document.cookie = `${name}=; ${expired}; domain=.allenneuraldynamics.org; secure; samesite=none`;
    document.cookie = `${name}=; ${expired}`;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  return canonicalJson(a) === canonicalJson(b);
}

export function extractServicePayload(resp, db) {
  if (!resp || typeof resp !== 'object') {
    throw new Error('Empty response from metadata service');
  }
  if (db === 'v1') {
    if ('data' in resp) {
      if (resp.data == null) {
        const msg = resp.message || 'Metadata service returned no data';
        throw new Error(msg);
      }
      return resp.data;
    }
    return resp;
  }
  if (resp.detail && typeof resp.detail === 'string' && Object.keys(resp).length === 1) {
    throw new Error(resp.detail);
  }
  return resp;
}

export function diffJson(oldVal, newVal, path = []) {
  if (deepEqual(oldVal, newVal)) return [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  if (isObj(oldVal) && isObj(newVal)) {
    const out = [];
    const keys = new Set([...Object.keys(oldVal), ...Object.keys(newVal)]);
    const sorted = [...keys].sort();
    for (const k of sorted) {
      out.push(...diffJson(oldVal[k], newVal[k], [...path, k]));
    }
    return out;
  }

  if (Array.isArray(oldVal) && Array.isArray(newVal) && oldVal.length === newVal.length) {
    const out = [];
    for (let i = 0; i < oldVal.length; i++) {
      out.push(...diffJson(oldVal[i], newVal[i], [...path, `[${i}]`]));
    }
    return out;
  }

  const pathStr = path.join('.') || '(root)';
  if (oldVal === undefined) return [{ path: pathStr, kind: 'added', oldValue: undefined, newValue: newVal }];
  if (newVal === undefined) return [{ path: pathStr, kind: 'removed', oldValue: oldVal, newValue: undefined }];
  return [{ path: pathStr, kind: 'changed', oldValue: oldVal, newValue: newVal }];
}

export function formatDiffValue(v) {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}

export function buildMergedRecord(currentRecord, section, newValue) {
  if (!currentRecord) return null;
  return { ...currentRecord, [section]: newValue };
}

/** Read a nested value by path array, returning undefined if any hop is absent. */
export function getAtPath(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Immutably set a nested value by path array, cloning each level on the way down. */
export function setAtPath(obj, path, value) {
  if (path.length === 0) return value;
  const base = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  const [head, ...rest] = path;
  return { ...base, [head]: setAtPath(base[head], rest, value) };
}

/**
 * Coerce a raw metadata-service payload into the value that belongs at the
 * endpoint's targetPath. subject/procedures are returned verbatim; funding and
 * investigators need version-specific shaping because the v1 and v2 services
 * disagree wildly:
 *
 *   funding      v1 → single Funding object (with an extra `investigators`
 *                     string that is not part of the Funding model)
 *                v2 → list of Funding objects
 *   investigators v1 → no endpoint; derived from the funding response's
 *                     comma-separated `investigators` string
 *                v2 → list of Person objects
 *
 * The DocDB target (data_description.funding_source / .investigators) is always
 * a list, so v1 funding is wrapped into one and its stray `investigators` key
 * stripped, and v1 investigators are split into PIDName-shaped objects.
 */
export function normalizeServiceSection(endpoint, db, payload) {
  if (endpoint === 'subject' || endpoint === 'procedures') return payload;

  if (endpoint === 'funding') {
    const list = Array.isArray(payload) ? payload : [payload];
    return list.map((entry) => {
      if (entry && typeof entry === 'object' && 'investigators' in entry) {
        const { investigators, ...rest } = entry;
        return rest;
      }
      return entry;
    });
  }

  if (endpoint === 'investigators') {
    if (Array.isArray(payload)) return payload; // v2 list of Person
    // v1: payload is the funding object; investigators is a comma-separated string.
    const raw = payload && typeof payload === 'object' ? payload.investigators : null;
    if (typeof raw === 'string') {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((name) => ({ name, abbreviation: null, registry: null, registry_identifier: null }));
    }
    return [];
  }

  return payload;
}

/** Find the top-level fields that differ between two records — useful for
 * giving reviewers a quick summary of which sections a pending migration touches.
 */
export function topLevelChangedSections(oldRecord, newRecord) {
  if (!oldRecord || !newRecord) return [];
  const keys = new Set([...Object.keys(oldRecord), ...Object.keys(newRecord)]);
  const out = [];
  for (const k of keys) {
    if (!deepEqual(oldRecord[k], newRecord[k])) out.push(k);
  }
  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

export async function fetchFullRecord(db, assetIdOrName, signal) {
  const byName = await queryDocDb(
    { name: assetIdOrName },
    { baseUrl: DOCDB_BASES[db], limit: 1, signal },
  );
  if (byName.length) return byName[0];
  const byId = await queryDocDb(
    { _id: assetIdOrName },
    { baseUrl: DOCDB_BASES[db], limit: 1, signal },
  );
  if (!byId.length) throw new Error(`Asset "${assetIdOrName}" not found in DocDB ${db}.`);
  return byId[0];
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function metadataCacheKey(db, endpoint, subjectId) {
  return `migrate_cache:${db}:${endpoint}:${subjectId}`;
}

function readMetadataCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function writeMetadataCache(key, data, warning) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data, warning }));
  } catch { /* storage full — ignore */ }
}

export function clearMetadataCache(db, endpoint, subjectId) {
  try {
    localStorage.removeItem(metadataCacheKey(db, endpoint, subjectId));
  } catch { /* ignore */ }
}

export async function fetchMetadataServiceSection(db, endpoint, lookupId, signal) {
  const cacheKey = metadataCacheKey(db, endpoint, lookupId);
  const cached = readMetadataCache(cacheKey);
  if (cached) {
    return { data: cached.data, warning: cached.warning, fromCache: true };
  }

  const path = METADATA_SERVICE_PATHS[db][endpoint](lookupId);
  const resp = await fetch(path, { signal });
  let warning = null;
  if (!resp.ok) {
    if (resp.status >= 500) {
      let text = '';
      try { text = await resp.text(); } catch { /* ignore */ }
      throw new Error(`metadata service ${resp.status} ${resp.statusText}${text ? ` — ${text}` : ''}`);
    }
    warning = `Metadata service returned ${resp.status} — model may not be fully valid, but changes will still be applied.`;
  }
  const body = await resp.json();
  const payload = extractServicePayload(body, db);
  const data = normalizeServiceSection(endpoint, db, payload);
  writeMetadataCache(cacheKey, data, warning);
  return { data, warning, fromCache: false };
}

// ---------------------------------------------------------------------------
// Shared diff component
// ---------------------------------------------------------------------------

export function DiffView({ entries, title }) {
  if (!entries) return null;
  if (entries.length === 0) {
    return html`<p class="migrate-diff-empty">No differences.</p>`;
  }
  return html`
    <div class="migrate-diff">
      ${title ? html`<h3 class="migrate-diff-title">${title}</h3>` : null}
      <table class="data-table migrate-diff-table">
        <thead>
          <tr>
            <th>Path</th>
            <th>Kind</th>
            <th>Old value</th>
            <th>New value</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(
            (e) => html`
              <tr class=${`migrate-diff-${e.kind}`}>
                <td class="migrate-diff-path">${e.path}</td>
                <td class="migrate-diff-kind">${e.kind}</td>
                <td><pre class="migrate-diff-value">${formatDiffValue(e.oldValue)}</pre></td>
                <td><pre class="migrate-diff-value">${formatDiffValue(e.newValue)}</pre></td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>`;
}

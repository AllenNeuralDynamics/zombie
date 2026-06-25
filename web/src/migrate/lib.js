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
  },
  v2: {
    subject: (id) => `${METADATA_SERVICE_BASE}/api/v2/subject/${encodeURIComponent(id)}`,
    procedures: (id) => `${METADATA_SERVICE_BASE}/api/v2/procedures/${encodeURIComponent(id)}`,
  },
};

export const ENDPOINTS = ['subject', 'procedures'];
export const DB_VERSIONS = ['v1', 'v2'];

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

export async function fetchMetadataServiceSection(db, endpoint, subjectId, signal) {
  const cacheKey = metadataCacheKey(db, endpoint, subjectId);
  const cached = readMetadataCache(cacheKey);
  if (cached) {
    return { data: cached.data, warning: cached.warning, fromCache: true };
  }

  const path = METADATA_SERVICE_PATHS[db][endpoint](subjectId);
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
  const data = extractServicePayload(body, db);
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

import { CONTRIBUTIONS_API_BASE } from '../constants.js';

const FUZZY_NAME_THRESHOLD = 0.82;

function contributionsEndpoint(path) {
  return new URL(
    `${CONTRIBUTIONS_API_BASE}${path}`,
    globalThis.location?.origin || 'http://localhost',
  );
}

export function normalizeOrcidId(value) {
  const raw = String(value || '').trim()
    .replace(/^https?:\/\/(?:www\.)?orcid\.org\//i, '')
    .replace(/^\//, '')
    .replace(/\/$/, '');
  const compact = raw.replace(/[\s-]/g, '').toUpperCase();
  const match = compact.match(/^(\d{4})(\d{4})(\d{4})(\d{3}[\dX])$/);
  return match ? match.slice(1).join('-') : raw;
}

export function isOrcidId(value) {
  const normalized = normalizeOrcidId(value);
  return /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/i.test(normalized);
}

function visibleValue(value) {
  return typeof value === 'string' ? value : value?.value || '';
}

export function orcidProfileName(person) {
  const root = person?.person || person || {};
  const name = root.name || root['personal-details']?.name || {};
  return visibleValue(name['credit-name'])
    || [visibleValue(name['given-names']), visibleValue(name['family-name'])]
      .filter(Boolean)
      .join(' ')
      .trim();
}

export async function searchOrcidProfiles(name, signal) {
  if (!String(name || '').trim()) return [];
  const url = contributionsEndpoint('/contributions/orcid/search');
  url.searchParams.set('name', String(name).trim());
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'ORCID search is temporarily unavailable.');
  }
  const data = await response.json();
  return [...new Map((data.results || [])
    .map((profile) => [normalizeOrcidId(profile.orcid), {
      orcid: normalizeOrcidId(profile.orcid),
      name: String(profile.name || ''),
    }])
    .filter(([orcid]) => orcid)).values()];
}

export async function readOrcidProfile(orcid, signal) {
  const normalized = normalizeOrcidId(orcid);
  if (!isOrcidId(normalized)) throw new Error('Enter a valid ORCID iD.');
  const url = contributionsEndpoint('/contributions/orcid/profile');
  url.searchParams.set('orcid', normalized);
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'ORCID profile lookup is temporarily unavailable.');
  }
  const profile = await response.json();
  return { orcid: normalizeOrcidId(profile.orcid || normalized), name: String(profile.name || '') };
}

function comparableName(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[’'`]/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function editSimilarity(left, right) {
  const a = [...left];
  const b = [...right];
  if (!a.length || !b.length) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function nameSimilarity(left, right) {
  const a = comparableName(left);
  const b = comparableName(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sortedA = a.split(' ').sort().join(' ');
  const sortedB = b.split(' ').sort().join(' ');
  const tokensA = sortedA.split(' ');
  const tokensB = sortedB.split(' ');
  let tokenSimilarity = 0;
  if (tokensA.length === tokensB.length) {
    tokenSimilarity = tokensA.reduce((sum, token, index) => {
      const other = tokensB[index];
      const initialMatch = Math.min(token.length, other.length) === 1
        && token[0] === other[0];
      return sum + (initialMatch ? 0.9 : editSimilarity(token, other));
    }, 0) / tokensA.length;
  }
  return Math.max(editSimilarity(a, b), editSimilarity(sortedA, sortedB), tokenSimilarity);
}

export function findUnlinkedAuthorMatches(contributors, personName, options = {}) {
  const { legacyName = '', includeAdmins = false, limit = 3 } = options;
  const query = String(personName || '').trim();
  if (!query && !legacyName) return [];

  return (contributors || [])
    .map((contributor) => {
      const author = contributor?.author || {};
      const name = String(author.name || '').trim();
      if (!name || normalizeOrcidId(author.registry_identifier)) return null;
      if (!includeAdmins && contributor.is_admin) return null;
      const variants = [name, ...(Array.isArray(author.other_names) ? author.other_names : [])];
      const scores = variants.map((variant) => Math.max(
        nameSimilarity(query, variant),
        legacyName ? nameSimilarity(legacyName, variant) : 0,
      ));
      const score = Math.max(0, ...scores);
      const normalizedLength = [...comparableName(query)].length;
      const threshold = score === 1 || normalizedLength < 5 ? 1 : FUZZY_NAME_THRESHOLD;
      return score >= threshold ? { contributor, name, score } : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit);
}

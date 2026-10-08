import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  findUnlinkedAuthorMatches,
  isOrcidId,
  normalizeOrcidId,
  orcidProfileName,
  readOrcidProfile,
  searchOrcidProfiles,
} from '../contributions/orcid-identity.js';

afterEach(() => vi.unstubAllGlobals());

describe('ORCID identity helpers', () => {
  it('normalizes ORCID URLs and compact identifiers', () => {
    expect(normalizeOrcidId('https://orcid.org/0000000218250097')).toBe('0000-0002-1825-0097');
    expect(normalizeOrcidId('0000-0002-1825-009X')).toBe('0000-0002-1825-009X');
    expect(isOrcidId('https://orcid.org/0000-0002-1825-0097')).toBe(true);
    expect(isOrcidId('not-an-orcid')).toBe(false);
  });

  it('uses the public credit name before given and family names', () => {
    expect(orcidProfileName({ person: { name: {
      'credit-name': { value: 'J. Canonical' },
      'given-names': { value: 'Jane' },
      'family-name': { value: 'Example' },
    } } })).toBe('J. Canonical');
    expect(orcidProfileName({ name: {
      'given-names': { value: 'Jane' },
      'family-name': { value: 'Example' },
    } })).toBe('Jane Example');
  });

  it('suggests only similar unlinked non-admin contributor records', () => {
    const contributors = [
      { author: { name: 'Carol Smyth' } },
      { author: { name: 'C. Smith' }, is_admin: true },
      { author: { name: 'Carol Smith', registry_identifier: '0000-0007' } },
      { author: { name: 'Completely Different' } },
    ];
    const matches = findUnlinkedAuthorMatches(contributors, 'Carol Smith');
    expect(matches.map((match) => match.name)).toEqual(['Carol Smyth']);
    expect(findUnlinkedAuthorMatches(
      [{ author: { name: 'N. Smith' } }],
      'Nancy Smith',
    ).map((match) => match.name)).toEqual(['N. Smith']);
  });

  it('searches through the contributions API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [
        { orcid: '0000-0002-1825-0097', name: 'Jane Example' },
      ] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(searchOrcidProfiles('Jane Example')).resolves.toEqual([
      { orcid: '0000-0002-1825-0097', name: 'Jane Example' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/contributions/orcid/search?name=Jane+Example');
  });

  it('resolves a pasted ORCID through the contributions API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ orcid: '0000-0002-1825-0097', name: 'Jane Example' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(readOrcidProfile('0000-0002-1825-0097')).resolves.toEqual({
      orcid: '0000-0002-1825-0097',
      name: 'Jane Example',
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/contributions/orcid/profile?orcid=0000-0002-1825-0097');
  });
});

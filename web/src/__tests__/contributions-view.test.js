/**
 * contributions-view.test.js — Unit tests for pure helpers in contributions-view.js.
 *
 * DOM-dependent createContributionsView() is exercised only for basic rendering;
 * network-dependent loading is not tested here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/docdb.js', () => ({
  fetchDocDbRecordsByName: vi.fn(),
}));

vi.mock('../contributions/preview.js', () => ({
  createPreview: vi.fn(() => document.createElement('div')),
}));

import { fetchDocDbRecordsByName } from '../lib/docdb.js';
import {
  CREDIT_CATEGORIES,
  CONTRIBUTION_LEVELS,
  CREDIT_ROLE_ENUM,
  CREDIT_ROLE_ENUM_REVERSE,
  parseAssetNames,
  extractAuthors,
  initMatrix,
  formatAuthorForLatex,
  generateLatex,
  toEndpointPayload,
  fromEndpointPayload,
  authorNameExists,
  rowsToWidgetAuthors,
  createContributionsView,
} from '../contributions/view.js';

// ---------------------------------------------------------------------------
// authorNameExists (anonymous add-wizard name-collision guard)
// ---------------------------------------------------------------------------

describe('authorNameExists', () => {
  const rows = [{ name: 'Alice Nguyen' }, { name: 'Bob Rivera' }];

  it('detects an exact match', () => {
    expect(authorNameExists(rows, 'Bob Rivera')).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(authorNameExists(rows, '  bob rivera ')).toBe(true);
  });

  it('returns false for a new name', () => {
    expect(authorNameExists(rows, 'Test')).toBe(false);
  });

  it('returns false for empty/falsy names or rows', () => {
    expect(authorNameExists(rows, '')).toBe(false);
    expect(authorNameExists(rows, '   ')).toBe(false);
    expect(authorNameExists(null, 'Alice Nguyen')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseAssetNames
// ---------------------------------------------------------------------------

describe('parseAssetNames', () => {
  it('splits a comma-separated string into trimmed names', () => {
    expect(parseAssetNames('a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates names (first occurrence wins)', () => {
    expect(parseAssetNames('a, b, a, c')).toEqual(['a', 'b', 'c']);
  });

  it('ignores empty segments', () => {
    expect(parseAssetNames(', a, , b,')).toEqual(['a', 'b']);
  });

  it('returns [] for falsy input', () => {
    expect(parseAssetNames('')).toEqual([]);
    expect(parseAssetNames(null)).toEqual([]);
    expect(parseAssetNames(undefined)).toEqual([]);
  });

  it('returns a single-element array for a plain name', () => {
    expect(parseAssetNames('my-asset')).toEqual(['my-asset']);
  });
});

// ---------------------------------------------------------------------------
// extractAuthors
// ---------------------------------------------------------------------------

describe('extractAuthors', () => {
  it('returns empty results for no records', () => {
    const { authors, authorSources } = extractAuthors([]);
    expect(authors).toEqual([]);
    expect(authorSources).toEqual({});
  });

  it('extracts investigators from data_description', () => {
    const records = [
      { data_description: { investigators: [{ name: 'Alice Smith' }, { name: 'Bob Jones' }] } },
    ];
    const { authors } = extractAuthors(records);
    expect(authors).toContain('Alice Smith');
    expect(authors).toContain('Bob Jones');
  });

  it('accepts string investigators as well as object investigators', () => {
    const records = [{ data_description: { investigators: ['Carol White'] } }];
    const { authors } = extractAuthors(records);
    expect(authors).toContain('Carol White');
  });

  it('extracts acquisition experimenters', () => {
    const records = [{ acquisition: { experimenters: [{ name: 'Dave Brown' }] } }];
    const { authors } = extractAuthors(records);
    expect(authors).toContain('Dave Brown');
  });

  it('extracts subject_procedures experimenters', () => {
    const records = [
      {
        procedures: {
          subject_procedures: [{ experimenters: [{ name: 'Eve Green' }] }],
          specimen_procedures: [],
        },
      },
    ];
    const { authors } = extractAuthors(records);
    expect(authors).toContain('Eve Green');
  });

  it('extracts processing data_processes experimenters', () => {
    const records = [
      { processing: { data_processes: [{ experimenters: [{ name: 'Frank Blue' }] }] } },
    ];
    const { authors } = extractAuthors(records);
    expect(authors).toContain('Frank Blue');
  });

  it('deduplicates the same name across records and sources', () => {
    const records = [
      { data_description: { investigators: [{ name: 'Alice Smith' }] } },
      { acquisition: { experimenters: [{ name: 'Alice Smith' }] } },
    ];
    const { authors, authorSources } = extractAuthors(records);
    expect(authors.filter((a) => a === 'Alice Smith')).toHaveLength(1);
    expect(authorSources['Alice Smith']).toContain('investigators');
    expect(authorSources['Alice Smith']).toContain('acquisition');
  });

  it('skips invalid names like "unknown", "na", "n/a"', () => {
    const records = [
      {
        data_description: {
          investigators: ['unknown', 'NA', 'N/A', '', 'Valid Name'],
        },
      },
    ];
    const { authors } = extractAuthors(records);
    expect(authors).not.toContain('unknown');
    expect(authors).not.toContain('NA');
    expect(authors).not.toContain('N/A');
    expect(authors).toContain('Valid Name');
  });

  it('handles funding_source with array fundees', () => {
    const records = [
      {
        data_description: {
          funding_source: [{ fundee: [{ name: 'Grace Lee' }] }],
        },
      },
    ];
    const { authors, authorSources } = extractAuthors(records);
    expect(authors).toContain('Grace Lee');
    expect(authorSources['Grace Lee']).toContain('funding');
  });

  it('handles funding_source with comma-separated string fundee', () => {
    const records = [
      {
        data_description: {
          funding_source: [{ fundee: 'Henry Kim and Jane Doe' }],
        },
      },
    ];
    const { authors } = extractAuthors(records);
    expect(authors).toContain('Henry Kim');
    expect(authors).toContain('Jane Doe');
  });
});

// ---------------------------------------------------------------------------
// initMatrix
// ---------------------------------------------------------------------------

describe('initMatrix', () => {
  it('creates one row per author', () => {
    const rows = initMatrix(['Alice Smith', 'Bob Jones']);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('Alice Smith');
    expect(rows[1].name).toBe('Bob Jones');
  });

  it('sets isFirst=false and all categories to "None" by default', () => {
    const [row] = initMatrix(['Alice Smith']);
    expect(row.isFirst).toBe(false);
    for (const cat of CREDIT_CATEGORIES) {
      expect(row[cat]).toBe('None');
    }
  });

  it('returns [] for empty authors array', () => {
    expect(initMatrix([])).toEqual([]);
  });

  it('includes all CREDIT_CATEGORIES as keys', () => {
    const [row] = initMatrix(['Someone']);
    for (const cat of CREDIT_CATEGORIES) {
      expect(Object.prototype.hasOwnProperty.call(row, cat)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// formatAuthorForLatex
// ---------------------------------------------------------------------------

describe('formatAuthorForLatex', () => {
  it('abbreviates the first name: "Alice Smith" → "A. Smith"', () => {
    expect(formatAuthorForLatex('Alice Smith', false)).toBe('A. Smith');
  });

  it('appends * for first authors', () => {
    expect(formatAuthorForLatex('Alice Smith', true)).toBe('A. Smith*');
  });

  it('handles multi-part last names: "Alice Van Dyke" → "A. Van Dyke"', () => {
    expect(formatAuthorForLatex('Alice Van Dyke', false)).toBe('A. Van Dyke');
  });

  it('returns the name as-is when it is a single token', () => {
    expect(formatAuthorForLatex('Mononym', false)).toBe('Mononym');
  });

  it('appends * to single-token names when isFirst=true', () => {
    expect(formatAuthorForLatex('Mononym', true)).toBe('Mononym*');
  });
});

// ---------------------------------------------------------------------------
// generateLatex
// ---------------------------------------------------------------------------

describe('generateLatex', () => {
  const baseRows = initMatrix(['Alice Smith', 'Bob Jones']);

  it('contains the section header', () => {
    expect(generateLatex(baseRows)).toContain('\\section*{Author contribution matrix}');
  });

  it('contains tikzpicture environment', () => {
    const tex = generateLatex(baseRows);
    expect(tex).toContain('\\begin{tikzpicture}');
    expect(tex).toContain('\\end{tikzpicture}');
  });

  it('includes each author in the LaTeX row list', () => {
    const tex = generateLatex(baseRows);
    expect(tex).toContain('A. Smith');
    expect(tex).toContain('B. Jones');
  });

  it('appends * for first authors', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0].isFirst = true;
    expect(generateLatex(rows)).toContain('A. Smith*');
  });

  it('includes each CReDIT category in the column list', () => {
    const tex = generateLatex(baseRows);
    for (const cat of CREDIT_CATEGORIES) {
      // `&` is escaped to `\&` for LaTeX output.
      expect(tex).toContain(cat.replace(/&/g, '\\&'));
    }
  });

  it('escapes & as \\& in category labels', () => {
    const tex = generateLatex(baseRows);
    expect(tex).toContain('Writing – review \\& editing');
    // No bare, unescaped ampersand should remain.
    expect(tex).not.toMatch(/[^\\]& editing/);
  });

  it('uses \\mid for Equal contributions', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0]['Conceptualization'] = 'Equal';
    expect(generateLatex(rows)).toContain('\\mid');
  });

  it('uses 0 for None contributions in heatmap', () => {
    const rows = initMatrix(['Alice Smith']);
    // All None by default → all zeros
    const tex = generateLatex(rows);
    expect(tex).toContain('{0,0,0,0,0,0,0,0,0,0,0,0,0,0}');
  });

  it('uses \\lo for Supporting contributions', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0]['Conceptualization'] = 'Supporting';
    expect(generateLatex(rows)).toContain('\\lo');
  });

  it('uses \\hi for Lead contributions', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0]['Conceptualization'] = 'Lead';
    expect(generateLatex(rows)).toContain('\\hi');
  });

  it('returns empty-ish string for no rows (does not throw)', () => {
    expect(() => generateLatex([])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Constants sanity checks
// ---------------------------------------------------------------------------

describe('CREDIT_CATEGORIES', () => {
  it('has 14 entries', () => {
    expect(CREDIT_CATEGORIES).toHaveLength(14);
  });

  it('includes Conceptualization and Funding Acquisition', () => {
    expect(CREDIT_CATEGORIES).toContain('Conceptualization');
    expect(CREDIT_CATEGORIES).toContain('Funding Acquisition');
  });
});

describe('CONTRIBUTION_LEVELS', () => {
  it('contains None, Lead, Equal, Supporting in that order', () => {
    expect(CONTRIBUTION_LEVELS).toEqual(['None', 'Lead', 'Equal', 'Supporting']);
  });
});

// ---------------------------------------------------------------------------
// CREDIT_ROLE_ENUM / CREDIT_ROLE_ENUM_REVERSE
// ---------------------------------------------------------------------------

describe('CREDIT_ROLE_ENUM', () => {
  it('maps every CREDIT_CATEGORIES entry to a kebab-case string', () => {
    for (const cat of CREDIT_CATEGORIES) {
      expect(typeof CREDIT_ROLE_ENUM[cat]).toBe('string');
      expect(CREDIT_ROLE_ENUM[cat]).toMatch(/^[a-z-]+$/);
    }
  });

  it('maps Conceptualization to conceptualization', () => {
    expect(CREDIT_ROLE_ENUM['Conceptualization']).toBe('conceptualization');
  });
});

describe('CREDIT_ROLE_ENUM_REVERSE', () => {
  it('is a proper inverse of CREDIT_ROLE_ENUM', () => {
    for (const [display, enumVal] of Object.entries(CREDIT_ROLE_ENUM)) {
      expect(CREDIT_ROLE_ENUM_REVERSE[enumVal]).toBe(display);
    }
  });
});

// ---------------------------------------------------------------------------
// toEndpointPayload
// ---------------------------------------------------------------------------

describe('toEndpointPayload', () => {
  it('sets project_name correctly', () => {
    const rows = initMatrix(['Alice Smith']);
    const payload = toEndpointPayload(rows, 'my-project');
    expect(payload.project_name).toBe('my-project');
  });

  it('omits None contributions from credit_levels', () => {
    const rows = initMatrix(['Alice Smith']);
    // All None by default
    const payload = toEndpointPayload(rows, 'proj');
    expect(payload.contributors[0].credit_levels).toHaveLength(0);
  });

  it('includes non-None contributions with kebab-case role and lowercase level', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0]['Conceptualization'] = 'Lead';
    rows[0]['Software'] = 'Supporting';
    const payload = toEndpointPayload(rows, 'proj');
    const levels = payload.contributors[0].credit_levels;
    expect(levels).toContainEqual({ role: 'conceptualization', level: 'lead' });
    expect(levels).toContainEqual({ role: 'software', level: 'supporting' });
  });

  it('includes author.name for each contributor', () => {
    const rows = initMatrix(['Bob Jones']);
    const payload = toEndpointPayload(rows, 'proj');
    expect(payload.contributors[0].author.name).toBe('Bob Jones');
  });
});

// ---------------------------------------------------------------------------
// fromEndpointPayload
// ---------------------------------------------------------------------------

describe('fromEndpointPayload', () => {
  it('converts endpoint payload back into matrix rows', () => {
    const data = {
      project_name: 'proj',
      contributors: [
        {
          author: { name: 'Alice Smith' },
          credit_levels: [
            { role: 'conceptualization', level: 'lead' },
            { role: 'software', level: 'supporting' },
          ],
        },
      ],
    };
    const rows = fromEndpointPayload(data);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Alice Smith');
    expect(rows[0]['Conceptualization']).toBe('Lead');
    expect(rows[0]['Software']).toBe('Supporting');
    expect(rows[0]['Methodology']).toBe('None');
  });

  it('returns empty array for empty contributors', () => {
    expect(fromEndpointPayload({ project_name: 'p', contributors: [] })).toEqual([]);
  });

  it('preserves author_level from endpoint payload', () => {
    const data = {
      project_name: 'proj',
      contributors: [
        { author: { name: 'Alice Smith' }, author_level: 'first', credit_levels: [] },
        { author: { name: 'Bob Jones' }, author_level: null, credit_levels: [] },
        { author: { name: 'Carol Lee' }, author_level: 'senior', credit_levels: [] },
      ],
    };
    const rows = fromEndpointPayload(data);
    expect(rows[0].author_level).toBe('first');
    expect(rows[1].author_level).toBeNull();
    expect(rows[2].author_level).toBe('senior');
  });

  it('round-trips through toEndpointPayload → fromEndpointPayload', () => {
    const original = initMatrix(['Alice Smith', 'Bob Jones']);
    original[0]['Conceptualization'] = 'Lead';
    original[1]['Software'] = 'Equal';
    const payload = toEndpointPayload(original, 'proj');
    const restored = fromEndpointPayload(payload);
    expect(restored[0]['Conceptualization']).toBe('Lead');
    expect(restored[1]['Software']).toBe('Equal');
    expect(restored[0]['Software']).toBe('None');
  });

  it('round-trips author_level through toEndpointPayload → fromEndpointPayload', () => {
    const data = {
      project_name: 'proj',
      contributors: [
        { author: { name: 'Alice Smith' }, author_level: 'first', credit_levels: [] },
        { author: { name: 'Bob Jones' }, author_level: 'senior', credit_levels: [] },
      ],
    };
    const rows = fromEndpointPayload(data);
    const payload = toEndpointPayload(rows, 'proj');
    const restored = fromEndpointPayload(payload);
    expect(restored[0].author_level).toBe('first');
    expect(restored[1].author_level).toBe('senior');
  });
});

// ---------------------------------------------------------------------------
// rowsToWidgetAuthors
// ---------------------------------------------------------------------------

describe('rowsToWidgetAuthors', () => {
  it('converts rows to widget author format with display role names', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0]['Conceptualization'] = 'Lead';
    const authors = rowsToWidgetAuthors(rows);
    expect(authors[0].name).toBe('Alice Smith');
    expect(authors[0].credit_levels).toContainEqual({ role: 'Conceptualization', level: 'lead' });
  });

  it('omits None levels from credit_levels', () => {
    const rows = initMatrix(['Bob Jones']);
    // All None
    const authors = rowsToWidgetAuthors(rows);
    expect(authors[0].credit_levels).toHaveLength(0);
  });

  it('preserves author_level in widget author objects', () => {
    const rows = initMatrix(['Alice Smith', 'Bob Jones']);
    rows[0].author_level = 'first';
    rows[1].author_level = 'senior';
    const authors = rowsToWidgetAuthors(rows);
    expect(authors[0].author_level).toBe('first');
    expect(authors[1].author_level).toBe('senior');
  });
});

// ---------------------------------------------------------------------------
// createContributionsView — projectName auto-load
// ---------------------------------------------------------------------------

/**
 * @vitest-environment happy-dom
 */
describe('createContributionsView — projectName auto-load', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ project_name: 'my-project', contributors: [], sections: [] }),
    });
  });

  it('populates the project name input when projectName option is provided', () => {
    const root = createContributionsView({ projectName: 'my-project' });
    const input = root.querySelector('#cv-project-name');
    expect(input.value).toBe('my-project');
  });

  it('calls fetch to load the project when projectName is provided and no draft exists', async () => {
    createContributionsView({ projectName: 'my-project' });
    await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('my-project'),
    );
  });

  it('does not auto-fetch when no projectName is provided', async () => {
    createContributionsView({});
    await Promise.resolve();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches history when a draft with a project name is restored (no full reload)', async () => {
    const draftRows = [{ name: 'Alice Smith', isFirst: false, ...Object.fromEntries(
      ['Conceptualization','Methodology','Software','Validation','Formal analysis',
       'Investigation','Resources','Data curation','Writing \u2013 original draft',
       'Writing \u2013 review & editing','Visualization','Supervision',
       'Project Administration','Funding Acquisition'].map(c => [c, 'None'])
    ) }];
    sessionStorage.setItem('contributions:draft', JSON.stringify({
      rows: draftRows,
      projectName: 'my-project',
      assetNames: '',
      authorSources: {},
      authorOrcids: {},
      authorAffIds: {},
      affiliations: [],
      loadedAssetNames: [],
      sections: [],
      creditDescriptions: {},
      creditLinkedSections: {},
      selectedAuthor: null,
      doi: '',
      existsOnServer: false,
    }));

    // history=true fetch should be called; full project GET should not
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    });

    createContributionsView({ projectName: 'my-project' });
    await Promise.resolve();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('history=true'),
    );
    // Should NOT re-fetch the full project data
    const fullProjectCalls = global.fetch.mock.calls.filter(
      ([url]) => !url.includes('history=true'),
    );
    expect(fullProjectCalls).toHaveLength(0);
  });

  it('discards a draft for a project that exists on the server and re-fetches', async () => {
    const draftRows = [{ name: 'Alice Smith', isFirst: false, ...Object.fromEntries(
      ['Conceptualization','Methodology','Software','Validation','Formal analysis',
       'Investigation','Resources','Data curation','Writing \u2013 original draft',
       'Writing \u2013 review & editing','Visualization','Supervision',
       'Project Administration','Funding Acquisition'].map(c => [c, 'None'])
    ) }];
    sessionStorage.setItem('contributions:draft', JSON.stringify({
      rows: draftRows,
      projectName: 'my-project',
      existsOnServer: true,
    }));

    createContributionsView({ projectName: 'my-project' });
    await Promise.resolve();

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('contributions/get?project=my-project'),
    );
    expect(sessionStorage.getItem('contributions:draft')).toBeNull();
  });
});

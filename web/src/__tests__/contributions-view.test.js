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
  hasPublicationOrder,
  orderRowsForPublication,
  generateContributionStatement,
  generateMatrixCanvas,
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

  it('writes author.email from authorEmails, trimmed', () => {
    const rows = initMatrix(['Bob Jones']);
    const payload = toEndpointPayload(rows, 'proj', {
      authorEmails: { 'Bob Jones': '  bob@example.org  ' },
    });
    expect(payload.contributors[0].author.email).toBe('bob@example.org');
  });

  it('omits author.email when unset or blank', () => {
    const rows = initMatrix(['Bob Jones', 'Amy Lee']);
    const payload = toEndpointPayload(rows, 'proj', {
      authorEmails: { 'Bob Jones': '   ' },
    });
    expect(payload.contributors[0].author).not.toHaveProperty('email');
    expect(payload.contributors[1].author).not.toHaveProperty('email');
  });
});

// ---------------------------------------------------------------------------
// Publication order
// ---------------------------------------------------------------------------

describe('publication order', () => {
  const unordered = [
    { name: 'Zoe', publication_order: null },
    { name: 'Amy', publication_order: null },
  ];
  const ordered = [
    { name: 'Zoe', publication_order: 2 },
    { name: 'Amy', publication_order: 1 },
  ];

  it('treats an empty order as unset', () => {
    expect(hasPublicationOrder(unordered)).toBe(false);
    expect(hasPublicationOrder([])).toBe(false);
    expect(hasPublicationOrder(ordered)).toBe(true);
  });

  it('leaves row order untouched when unset', () => {
    expect(orderRowsForPublication(unordered).map((r) => r.name))
      .toEqual(['Zoe', 'Amy']);
  });

  it('sorts by publication_order when set', () => {
    expect(orderRowsForPublication(ordered).map((r) => r.name))
      .toEqual(['Amy', 'Zoe']);
  });

  it('puts rows without an order last, keeping their relative order', () => {
    const mixed = [
      { name: 'NoneA' },
      { name: 'Second', publication_order: 2 },
      { name: 'NoneB' },
      { name: 'First', publication_order: 1 },
    ];
    expect(orderRowsForPublication(mixed).map((r) => r.name))
      .toEqual(['First', 'Second', 'NoneA', 'NoneB']);
  });

  it('does not mutate the input', () => {
    const input = [...ordered];
    orderRowsForPublication(input);
    expect(input.map((r) => r.name)).toEqual(['Zoe', 'Amy']);
  });

  it('round-trips publication_order through the endpoint payload', () => {
    const rows = initMatrix(['Alice Smith', 'Bob Jones']);
    rows[0].publication_order = 2;
    rows[1].publication_order = 1;
    const payload = toEndpointPayload(rows, 'proj');
    expect(payload.contributors.map((c) => c.publication_order)).toEqual([2, 1]);
    expect(fromEndpointPayload(payload).map((r) => r.publication_order))
      .toEqual([2, 1]);
  });

  it('omits publication_order from the payload when unset', () => {
    const payload = toEndpointPayload(initMatrix(['Alice Smith']), 'proj');
    expect(payload.contributors[0]).not.toHaveProperty('publication_order');
  });
});

// ---------------------------------------------------------------------------
// Round-tripping fields the editor does not model
// ---------------------------------------------------------------------------

describe('endpoint payload passthrough', () => {
  const stored = {
    project_name: 'proj',
    contributors: [{
      author: {
        name: 'Alice Smith',
        registry_identifier: '0000-0001',
        registry: 'Open Researcher and Contributor ID (ORCID)',
        email: 'alice@example.org',
        other_names: ['A. Smith'],
      },
      from_asset: true,
      credit_levels: [{
        role: 'software',
        level: 'lead',
        description: 'wrote the solver',
        linked_assets: ['asset-1', 'asset-2'],
        linked_sections: ['Methods'],
        start_date: '2024-01-01',
        end_date: '2024-06-01',
      }],
    }],
  };

  function resave(payload) {
    // What a save does: load the grid, change nothing, write it back.
    const rows = fromEndpointPayload(payload);
    const descs = { 'Alice Smith': { software: 'wrote the solver' } };
    return toEndpointPayload(rows, 'proj', {
      authorOrcids: { 'Alice Smith': '0000-0001' },
      authorEmails: { 'Alice Smith': 'alice@example.org' },
      creditDescriptions: descs,
    });
  }

  it('preserves author fields the grid cannot edit', () => {
    const author = resave(stored).contributors[0].author;
    expect(author.other_names).toEqual(['A. Smith']);
    expect(author.registry).toBe('Open Researcher and Contributor ID (ORCID)');
    expect(author.registry_identifier).toBe('0000-0001');
  });

  it('round-trips an email through the editor rather than passthrough', () => {
    const rows = fromEndpointPayload(stored);
    // The editor models email explicitly, so it is not stashed as passthrough.
    expect(rows[0]._passthrough?.author).not.toHaveProperty('email');
    expect(resave(stored).contributors[0].author.email).toBe('alice@example.org');
  });

  it('drops the stored email when the editor clears it', () => {
    const rows = fromEndpointPayload(stored);
    const payload = toEndpointPayload(rows, 'proj', { authorEmails: { 'Alice Smith': '' } });
    expect(payload.contributors[0].author).not.toHaveProperty('email');
  });

  it('preserves linked assets, sections and per-role dates', () => {
    const cl = resave(stored).contributors[0].credit_levels[0];
    expect(cl.linked_assets).toEqual(['asset-1', 'asset-2']);
    expect(cl.linked_sections).toEqual(['Methods']);
    expect(cl.start_date).toBe('2024-01-01');
    expect(cl.end_date).toBe('2024-06-01');
    expect(cl.description).toBe('wrote the solver');
  });

  it('is stable across repeated saves', () => {
    expect(resave(resave(stored))).toEqual(resave(stored));
  });

  it('drops passthrough for a role the author no longer holds', () => {
    const rows = fromEndpointPayload(stored);
    rows[0]['Software'] = 'None';
    rows[0]['Methodology'] = 'Equal';
    const cls = toEndpointPayload(rows, 'proj').contributors[0].credit_levels;
    expect(cls).toHaveLength(1);
    expect(cls[0].role).toBe('methodology');
    expect(cls[0]).not.toHaveProperty('linked_assets');
  });

  it('adds no passthrough key for a contributor with nothing extra', () => {
    const rows = fromEndpointPayload({
      contributors: [{ author: { name: 'Bob Jones' }, credit_levels: [] }],
    });
    expect(rows[0]).not.toHaveProperty('_passthrough');
  });

  it('carries publication_order through to widget authors', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0].publication_order = 3;
    expect(rowsToWidgetAuthors(rows)[0].publication_order).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// DOI list
// ---------------------------------------------------------------------------

describe('DOI is a list', () => {
  it('sends a list of DOIs', () => {
    const rows = initMatrix(['Alice Smith']);
    const payload = toEndpointPayload(rows, 'proj', {
      doi: ['10.1/preprint', '10.2/journal'],
    });
    expect(payload.doi).toEqual(['10.1/preprint', '10.2/journal']);
  });

  it('accepts a legacy scalar DOI from an old draft', () => {
    const payload = toEndpointPayload(initMatrix(['A B']), 'proj', { doi: '10.1/x' });
    expect(payload.doi).toEqual(['10.1/x']);
  });

  it('drops blank entries and omits the field when nothing is left', () => {
    const rows = initMatrix(['A B']);
    expect(toEndpointPayload(rows, 'proj', { doi: ['', '  '] }))
      .not.toHaveProperty('doi');
    expect(toEndpointPayload(rows, 'proj', { doi: [' 10.1/x ', ''] }).doi)
      .toEqual(['10.1/x']);
  });
});

// ---------------------------------------------------------------------------
// Contribution statement ordering
// ---------------------------------------------------------------------------

describe('generateContributionStatement ordering', () => {
  it('lists authors alphabetically by last name', () => {
    const rows = initMatrix(['Yara Adams', 'Alice Zimmer', 'Bob Mackay']);
    for (const r of rows) r['Software'] = 'Equal';
    const { statement } = generateContributionStatement(rows);
    expect(statement).toBe('Software, Y.A., B.M., A.Z.');
  });

  it('ignores contribution level when ordering', () => {
    const rows = initMatrix(['Alice Zimmer', 'Bob Adams']);
    rows[0]['Software'] = 'Lead';
    rows[1]['Software'] = 'Supporting';
    // Adams before Zimmer despite Zimmer being the Lead.
    expect(generateContributionStatement(rows).statement)
      .toBe('Software, B.A., A.Z.');
  });

  it('ignores publication order when ordering', () => {
    const rows = initMatrix(['Alice Zimmer', 'Bob Adams']);
    rows[0]['Software'] = 'Equal';
    rows[1]['Software'] = 'Equal';
    rows[0].publication_order = 1;
    rows[1].publication_order = 2;
    expect(generateContributionStatement(rows).statement)
      .toBe('Software, B.A., A.Z.');
  });

  it('orders each role independently but consistently', () => {
    const rows = initMatrix(['Yara Adams', 'Alice Zimmer']);
    rows[0]['Software'] = 'Equal';
    rows[0]['Methodology'] = 'Equal';
    rows[1]['Software'] = 'Equal';
    const { statement } = generateContributionStatement(rows);
    expect(statement).toBe('Methodology, Y.A.; Software, Y.A., A.Z.');
  });

  it('breaks last-name ties on the full name', () => {
    const rows = initMatrix(['Zoe Adams', 'Amy Adams']);
    for (const r of rows) r['Software'] = 'Equal';
    expect(generateContributionStatement(rows).statement)
      .toBe('Software, A.A., Z.A.');
  });

  it('orders the description block by last name too', () => {
    const rows = initMatrix(['Yara Zimmer', 'Alice Adams']);
    rows[0]['Software'] = 'Equal';
    rows[1]['Software'] = 'Equal';
    const { descriptions } = generateContributionStatement(rows, {
      'Yara Zimmer': { software: 'wrote the solver' },
      'Alice Adams': { software: 'wrote the parser' },
    });
    expect(descriptions.split('\n').map((l) => l.split(':')[0]))
      .toEqual(['A.A.', 'Y.Z.']);
  });
});

// ---------------------------------------------------------------------------
// Display paths honour project settings
// ---------------------------------------------------------------------------

describe('display paths honour showLevels', () => {
  function rowsWithLevels() {
    const rows = initMatrix(['Alice Smith', 'Bob Jones']);
    rows[0]['Software'] = 'Lead';
    rows[1]['Software'] = 'Supporting';
    return rows;
  }

  it('LaTeX shades by level when levels are shown', () => {
    const tex = generateLatex(rowsWithLevels(), { showLevels: true });
    expect(tex).toContain('\\hi');
    expect(tex).toContain('\\lo');
  });

  it('LaTeX flattens to a plain yes/no when levels are hidden', () => {
    const tex = generateLatex(rowsWithLevels(), { showLevels: false });
    expect(tex).not.toContain('\\hi');
    expect(tex).not.toContain('\\lo');
    expect(tex).toContain('\\mid');
  });

  it('LaTeX flattens when the project disallows levels entirely', () => {
    const tex = generateLatex(rowsWithLevels(), { allowLevels: false });
    expect(tex).not.toContain('\\hi');
  });

  it('LaTeX lists rows in publication order', () => {
    const rows = rowsWithLevels();
    rows[0].publication_order = 2;
    rows[1].publication_order = 1;
    const tex = generateLatex(rows);
    expect(tex.indexOf('B. Jones')).toBeLessThan(tex.indexOf('A. Smith'));
  });

  // jsdom has no 2d context, so record the draw calls instead. This is what
  // the PNG bug was about: the cells kept their level shading after the
  // legend that explained it was switched off.
  function drawPng(rows, settings) {
    const calls = { fillRect: [], fillText: [] };
    const ctx = {
      save() {}, restore() {}, scale() {}, translate() {}, rotate() {},
      fillStyle: '', font: '', textAlign: '', textBaseline: '',
      fillRect(...a) { calls.fillRect.push({ fillStyle: this.fillStyle, args: a }); },
      fillText(text) { calls.fillText.push({ fillStyle: this.fillStyle, text }); },
    };
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    try {
      const canvas = generateMatrixCanvas(rows, settings);
      // Drop the opening white background fill; the rest are matrix cells.
      const cells = calls.fillRect.slice(1);
      const legend = calls.fillText
        .map((c) => c.text)
        .filter((t) => ['Lead', '++', '+'].includes(t));
      return { width: canvas.width, cells, legend, texts: calls.fillText.map((c) => c.text) };
    } finally {
      spy.mockRestore();
    }
  }

  it('PNG shades cells by level and draws a legend when levels are shown', () => {
    const { cells, legend } = drawPng(rowsWithLevels(), { showLevels: true });
    expect(legend).toEqual(['Lead', '++', '+']);
    expect(new Set(cells.map((c) => c.fillStyle)).size).toBe(2);
  });

  it('PNG uses one flat tone and no legend when levels are hidden', () => {
    const { cells, legend } = drawPng(rowsWithLevels(), { showLevels: false });
    expect(legend).toEqual([]);
    expect(cells).toHaveLength(2);
    expect(new Set(cells.map((c) => c.fillStyle)).size).toBe(1);
  });

  it('PNG flattens when the project disallows levels entirely', () => {
    const { cells, legend } = drawPng(rowsWithLevels(), { allowLevels: false });
    expect(legend).toEqual([]);
    expect(new Set(cells.map((c) => c.fillStyle)).size).toBe(1);
  });

  it('PNG omits Lead from the legend when Lead is not allowed', () => {
    expect(drawPng(rowsWithLevels(), { allowLead: false }).legend).toEqual(['++', '+']);
  });

  it('PNG reclaims the legend gutter when there is no legend', () => {
    expect(drawPng(rowsWithLevels(), { showLevels: false }).width)
      .toBeLessThan(drawPng(rowsWithLevels(), { showLevels: true }).width);
  });

  it('PNG lists rows in publication order', () => {
    const rows = rowsWithLevels();
    rows[0].publication_order = 2;
    rows[1].publication_order = 1;
    const { texts } = drawPng(rows, {});
    expect(texts.indexOf('Bob Jones')).toBeLessThan(texts.indexOf('Alice Smith'));
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

// ---------------------------------------------------------------------------
// createContributionsView — new project (isNew) auto-create
// ---------------------------------------------------------------------------

/**
 * @vitest-environment happy-dom
 */
describe('createContributionsView — isNew auto-create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  function mockFetch() {
    global.fetch = vi.fn().mockImplementation((url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ commit: 'abc1234567' }),
        });
      }
      // history GET etc.
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });
  }

  async function flush() {
    // Allow queued microtasks + the async save chain to settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  it('POSTs to create the project instead of GETting (which 404s)', async () => {
    mockFetch();
    createContributionsView({ projectName: 'dan-test2', isNew: true });
    await flush();

    const postCalls = global.fetch.mock.calls.filter(
      ([, opts]) => (opts?.method || 'GET') === 'POST',
    );
    expect(postCalls.length).toBeGreaterThan(0);
    expect(postCalls[0][0]).toContain('contributions/post?project=dan-test2');

    // Must NOT attempt a full project load (that path throws "not found").
    const loadCalls = global.fetch.mock.calls.filter(
      ([url]) => url.includes('contributions/get?project=dan-test2')
        && !url.includes('history=true'),
    );
    expect(loadCalls).toHaveLength(0);
  });

  it('sends credentials so the backend registers the creator as admin', async () => {
    mockFetch();
    createContributionsView({ projectName: 'dan-test2', isNew: true });
    await flush();

    const postCall = global.fetch.mock.calls.find(
      ([, opts]) => (opts?.method || 'GET') === 'POST',
    );
    expect(postCall).toBeDefined();
    expect(postCall[1].credentials).toBe('include');
  });

  it('adds the logged-in user as an admin contributor in the POST payload', async () => {
    mockFetch();
    createContributionsView({
      projectName: 'dan-test2',
      isNew: true,
      currentUser: { name: 'Dan Birman', orcid: '0000-0002-1234-5678', is_admin: true },
    });
    await flush();

    const postCall = global.fetch.mock.calls.find(
      ([, opts]) => (opts?.method || 'GET') === 'POST',
    );
    expect(postCall).toBeDefined();
    const payload = JSON.parse(postCall[1].body);
    expect(payload.project_name).toBe('dan-test2');
    expect(payload.contributors).toHaveLength(1);
    const admin = payload.contributors[0];
    expect(admin.author.name).toBe('Dan Birman');
    expect(admin.author.registry_identifier).toBe('0000-0002-1234-5678');
    expect(admin.is_admin).toBe(true);
  });

  it('falls back to the ORCID as the admin name when no name is present', async () => {
    mockFetch();
    createContributionsView({
      projectName: 'dan-test2',
      isNew: true,
      currentUser: { name: null, orcid: '0000-0002-1234-5678', is_admin: true },
    });
    await flush();

    const postCall = global.fetch.mock.calls.find(
      ([, opts]) => (opts?.method || 'GET') === 'POST',
    );
    const payload = JSON.parse(postCall[1].body);
    expect(payload.contributors[0].author.name).toBe('0000-0002-1234-5678');
    expect(payload.contributors[0].is_admin).toBe(true);
  });

  it('surfaces a save failure as an error status (and does not throw)', async () => {
    global.fetch = vi.fn().mockImplementation((url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'boom' }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => [] });
    });
    const root = createContributionsView({ projectName: 'dan-test2', isNew: true });
    await flush();
    const status = root.querySelector('.status-error');
    expect(status).not.toBeNull();
    expect(status.textContent).toContain('boom');
  });
});

// ---------------------------------------------------------------------------
// createContributionsView — author email editing
// ---------------------------------------------------------------------------

/**
 * @vitest-environment happy-dom
 */
describe('createContributionsView — author email', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  const loaded = {
    project_name: 'my-project',
    contributors: [{
      author: { name: 'Alice Smith', email: 'alice@example.org' },
      credit_levels: [],
    }],
  };

  function mockFetch() {
    global.fetch = vi.fn().mockImplementation((url, opts = {}) => {
      if ((opts.method || 'GET') === 'POST') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ commit: 'abc1234567' }) });
      }
      if (url.includes('history=true')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => loaded });
    });
  }

  async function flush() {
    for (let i = 0; i < 15; i += 1) await new Promise((r) => setTimeout(r, 0));
  }

  /** Load the project and select the only author so the detail panel renders. */
  async function mountAndSelect() {
    mockFetch();
    const root = createContributionsView({ projectName: 'my-project' });
    document.body.appendChild(root);
    await flush();
    const selector = root.querySelector('#cv-author-selector');
    selector.value = 'Alice Smith';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    return root;
  }

  it('shows the stored email in the author detail panel', async () => {
    const root = await mountAndSelect();
    expect(root.querySelector('#cv-detail-email').value).toBe('alice@example.org');
  });

  it('saves an edited email back to the endpoint payload', async () => {
    const root = await mountAndSelect();
    const input = root.querySelector('#cv-detail-email');
    input.value = 'alice.smith@allen.org';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();

    root.querySelector('#cv-post-btn').click();
    await flush();

    const postCall = global.fetch.mock.calls.find(
      ([, opts]) => (opts?.method || 'GET') === 'POST',
    );
    const payload = JSON.parse(postCall[1].body);
    expect(payload.contributors[0].author.email).toBe('alice.smith@allen.org');
  });
});

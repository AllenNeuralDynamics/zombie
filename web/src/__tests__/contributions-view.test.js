/**
 * contributions-view.test.js — Unit tests for pure helpers in contributions-view.js.
 *
 * DOM-dependent createContributionsView() is exercised only for basic rendering;
 * network-dependent loading is not tested here.
 */

import { describe, it, expect } from 'vitest';
import {
  CREDIT_CATEGORIES,
  CONTRIBUTION_LEVELS,
  parseAssetNames,
  extractAuthors,
  initMatrix,
  formatAuthorForLatex,
  generateLatex,
} from '../contributions/view.js';

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
      expect(tex).toContain(cat);
    }
  });

  it('uses 0 for None contributions in heatmap', () => {
    const rows = initMatrix(['Alice Smith']);
    // All None by default → all zeros
    const tex = generateLatex(rows);
    expect(tex).toContain('{0,0,0,0,0,0,0,0,0}');
  });

  it('uses \\lo for Low contributions', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0]['Conceptualization'] = 'Low';
    expect(generateLatex(rows)).toContain('\\lo');
  });

  it('uses \\hi for High contributions', () => {
    const rows = initMatrix(['Alice Smith']);
    rows[0]['Conceptualization'] = 'High';
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
  it('has 9 entries', () => {
    expect(CREDIT_CATEGORIES).toHaveLength(9);
  });

  it('includes Conceptualization and Funding acquisition', () => {
    expect(CREDIT_CATEGORIES).toContain('Conceptualization');
    expect(CREDIT_CATEGORIES).toContain('Funding acquisition');
  });
});

describe('CONTRIBUTION_LEVELS', () => {
  it('contains None, Low, High in that order', () => {
    expect(CONTRIBUTION_LEVELS).toEqual(['None', 'Low', 'High']);
  });
});

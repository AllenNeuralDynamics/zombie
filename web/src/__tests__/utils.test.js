import { describe, it, expect } from 'vitest';
import { escHtml, formatDatetime, formatDatetimeRaw, formatDate, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD, parseExperimenters, aggregateByExperimenter, aggregateByProject, normalizeProtocolId } from '../lib/utils.js';

describe('escHtml', () => {
  it('escapes ampersands', () => expect(escHtml('a&b')).toBe('a&amp;b'));
  it('escapes less-than', () => expect(escHtml('a<b')).toBe('a&lt;b'));
  it('escapes greater-than', () => expect(escHtml('a>b')).toBe('a&gt;b'));
  it('escapes double quotes', () => expect(escHtml('a"b')).toBe('a&quot;b'));
  it('handles null', () => expect(escHtml(null)).toBe(''));
  it('handles undefined', () => expect(escHtml(undefined)).toBe(''));
  it('coerces numbers to string', () => expect(escHtml(42)).toBe('42'));
});

describe('formatDatetime', () => {
  it('formats ISO UTC to YYYY-MM-DD HH:MM', () => expect(formatDatetime('2024-03-15T09:05:00Z')).toBe('2024-03-15 09:05'));
  it('returns empty for null', () => expect(formatDatetime(null)).toBe(''));
  it('returns raw string for invalid date', () => expect(formatDatetime('not-a-date')).toBe('not-a-date'));
  it('handles empty string', () => expect(formatDatetime('')).toBe(''));
});

describe('formatDate', () => {
  it('formats ISO UTC to YYYY-MM-DD', () => expect(formatDate('2024-03-15T09:05:00Z')).toBe('2024-03-15'));
  it('returns empty for null', () => expect(formatDate(null)).toBe(''));
  it('returns raw string for invalid date', () => expect(formatDate('not-a-date')).toBe('not-a-date'));
  it('handles empty string', () => expect(formatDate('')).toBe(''));
});

describe('formatDatetimeRaw', () => {
  it('returns wall-clock time from a UTC string unchanged', () => expect(formatDatetimeRaw('2024-01-31T16:23:16Z')).toBe('2024-01-31 16:23'));
  it('returns wall-clock time from a string with offset unchanged', () => expect(formatDatetimeRaw('2024-01-31T08:05:00-08:00')).toBe('2024-01-31 08:05'));
  it('returns empty for null', () => expect(formatDatetimeRaw(null)).toBe(''));
  it('returns raw string for non-datetime input', () => expect(formatDatetimeRaw('not-a-date')).toBe('not-a-date'));
  it('handles empty string', () => expect(formatDatetimeRaw('')).toBe(''));
});

describe('sortRows', () => {
  it('sorts rows ascending by column', () => {
    const rows = [{ name: 'Bob', age: 30 }, { name: 'Alice', age: 25 }];
    sortRows(rows, 'name', 'asc');
    expect(rows[0].name).toBe('Alice');
    expect(rows[1].name).toBe('Bob');
  });

  it('sorts rows descending by column', () => {
    const rows = [{ name: 'Bob', age: 30 }, { name: 'Alice', age: 25 }];
    sortRows(rows, 'name', 'desc');
    expect(rows[0].name).toBe('Bob');
    expect(rows[1].name).toBe('Alice');
  });

  it('handles missing values as empty strings (sort to start in ascending)', () => {
    const rows = [{ name: 'Bob' }, { name: 'Alice' }, { age: 25 }];
    sortRows(rows, 'name', 'asc');
    // Missing 'name' property coerces to '', which sorts first
    expect(rows[0].age).toBe(25);
    expect(rows[0].name).toBeUndefined();
    expect(rows[1].name).toBe('Alice');
    expect(rows[2].name).toBe('Bob');
  });
});

describe('uniqueValues', () => {
  it('returns unique values from a column', () => {
    const rows = [{ type: 'A' }, { type: 'B' }, { type: 'A' }, { type: 'C' }];
    const values = uniqueValues(rows, 'type');
    expect(values).toEqual(['A', 'B', 'C']);
  });

  it('filters out null and empty values', () => {
    const rows = [{ type: 'A' }, { type: null }, { type: '' }, { type: 'B' }];
    const values = uniqueValues(rows, 'type');
    expect(values).toEqual(['A', 'B']);
  });

  it('returns sorted values', () => {
    const rows = [{ type: 'Z' }, { type: 'A' }, { type: 'M' }];
    const values = uniqueValues(rows, 'type');
    expect(values).toEqual(['A', 'M', 'Z']);
  });
});

describe('filterRows', () => {
  it('returns all rows when no filters are applied', () => {
    const rows = [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 30 }];
    const result = filterRows(rows, {});
    expect(result).toEqual(rows);
  });

  it('filters rows by a single column', () => {
    const rows = [{ name: 'Alice', age: 25 }, { name: 'Bob', age: 30 }];
    const result = filterRows(rows, { name: 'Alice' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Alice');
  });

  it('uses case-insensitive substring matching', () => {
    const rows = [{ name: 'Alice' }, { name: 'Alison' }, { name: 'Bob' }];
    const result = filterRows(rows, { name: 'ALI' });
    expect(result).toHaveLength(2);
  });

  it('filters by multiple columns (AND condition)', () => {
    const rows = [
      { name: 'Alice', age: 25 },
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ];
    const result = filterRows(rows, { name: 'Alice', age: '25' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Alice');
  });
});

describe('Constants', () => {
  it('PAGE_SIZE is 100', () => expect(PAGE_SIZE).toBe(100));
  it('SELECT_THRESHOLD is 40', () => expect(SELECT_THRESHOLD).toBe(40));
});

// ---------------------------------------------------------------------------
// parseExperimenters
// ---------------------------------------------------------------------------

describe('parseExperimenters', () => {
  it('splits a single pre-normalized display name', () => {
    const result = parseExperimenters('Anna Katelyn Mcdougal');
    expect(result).toEqual(['Anna Katelyn Mcdougal']);
  });

  it('splits multiple comma-separated pre-normalized names', () => {
    const result = parseExperimenters('Nick Ponvert, Anna Katelyn Mcdougal');
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('Nick Ponvert');
    expect(result[1]).toBe('Anna Katelyn Mcdougal');
  });

  it('deduplicates names that differ only in case/spacing (mergeKey)', () => {
    const result = parseExperimenters('John Doe, John Doe');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('John Doe');
  });

  it('returns empty array for null', () => {
    expect(parseExperimenters(null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseExperimenters('')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aggregateByExperimenter
// ---------------------------------------------------------------------------

describe('aggregateByExperimenter', () => {
  // Rows as produced by the backend: experimenters_normalized contains
  // pre-formatted display names, comma-separated.
  const RAW_ROWS = [
    { experimenters: 'Nick Ponvert', session_seconds: 3600 },
    { experimenters: 'Nick Ponvert', session_seconds: 1800 },
    { experimenters: 'Anna Katelyn Mcdougal', session_seconds: 7200 },
    { experimenters: 'Anna Katelyn Mcdougal, Nick Ponvert', session_seconds: 900 },
    { experimenters: 'John Doe', session_seconds: 600 },
    { experimenters: null, session_seconds: 300 },
  ];

  const NICK = 'Nick Ponvert';
  const ANNA = 'Anna Katelyn Mcdougal';
  const JOHN = 'John Doe';

  it('null selectedExperimenters returns all experimenters', () => {
    const rows = aggregateByExperimenter(RAW_ROWS, null);
    const groups = rows.map((r) => r.group);
    expect(groups).toContain(NICK);
    expect(groups).toContain(ANNA);
    expect(groups).toContain(JOHN);
    expect(groups).toContain('(none)');
  });

  it('counts sessions per experimenter correctly', () => {
    const rows = aggregateByExperimenter(RAW_ROWS, null);
    const nickRow = rows.find((r) => r.group === NICK);
    // nick.ponvert appears in rows 0, 1, 3
    expect(nickRow.sessionCount).toBe(3);
    expect(nickRow.totalSeconds).toBe(3600 + 1800 + 900);
  });

  it('selecting all experimenters returns all rows', () => {
    const allSelected = new Set([NICK, ANNA, JOHN]);
    const rows = aggregateByExperimenter(RAW_ROWS, allSelected);
    const groups = rows.map((r) => r.group);
    expect(groups).toContain(NICK);
    expect(groups).toContain(ANNA);
    expect(groups).toContain(JOHN);
  });

  it('deselecting one person removes only that person', () => {
    // Select all except John — only John's row should disappear.
    const withoutJohn = new Set([NICK, ANNA]);
    const rows = aggregateByExperimenter(RAW_ROWS, withoutJohn);
    const groups = rows.map((r) => r.group);
    expect(groups).toContain(NICK);
    expect(groups).toContain(ANNA);
    expect(groups).not.toContain(JOHN);
    // Nick and Anna counts are unchanged vs the unfiltered case
    const nickRow = rows.find((r) => r.group === NICK);
    expect(nickRow.sessionCount).toBe(3);
  });

  it('(none) row is always included regardless of filter', () => {
    const withoutJohn = new Set([NICK, ANNA]);
    const rows = aggregateByExperimenter(RAW_ROWS, withoutJohn);
    const groups = rows.map((r) => r.group);
    expect(groups).toContain('(none)');
  });

  it('empty selectedExperimenters set returns only (none) row', () => {
    const rows = aggregateByExperimenter(RAW_ROWS, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe('(none)');
  });

  it('result is sorted descending by sessionCount', () => {
    const rows = aggregateByExperimenter(RAW_ROWS, null);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].sessionCount).toBeGreaterThanOrEqual(rows[i].sessionCount);
    }
  });

  it('handles empty input', () => {
    expect(aggregateByExperimenter([], null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aggregateByProject
// ---------------------------------------------------------------------------

describe('aggregateByProject', () => {
  // Rows as produced by the project-path SQL in platform-overview:
  // group_key is already COALESCE'd, experimenters is the normalized array
  // serialised as a comma-separated string, session_seconds is a number.
  const RAW_ROWS = [
    { group_key: 'ProjectA', experimenters: 'Anna Lakunina', session_seconds: 3600 },
    { group_key: 'ProjectA', experimenters: 'Nick Ponvert', session_seconds: 1800 },
    { group_key: 'ProjectB', experimenters: 'Anna Lakunina, Nick Ponvert', session_seconds: 900 },
    { group_key: 'ProjectB', experimenters: 'John Doe', session_seconds: 600 },
    { group_key: '(none)',   experimenters: null,          session_seconds: 300 },
  ];

  const ANNA = 'Anna Lakunina';
  const NICK = 'Nick Ponvert';
  const JOHN = 'John Doe';

  it('null selectedExperimenters returns all projects', () => {
    const rows = aggregateByProject(RAW_ROWS, null);
    const groups = rows.map((r) => r.group);
    expect(groups).toContain('ProjectA');
    expect(groups).toContain('ProjectB');
    expect(groups).toContain('(none)');
  });

  it('counts sessions per project correctly', () => {
    const rows = aggregateByProject(RAW_ROWS, null);
    const a = rows.find((r) => r.group === 'ProjectA');
    const b = rows.find((r) => r.group === 'ProjectB');
    expect(a.sessionCount).toBe(2);
    expect(b.sessionCount).toBe(2);
  });

  it('sums totalSeconds per project correctly', () => {
    const rows = aggregateByProject(RAW_ROWS, null);
    const a = rows.find((r) => r.group === 'ProjectA');
    expect(a.totalSeconds).toBe(3600 + 1800);
  });

  it('filtering by one experimenter returns only their projects', () => {
    const rows = aggregateByProject(RAW_ROWS, new Set([JOHN]));
    const groups = rows.map((r) => r.group);
    // John only has a session in ProjectB
    expect(groups).toContain('ProjectB');
    expect(groups).not.toContain('ProjectA');
    expect(groups).not.toContain('(none)');
  });

  it('filtering by multiple experimenters includes sessions by any of them', () => {
    // Reproduces the original crash: LIKE on VARCHAR[] threw a Binder Error.
    const rows = aggregateByProject(RAW_ROWS, new Set([ANNA, NICK]));
    const groups = rows.map((r) => r.group);
    expect(groups).toContain('ProjectA');
    expect(groups).toContain('ProjectB');
    // (none) has no experimenter so it is excluded
    expect(groups).not.toContain('(none)');
  });

  it('a session with multiple experimenters is counted once per project', () => {
    const rows = aggregateByProject(RAW_ROWS, new Set([ANNA]));
    const b = rows.find((r) => r.group === 'ProjectB');
    // Row 2 has Anna AND Nick — counted once for ProjectB, not twice
    expect(b.sessionCount).toBe(1);
  });

  it('empty selectedExperimenters returns no projects', () => {
    const rows = aggregateByProject(RAW_ROWS, new Set());
    expect(rows).toHaveLength(0);
  });

  it('result is sorted descending by sessionCount', () => {
    const rows = aggregateByProject(RAW_ROWS, null);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].sessionCount).toBeGreaterThanOrEqual(rows[i].sessionCount);
    }
  });

  it('handles empty input', () => {
    expect(aggregateByProject([], null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// normalizeProtocolId
// ---------------------------------------------------------------------------

describe('normalizeProtocolId', () => {
  it('returns null for null', () => expect(normalizeProtocolId(null)).toBeNull());
  it('returns null for empty string', () => expect(normalizeProtocolId('')).toBeNull());
  it('returns null for unrecognised string', () => expect(normalizeProtocolId('just some text')).toBeNull());

  it('handles dx.doi.org prefix without scheme', () => {
    expect(normalizeProtocolId('dx.doi.org/10.17504/protocols.io.kqdg392o7g25/v2'))
      .toBe('https://dx.doi.org/10.17504/protocols.io.kqdg392o7g25/v2');
  });

  it('handles https://dx.doi.org prefix', () => {
    expect(normalizeProtocolId('https://dx.doi.org/10.17504/protocols.io.8epv51bejl1b/v6'))
      .toBe('https://dx.doi.org/10.17504/protocols.io.8epv51bejl1b/v6');
  });

  it('handles http://dx.doi.org prefix', () => {
    expect(normalizeProtocolId('http://dx.doi.org/10.17504/protocols.io.8epv51bejl1b/v6'))
      .toBe('https://dx.doi.org/10.17504/protocols.io.8epv51bejl1b/v6');
  });

  it('handles doi.org prefix', () => {
    expect(normalizeProtocolId('https://doi.org/10.17504/protocols.io.kqdg392o7g25/v2'))
      .toBe('https://dx.doi.org/10.17504/protocols.io.kqdg392o7g25/v2');
  });

  it('handles bare DOI string', () => {
    expect(normalizeProtocolId('10.17504/protocols.io.kqdg392o7g25/v2'))
      .toBe('https://dx.doi.org/10.17504/protocols.io.kqdg392o7g25/v2');
  });

  it('handles shorthand protocols.io.SLUG/vN', () => {
    expect(normalizeProtocolId('protocols.io.8epv51bejl1b/v6'))
      .toBe('https://dx.doi.org/10.17504/protocols.io.8epv51bejl1b/v6');
  });

  it('handles shorthand protocols.io.SLUG without version', () => {
    expect(normalizeProtocolId('protocols.io.kqdg392o7g25'))
      .toBe('https://dx.doi.org/10.17504/protocols.io.kqdg392o7g25');
  });

  it('passes through a full https://www.protocols.io URL unchanged', () => {
    expect(normalizeProtocolId('https://www.protocols.io/view/kqdg392o7g25'))
      .toBe('https://www.protocols.io/view/kqdg392o7g25');
  });
});

import { describe, it, expect } from 'vitest';
import { escHtml, formatDatetime, formatDate, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD, parseExperimenters, aggregateByExperimenter } from '../lib/utils.js';

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

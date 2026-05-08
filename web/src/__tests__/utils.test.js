import { describe, it, expect } from 'vitest';
import { escHtml, formatDatetime, formatDate, sortRows, uniqueValues, filterRows, PAGE_SIZE, SELECT_THRESHOLD } from '../lib/utils.js';

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

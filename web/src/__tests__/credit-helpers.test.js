import { describe, it, expect } from 'vitest';
import {
  hashStr,
  normalizeRole,
  getInitials,
  getLastName,
  getFirstName,
  authorColor,
  CREDIT_ROLES,
  ROLE_GROUP,
} from '../contributions/credit-helpers.js';

describe('hashStr', () => {
  it('returns a non-negative integer', () => expect(hashStr('test')).toBeGreaterThanOrEqual(0));
  it('is deterministic', () => expect(hashStr('abc')).toBe(hashStr('abc')));
  it('differs for different strings', () => expect(hashStr('a')).not.toBe(hashStr('b')));
});

describe('normalizeRole', () => {
  it('lowercases and collapses whitespace', () => expect(normalizeRole('Formal  analysis')).toBe('formal analysis'));
  it('converts em-dash to en-dash', () =>
    expect(normalizeRole('Writing \u2014 original draft')).toBe('writing \u2013 original draft'));
});

describe('getInitials', () => {
  it('returns two-letter initials for full name', () => expect(getInitials('Alice Smith')).toBe('AS'));
  it('returns single letter for mononym', () => expect(getInitials('Mononym')).toBe('M'));
  it('uses first and last for three-part names', () => expect(getInitials('Alice B Smith')).toBe('AS'));
});

describe('getLastName', () => {
  it('returns last word', () => expect(getLastName('Alice Smith')).toBe('Smith'));
  it('handles single name', () => expect(getLastName('Mononym')).toBe('Mononym'));
});

describe('getFirstName', () => {
  it('returns first word', () => expect(getFirstName('Alice Smith')).toBe('Alice'));
});

describe('authorColor', () => {
  it('returns an hsl string', () => {
    const color = authorColor({ name: 'Alice Smith', credit_levels: [{ role: 'Conceptualization', level: 'Lead' }] });
    expect(color).toMatch(/^hsl\(/);
  });
  it('is deterministic for the same name', () => {
    const a = { name: 'Test Author', credit_levels: [{ role: 'Software', level: 'Equal' }] };
    expect(authorColor(a)).toBe(authorColor(a));
  });
  it('handles author with no credit_levels', () => {
    expect(authorColor({ name: 'No Roles' })).toMatch(/^hsl\(/);
  });
});

describe('CREDIT_ROLES', () => {
  it('has 14 entries', () => expect(CREDIT_ROLES).toHaveLength(14));
  it('contains expected roles', () => {
    expect(CREDIT_ROLES).toContain('Conceptualization');
    expect(CREDIT_ROLES).toContain('Software');
    expect(CREDIT_ROLES).toContain('Visualization');
  });
});

describe('ROLE_GROUP', () => {
  it('maps normalized conceptualization to leadership', () =>
    expect(ROLE_GROUP[normalizeRole('Conceptualization')]).toBe('leadership'));
  it('maps normalized software to analysis', () => expect(ROLE_GROUP[normalizeRole('Software')]).toBe('analysis'));
  it('maps normalized methodology to methods', () => expect(ROLE_GROUP[normalizeRole('Methodology')]).toBe('methods'));
  it('maps normalized validation to data', () => expect(ROLE_GROUP[normalizeRole('Validation')]).toBe('data'));
});

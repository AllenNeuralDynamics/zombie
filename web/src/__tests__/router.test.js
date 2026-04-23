/**
 * router.test.js — Unit tests for pure router helpers.
 *
 * Side-effectful APIs (initRouter, navigate) touch window/DOM and are
 * exercised via integration/Playwright tests; only pure functions are
 * covered here.
 */

import { describe, it, expect } from 'vitest';
import { matchRoute, buildNavHref } from '../router.js';

// ---------------------------------------------------------------------------
// matchRoute
// ---------------------------------------------------------------------------

describe('matchRoute', () => {
  const routes = { '/': () => {}, '/assets': () => {}, '/subject': () => {} };

  it('returns the exact match when the path is in routes', () => {
    expect(matchRoute('/', routes)).toBe('/');
    expect(matchRoute('/assets', routes)).toBe('/assets');
    expect(matchRoute('/subject', routes)).toBe('/subject');
  });

  it('falls back to "/" for unknown paths', () => {
    expect(matchRoute('/unknown', routes)).toBe('/');
    expect(matchRoute('', routes)).toBe('/');
    expect(matchRoute('/contributions', routes)).toBe('/');
  });

  it('is case-sensitive (no normalisation)', () => {
    expect(matchRoute('/Assets', routes)).toBe('/');
  });

  it('does not match partial prefixes', () => {
    expect(matchRoute('/assets/extra', routes)).toBe('/');
  });

  it('works with a single-entry routes map', () => {
    expect(matchRoute('/assets', { '/assets': () => {} })).toBe('/assets');
    expect(matchRoute('/', { '/assets': () => {} })).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// buildNavHref
// ---------------------------------------------------------------------------

describe('buildNavHref', () => {
  it('preserves search for "/" when navigating to "/"', () => {
    expect(buildNavHref('/', '?projects=foo')).toBe('/?projects=foo');
    expect(buildNavHref('/', '')).toBe('/');
    expect(buildNavHref('/', '?x=1&y=2')).toBe('/?x=1&y=2');
  });

  it('strips search for non-root paths', () => {
    expect(buildNavHref('/assets', '?projects=foo')).toBe('/assets');
    expect(buildNavHref('/subject', '?id=123')).toBe('/subject');
  });

  it('defaults currentSearch to empty string', () => {
    expect(buildNavHref('/')).toBe('/');
    expect(buildNavHref('/assets')).toBe('/assets');
  });
});

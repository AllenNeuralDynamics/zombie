import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  ROUTES, PAGES, STABILITY_LEVELS, selectRoutes, navGroups,
} from '../../build/routes.js';
import { renderHeader, renderThemeInit } from '../../build/header-template.js';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('routes manifest', () => {
  it('every entry has a route, html path, inputKey, and known stability', () => {
    for (const r of ROUTES) {
      expect(r.route, JSON.stringify(r)).toMatch(/^\//);
      expect(r.html, JSON.stringify(r)).toBeTruthy();
      expect(r.inputKey, JSON.stringify(r)).toBeTruthy();
      expect(STABILITY_LEVELS, JSON.stringify(r)).toContain(r.stability);
    }
  });

  it('has no duplicate routes, html paths, or input keys', () => {
    for (const field of ['route', 'html', 'inputKey']) {
      const values = ROUTES.map((r) => r[field]);
      expect(new Set(values).size, `duplicate ${field}`).toBe(values.length);
    }
  });

  it('every manifest html file exists on disk', () => {
    for (const r of ROUTES) {
      expect(existsSync(resolve(webRoot, r.html)), `${r.html} missing`).toBe(true);
    }
  });

  it('routes match their html path (generic Nginx resolution relies on this)', () => {
    for (const r of ROUTES) {
      const expectedRoute = '/' + r.html.replace(/\.html$/, '');
      const isRoot = r.html === 'index.html';
      if (!isRoot) {
        expect(r.route, r.html).toBe(expectedRoute);
      }
    }
  });

  it('every nav-linked page also has header config', () => {
    for (const r of ROUTES) {
      if (r.nav) expect(r.header, `${r.html} has nav but no header`).toBeTruthy();
    }
  });

  it('renderHeader works for every page with header config', () => {
    for (const r of ROUTES) {
      if (!r.header) continue;
      const html = renderHeader(r.header);
      expect(html).toContain('<header class="app-header">');
      expect(html).toContain(r.header.sub);
    }
  });

  it('nav groups only contain unique, non-empty labels', () => {
    for (const group of Object.values(navGroups())) {
      const labels = group.map(([, label]) => label);
      expect(new Set(labels).size).toBe(labels.length);
      for (const [href, label] of group) {
        expect(href).toMatch(/^\//);
        expect(label).toBeTruthy();
      }
    }
  });

  it('PAGES is keyed by html path and matches manifest header config', () => {
    for (const r of ROUTES) {
      if (r.header) expect(PAGES[r.html]).toBe(r.header);
    }
  });

  it('renderThemeInit returns a single inline script tag', () => {
    const html = renderThemeInit();
    expect(html).toContain('<script>');
    expect(html).toContain("localStorage.getItem('theme')");
  });
});

describe('release channels', () => {
  it('the stable channel drops every experimental page', () => {
    const stable = selectRoutes();
    expect(stable.length).toBeLessThan(ROUTES.length);
    expect(stable.every((r) => r.stability === 'stable')).toBe(true);
  });

  it('the dev channel ships everything', () => {
    expect(selectRoutes({ includeExperimental: true })).toEqual(ROUTES);
  });

  it('experimental pages are absent from the stable nav', () => {
    const stable = selectRoutes();
    const linked = Object.values(navGroups(stable)).flat().map(([href]) => href);
    for (const r of ROUTES) {
      if (r.stability === 'experimental' && r.nav) {
        expect(linked, `${r.route} still linked`).not.toContain(r.route);
      }
    }
  });

  it('a stable page never links to an experimental one from the shared nav', () => {
    const stable = selectRoutes();
    const shipped = new Set(stable.map((r) => r.route));
    for (const [href] of Object.values(navGroups(stable)).flat()) {
      expect(shipped, `${href} is linked but not built`).toContain(href);
    }
  });

  it('renderHeader omits experimental links when given the stable route list', () => {
    const stable = selectRoutes();
    const html = renderHeader({ sub: 'search' }, stable);
    for (const r of ROUTES) {
      if (r.stability === 'experimental') {
        expect(html, `${r.route} leaked into the stable header`).not.toContain(`href="${r.route}"`);
      }
    }
    expect(html).toContain('href="/search"');
  });
});

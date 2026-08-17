/**
 * contributions-preview.test.js — Defaults the preview widget picks up from
 * the data it is handed.
 *
 * Two rules the widget has to get right on first render, before the user
 * touches anything:
 *   - a project that set a publication order gets sorted by it;
 *   - a project that assigned author levels gets them grouped.
 * In both cases the control is hidden entirely when the underlying data is
 * empty, so an unset order can never be presented as a choice.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createPreview } from '../contributions/preview.js';

function author(name, extra = {}) {
  return {
    name,
    author_level: null,
    publication_order: null,
    credit_levels: [{ role: 'Software', level: 'equal' }],
    ...extra,
  };
}

/** Render into a fresh container and switch to the author-list tab. */
function renderList(authors, options = {}) {
  const container = document.createElement('div');
  container.dataset.cvTab = 'authors';
  document.body.appendChild(container);
  createPreview(container, authors, options);
  return container;
}

function bylineNames(container) {
  return [...container.querySelectorAll('.ae-name')].map((n) => n.textContent);
}

function sortDescription(container) {
  return container.querySelector('.ae-sort-desc')?.textContent ?? '';
}

function chipLabels(container) {
  return [...container.querySelectorAll('.ae-chip')].map((c) => c.textContent);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('publication order default', () => {
  const ordered = [
    author('Zoe Adams', { publication_order: 2 }),
    author('Amy Baker', { publication_order: 1 }),
  ];

  it('sorts by publication order when the project set one', () => {
    const c = renderList(ordered);
    expect(bylineNames(c)).toEqual(['Amy Baker', 'Zoe Adams']);
    expect(sortDescription(c)).toContain('As listed in the publication');
  });

  it('offers a publication-order chip when an order is set', () => {
    expect(chipLabels(renderList(ordered))).toContain('Publication order');
  });

  it('falls back to alphabetical when no order is set', () => {
    const c = renderList([author('Zoe Adams'), author('Amy Baker')]);
    // Alphabetical is by last name: Adams before Baker — the opposite of what
    // the publication order in the test above produces.
    expect(bylineNames(c)).toEqual(['Zoe Adams', 'Amy Baker']);
    expect(sortDescription(c)).toContain('Alphabetical');
  });

  it('hides the publication-order chip when the order is empty', () => {
    const c = renderList([author('Zoe Adams'), author('Amy Baker')]);
    expect(chipLabels(c)).not.toContain('Publication order');
  });

  it('ignores a partially set order for the chip only if nothing is set', () => {
    // One author with an order is enough for the project to count as ordered.
    const c = renderList([author('Zoe Adams'), author('Amy Baker', { publication_order: 1 })]);
    expect(chipLabels(c)).toContain('Publication order');
    expect(bylineNames(c)).toEqual(['Amy Baker', 'Zoe Adams']);
  });
});

describe('author levels default', () => {
  const withLevels = [
    author('Amy Baker', { author_level: 'first' }),
    author('Mid Person'),
    author('Zoe Adams', { author_level: 'senior' }),
  ];

  it('turns the author-levels grouping on when levels have been set', () => {
    const c = renderList(withLevels);
    expect(c.querySelector('.ae-toggle-track.ae-toggle-on')).toBeTruthy();
    // Grouping renders separators between first / middle / senior.
    expect(c.querySelectorAll('.ae-level-group-sep').length).toBe(2);
  });

  it('offers the toggle when levels have been set', () => {
    const c = renderList(withLevels);
    expect(c.querySelector('.ae-author-levels-wrap')).toBeTruthy();
  });

  it('hides the toggle entirely when no author has a level', () => {
    const c = renderList([author('Amy Baker'), author('Zoe Adams')]);
    expect(c.querySelector('.ae-author-levels-wrap')).toBeNull();
    expect(c.querySelectorAll('.ae-level-group-sep').length).toBe(0);
  });

  it('lets an explicit user choice override the default', () => {
    const container = document.createElement('div');
    container.dataset.cvTab = 'authors';
    // Simulates the user having switched the toggle off.
    container.dataset.cvUseAuthorLevels = 'false';
    document.body.appendChild(container);
    createPreview(container, withLevels, {});
    expect(container.querySelector('.ae-toggle-track.ae-toggle-on')).toBeNull();
    expect(container.querySelectorAll('.ae-level-group-sep').length).toBe(0);
  });
});

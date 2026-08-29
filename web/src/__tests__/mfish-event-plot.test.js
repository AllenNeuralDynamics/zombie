/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/behaviors/brush-overview.js', () => ({
  createBrushOverview: vi.fn((config) => {
    const overviewHolder = document.createElement('div');
    const mainHolder = document.createElement('div');
    const mainWrap = document.createElement('div');
    mainWrap.appendChild(mainHolder);
    const element = document.createElement('div');
    element.append(overviewHolder, mainWrap);

    const rerender = () => {
      config.renderOverview(overviewHolder, 600);
      config.renderMain(mainHolder, 600, [0, config.sessionEndS || 1]);
    };
    rerender();

    return {
      element,
      mainWrap,
      updatePlayhead: vi.fn(),
      setOnScrub: vi.fn(),
      setOnDomainChange: vi.fn(),
      setDomain: vi.fn(),
      redrawMain: vi.fn(rerender),
      dispose: vi.fn(),
    };
  }),
}));

import { createMfishEventPlot } from '../mfish/event-plot.js';

function makeData(overrides = {}) {
  return {
    stimuli: [{ t: 1, tEnd: 1.25, ori: 0, omitted: false }],
    changes: [1],
    running: { t: [0, 1, 2], v: [0, 0.5, 1] },
    rewards: [1.2],
    licks: [],
    sessionEndS: 10,
    variant: 'gratings',
    ...overrides,
  };
}

describe('mFISH event plot subclass-activity row', () => {
  it('renders only the five fixed rows when no subclass activity is supplied', () => {
    const plot = createMfishEventPlot(makeData());
    const labels = [...plot.element.querySelectorAll('div')].map((el) => el.textContent);
    expect(labels).toContain('Running');
    expect(labels).not.toContain('Cell activity');
  });

  it('adds a "Cell activity" row with a color key when subclass activity is supplied upfront', () => {
    const plot = createMfishEventPlot(makeData(), {
      subclassActivity: {
        rows: [
          { cell_subclass: 'Pvalb', t: 0, activity: 0.1 },
          { cell_subclass: 'Pvalb', t: 1, activity: 0.4 },
          { cell_subclass: 'Sst', t: 0, activity: 0.2 },
          { cell_subclass: 'Sst', t: 1, activity: 0.1 },
        ],
        subclasses: ['Pvalb', 'Sst'],
        minTime: 0,
        maxTime: 1,
      },
    });
    const text = plot.element.textContent;
    expect(text).toContain('Cell activity');
    expect(text).toContain('Pvalb');
    expect(text).toContain('Sst');
    const svg = plot.element.querySelector('svg');
    expect(svg.querySelectorAll('path, g').length).toBeGreaterThan(0);
  });

  it('adds the row later via setSubclassActivity for data that resolves after the plot is built', () => {
    const plot = createMfishEventPlot(makeData());
    expect(plot.element.textContent).not.toContain('Cell activity');

    plot.setSubclassActivity({
      rows: [{ cell_subclass: 'Vip', t: 0, activity: 0.3 }],
      subclasses: ['Vip'],
      minTime: 0,
      maxTime: 1,
    });

    expect(plot.element.textContent).toContain('Cell activity');
    expect(plot.element.textContent).toContain('Vip');
  });

  it('drops the row again when handed an empty series', () => {
    const plot = createMfishEventPlot(makeData(), {
      subclassActivity: {
        rows: [{ cell_subclass: 'Vip', t: 0, activity: 0.3 }],
        subclasses: ['Vip'],
        minTime: 0,
        maxTime: 1,
      },
    });
    expect(plot.element.textContent).toContain('Cell activity');

    plot.setSubclassActivity({ rows: [], subclasses: [], minTime: 0, maxTime: 0 });

    expect(plot.element.textContent).not.toContain('Cell activity');
  });
});

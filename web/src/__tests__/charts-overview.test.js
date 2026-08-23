/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@observablehq/plot', () => ({
  rectY: vi.fn((data, options) => ({ data, options })),
  stackY: vi.fn((options) => options),
  plot: vi.fn((options) => {
    const svg = document.createElement('svg');
    svg.plotOptions = options;
    return svg;
  }),
}));

import * as Plot from '@observablehq/plot';
import {
  buildAssetOverviewHistogram,
  buildInteractiveAssetOverviewHistogram,
} from '../lib/charts.js';

const assets = [
  {
    name: 'early',
    acquisition_start_time: '2020-01-15T00:00:00Z',
    dataset: 'dataset-a',
    modalities: ['pophys'],
  },
  {
    name: 'late',
    acquisition_start_time: '2024-06-15T00:00:00Z',
    dataset: 'dataset-b',
    modalities: ['ecephys'],
  },
];

describe('asset overview histogram axis', () => {
  beforeEach(() => {
    Plot.plot.mockClear();
    document.body.innerHTML = '';
  });

  it('keeps the x-axis domain fixed while hovering dataset groups', () => {
    const chart = buildInteractiveAssetOverviewHistogram(assets, 700, {
      groupBy: 'dataset',
      hoverFilters: true,
    });
    const legendItems = chart.querySelectorAll('.modality-legend-item');
    const initialDomain = Plot.plot.mock.calls[0][0].x.domain;
    const initialYDomain = Plot.plot.mock.calls[0][0].y.domain;

    legendItems[0].dispatchEvent(new Event('mouseenter'));
    const hoveredDomain = Plot.plot.mock.calls[1][0].x.domain;
    const hoveredYDomain = Plot.plot.mock.calls[1][0].y.domain;
    legendItems[0].dispatchEvent(new Event('mouseleave'));
    const clearedDomain = Plot.plot.mock.calls[2][0].x.domain;
    const clearedYDomain = Plot.plot.mock.calls[2][0].y.domain;

    expect(hoveredDomain).toEqual(initialDomain);
    expect(clearedDomain).toEqual(initialDomain);
    expect(hoveredYDomain).toEqual(initialYDomain);
    expect(clearedYDomain).toEqual(initialYDomain);
  });

  it('keeps the x-axis domain fixed when modality groups are hidden', () => {
    buildAssetOverviewHistogram(assets, 700, { groupBy: 'modality' });
    const initialDomain = Plot.plot.mock.calls[0][0].x.domain;
    const initialYDomain = Plot.plot.mock.calls[0][0].y.domain;

    buildAssetOverviewHistogram(assets, 700, {
      groupBy: 'modality',
      hiddenGroups: new Set(['pophys']),
    });
    const hiddenDomain = Plot.plot.mock.calls[1][0].x.domain;
    const hiddenYDomain = Plot.plot.mock.calls[1][0].y.domain;

    expect(hiddenDomain).toEqual(initialDomain);
    expect(hiddenYDomain).toEqual(initialYDomain);
  });

  it('merges modalities across duplicate dataset-membership rows', () => {
    const chart = buildInteractiveAssetOverviewHistogram([
      {
        name: 'shared-asset',
        acquisition_start_time: '2024-06-15T00:00:00Z',
        modalities: ['pophys'],
        dataset: 'dataset-a',
      },
      {
        name: 'shared-asset',
        acquisition_start_time: '2024-06-15T00:00:00Z',
        modalities: ['behavior'],
        dataset: 'dataset-b',
      },
    ], 700, { groupBy: 'modality' });

    expect([...chart.querySelectorAll('.modality-legend-item')]
      .map((item) => item.textContent.trim()))
      .toEqual(expect.arrayContaining(['pophys', 'behavior']));
    expect(chart.querySelectorAll('.modality-legend-item')).toHaveLength(2);
  });

  it('keeps the Y domain stable when switching overview groupings', () => {
    const memberships = [
      {
        name: 'shared-asset',
        acquisition_start_time: '2024-06-15T00:00:00Z',
        modalities: ['behavior'],
        dataset: 'dataset-a',
      },
      {
        name: 'shared-asset',
        acquisition_start_time: '2024-06-15T00:00:00Z',
        modalities: ['behavior'],
        dataset: 'dataset-b',
      },
    ];

    buildInteractiveAssetOverviewHistogram(memberships, 700, { groupBy: 'dataset' });
    const datasetYDomain = Plot.plot.mock.calls[0][0].y.domain;
    buildInteractiveAssetOverviewHistogram(memberships, 700, { groupBy: 'modality' });
    const modalityYDomain = Plot.plot.mock.calls[1][0].y.domain;

    expect(modalityYDomain).toEqual(datasetYDomain);
  });
});

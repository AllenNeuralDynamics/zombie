/**
 * subject-timeline-dom.test.js — DOM tests for createSubjectTimeline: derived-asset
 * deep-link matching and arrow-key event navigation.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSubjectTimeline } from '../subject/timeline.js';

const acq = (name, dateStr) => ({
  start: new Date(dateStr),
  end: new Date(dateStr),
  event: 'Acquisition',
  type: 'Acquisition',
  modalities: [],
  data: { _assetName: name },
});

const EVENTS = [
  acq('multiplane-ophys_849375_2026-06-01_10-00-00', '2026-06-01T10:00:00Z'),
  acq('multiplane-ophys_849375_2026-07-01_13-08-57', '2026-07-01T13:08:57Z'),
  acq('multiplane-ophys_849375_2026-08-01_09-00-00', '2026-08-01T09:00:00Z'),
];

let container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

function selectedName(tl) {
  const bubbles = [...tl.querySelectorAll('.tl-bubble')];
  const idx = bubbles.findIndex((b) => b.classList.contains('tl-bubble--selected'));
  return idx;
}

describe('selectAcquisition', () => {
  it('selects by exact raw asset name', () => {
    const tl = createSubjectTimeline(EVENTS);
    container.appendChild(tl);
    expect(tl.selectAcquisition('multiplane-ophys_849375_2026-07-01_13-08-57')).toBe(true);
    expect(selectedName(tl)).toBe(1);
  });

  it('matches a derived asset name to its source raw acquisition (prefix)', () => {
    const tl = createSubjectTimeline(EVENTS);
    container.appendChild(tl);
    const derived = 'multiplane-ophys_849375_2026-07-01_13-08-57_processed_2026-07-02_00-54-28';
    expect(tl.selectAcquisition(derived)).toBe(true);
    expect(selectedName(tl)).toBe(1);
  });

  it('returns false when nothing matches', () => {
    const tl = createSubjectTimeline(EVENTS);
    container.appendChild(tl);
    expect(tl.selectAcquisition('unrelated_asset_2020-01-01')).toBe(false);
  });
});

describe('arrow-key navigation', () => {
  const press = (tl, key) => {
    const strip = tl.querySelector('.subject-timeline-bubbles');
    strip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  it('moves to the future with ArrowRight and past with ArrowLeft', () => {
    const tl = createSubjectTimeline(EVENTS);
    container.appendChild(tl);
    tl.selectAcquisition('multiplane-ophys_849375_2026-07-01_13-08-57');
    expect(selectedName(tl)).toBe(1);
    press(tl, 'ArrowRight');
    expect(selectedName(tl)).toBe(2);
    press(tl, 'ArrowLeft');
    expect(selectedName(tl)).toBe(1);
    press(tl, 'ArrowLeft');
    expect(selectedName(tl)).toBe(0);
  });

  it('clamps at the ends (no wrap-around)', () => {
    const tl = createSubjectTimeline(EVENTS);
    container.appendChild(tl);
    tl.selectAcquisition('multiplane-ophys_849375_2026-06-01_10-00-00');
    expect(selectedName(tl)).toBe(0);
    press(tl, 'ArrowLeft');
    expect(selectedName(tl)).toBe(0);
  });
});

describe('selectAcquisition — provenance', () => {
  // The V1 deep-dive shape: the timeline acquisition is itself a derived NWB
  // asset (no source_data), and a `_filtered_` child hangs off it. The child's
  // name does not extend its parent's, so prefix matching cannot find it.
  const V1DD_ACQ = '427836_2019-04-24_13-06-45_nwb_2026-02-25_12-59-31';
  const V1DD_FILTERED = '427836_2019-04-24_13-06-45_filtered_2026-04-09_08-20-51';

  const V1DD_EVENTS = [
    acq('427836_2019-04-24_11-00-00', '2019-04-24T11:00:00Z'),
    acq(V1DD_ACQ, '2019-04-24T13:06:45Z'),
  ];

  const sources = new Map([
    [V1DD_ACQ, []],
    [V1DD_FILTERED, [V1DD_ACQ]],
  ]);

  it('resolves a derived child to its acquisition via source_data', () => {
    const tl = createSubjectTimeline(V1DD_EVENTS, { assetSources: sources });
    container.appendChild(tl);
    expect(tl.selectAcquisition(V1DD_FILTERED)).toBe(true);
    expect(selectedName(tl)).toBe(1);
  });

  it('cannot resolve that child without provenance (prefix matching fails)', () => {
    const tl = createSubjectTimeline(V1DD_EVENTS);
    container.appendChild(tl);
    expect(tl.selectAcquisition(V1DD_FILTERED)).toBe(false);
  });

  it('walks multiple provenance hops', () => {
    const deep = new Map([
      ...sources,
      ['grandchild_2026', [V1DD_FILTERED]],
    ]);
    const tl = createSubjectTimeline(V1DD_EVENTS, { assetSources: deep });
    container.appendChild(tl);
    expect(tl.selectAcquisition('grandchild_2026')).toBe(true);
    expect(selectedName(tl)).toBe(1);
  });

  it('does not loop on a cyclic provenance map', () => {
    const cyclic = new Map([['a', ['b']], ['b', ['a']]]);
    const tl = createSubjectTimeline(V1DD_EVENTS, { assetSources: cyclic });
    container.appendChild(tl);
    expect(tl.selectAcquisition('a')).toBe(false);
  });

  it('still falls back to prefix matching for assets absent from the map', () => {
    const tl = createSubjectTimeline(V1DD_EVENTS, { assetSources: sources });
    container.appendChild(tl);
    expect(tl.selectAcquisition(`${V1DD_ACQ}_processed_2026-09-01`)).toBe(true);
    expect(selectedName(tl)).toBe(1);
  });

  it('reports programmatic selection to onSelect', () => {
    const calls = [];
    const tl = createSubjectTimeline(V1DD_EVENTS, {
      assetSources: sources,
      onSelect: (ev, info) => calls.push([ev.data._assetName, info?.programmatic]),
    });
    container.appendChild(tl);
    tl.selectAcquisition(V1DD_FILTERED);
    expect(calls).toEqual([[V1DD_ACQ, true]]);

    container.querySelectorAll('.tl-bubble')[0].click();
    expect(calls[1]).toEqual(['427836_2019-04-24_11-00-00', false]);
  });
});

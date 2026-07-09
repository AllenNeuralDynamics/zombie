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

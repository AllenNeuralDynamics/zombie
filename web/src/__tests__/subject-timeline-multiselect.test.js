/**
 * subject-timeline-multiselect.test.js — shift/ctrl-click multi-selection on the
 * subject timeline bubble strip.
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
  modalities: ['behavior'],
  data: { _assetName: name },
});

const surgery = (dateStr) => ({
  start: new Date(dateStr),
  end: new Date(dateStr),
  event: 'Surgery',
  type: 'Surgery',
  data: {},
});

const EVENTS = [
  acq('behavior_844634_2026-05-01_120000', '2026-05-01T12:00:00Z'),
  acq('behavior_844634_2026-05-02_120000', '2026-05-02T12:00:00Z'),
  surgery('2026-05-03T12:00:00Z'),
  acq('behavior_844634_2026-05-04_120000', '2026-05-04T12:00:00Z'),
  acq('behavior_844634_2026-05-05_120000', '2026-05-05T12:00:00Z'),
];

let container;
let calls;

function build(events = EVENTS) {
  calls = [];
  const tl = createSubjectTimeline(events, {
    onSelect: (ev, info) => calls.push({ ev, info }),
  });
  container.appendChild(tl);
  return tl;
}

const bubbles = (tl) => [...tl.querySelectorAll('.tl-bubble')];
const selectedIdxs = (tl) => bubbles(tl)
  .map((b, i) => (b.classList.contains('tl-bubble--selected') ? i : -1))
  .filter((i) => i !== -1);

function click(tl, idx, mods = {}) {
  bubbles(tl)[idx].dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }),
  );
}

const lastSelection = () => calls[calls.length - 1].info.selection;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('plain click', () => {
  it('selects one event and reports a single-entry selection', () => {
    const tl = build();
    click(tl, 1);
    expect(selectedIdxs(tl)).toEqual([1]);
    expect(lastSelection()).toHaveLength(1);
    expect(lastSelection()[0].data._assetName).toBe('behavior_844634_2026-05-02_120000');
  });

  it('replaces a previous multi-selection', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 4, { shiftKey: true });
    expect(selectedIdxs(tl).length).toBeGreaterThan(1);
    click(tl, 3);
    expect(selectedIdxs(tl)).toEqual([3]);
    expect(lastSelection()).toHaveLength(1);
  });
});

describe('shift+click', () => {
  it('selects the acquisitions between the anchor and the clicked bubble', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 3, { shiftKey: true });
    // Index 2 is a surgery and stays out of the range.
    expect(selectedIdxs(tl)).toEqual([0, 1, 3]);
    expect(lastSelection().map((ev) => ev.data._assetName)).toEqual([
      'behavior_844634_2026-05-01_120000',
      'behavior_844634_2026-05-02_120000',
      'behavior_844634_2026-05-04_120000',
    ]);
  });

  it('extends backwards from the anchor too', () => {
    const tl = build();
    click(tl, 4);
    click(tl, 3, { shiftKey: true });
    expect(selectedIdxs(tl)).toEqual([3, 4]);
  });

  it('re-extends from the same anchor on a second shift+click', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 4, { shiftKey: true });
    click(tl, 1, { shiftKey: true });
    expect(selectedIdxs(tl)).toEqual([0, 1]);
  });

  it('reports the clicked event as the acted-on event', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 3, { shiftKey: true });
    expect(calls[calls.length - 1].ev.data._assetName)
      .toBe('behavior_844634_2026-05-04_120000');
  });

  it('falls back to a single select when the target is not an acquisition', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 2, { shiftKey: true });
    expect(selectedIdxs(tl)).toEqual([2]);
    expect(lastSelection()).toHaveLength(1);
  });

  it('falls back to a single select when the anchor is not an acquisition', () => {
    const tl = build();
    click(tl, 2);
    click(tl, 4, { shiftKey: true });
    expect(selectedIdxs(tl)).toEqual([4]);
  });

  it('marks multi-selected bubbles so they can be styled as a group', () => {
    const tl = build();
    click(tl, 0);
    expect(bubbles(tl)[0].classList.contains('tl-bubble--multi')).toBe(false);
    click(tl, 1, { shiftKey: true });
    expect(bubbles(tl).map((b) => b.classList.contains('tl-bubble--multi')))
      .toEqual([true, true, false, false, false]);
  });
});

describe('ctrl/cmd+click', () => {
  it('adds and removes individual acquisitions', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 4, { ctrlKey: true });
    expect(selectedIdxs(tl)).toEqual([0, 4]);
    click(tl, 0, { metaKey: true });
    expect(selectedIdxs(tl)).toEqual([4]);
    expect(lastSelection()).toHaveLength(1);
  });

  it('never empties the selection', () => {
    const tl = build();
    click(tl, 1);
    click(tl, 1, { ctrlKey: true });
    expect(selectedIdxs(tl)).toEqual([1]);
  });
});

describe('selectLastAcquisitions', () => {
  it('selects the most recent N acquisitions, skipping other event types', () => {
    const tl = build();
    expect(tl.selectLastAcquisitions(3)).toBe(true);
    // Index 2 is a surgery; the three most recent acquisitions are 1, 3, 4.
    expect(selectedIdxs(tl)).toEqual([1, 3, 4]);
    expect(lastSelection()).toHaveLength(3);
    expect(calls[calls.length - 1].info.programmatic).toBe(true);
  });

  it('clamps to however many acquisitions exist', () => {
    const tl = build();
    expect(tl.selectLastAcquisitions(99)).toBe(true);
    expect(selectedIdxs(tl)).toEqual([0, 1, 3, 4]);
  });

  it('refuses counts below two and selections with too few acquisitions', () => {
    const tl = build();
    expect(tl.selectLastAcquisitions(1)).toBe(false);
    expect(tl.selectLastAcquisitions(0)).toBe(false);
    expect(selectedIdxs(tl)).toEqual([]);

    const sparse = build([EVENTS[0], EVENTS[2]]);
    expect(sparse.selectLastAcquisitions(5)).toBe(false);
  });

  it('anchors on the newest session, so shift+click extends backwards', () => {
    const tl = build();
    tl.selectLastAcquisitions(2);
    expect(selectedIdxs(tl)).toEqual([3, 4]);
    click(tl, 0, { shiftKey: true });
    expect(selectedIdxs(tl)).toEqual([0, 1, 3, 4]);
  });
});

describe('collapseSelection', () => {
  it('falls back to the anchor and reports a single selection', () => {
    const tl = build();
    tl.selectLastAcquisitions(3);
    expect(selectedIdxs(tl)).toEqual([1, 3, 4]);
    expect(tl.collapseSelection()).toBe(true);
    // selectLastAcquisitions anchors on the newest session.
    expect(selectedIdxs(tl)).toEqual([4]);
    expect(lastSelection()).toHaveLength(1);
  });

  it('keeps the newest selected event when the anchor is not in the selection', () => {
    const tl = build();
    click(tl, 4);
    click(tl, 0, { shiftKey: true });
    click(tl, 4, { ctrlKey: true }); // drop the anchor from the selection
    expect(tl.collapseSelection()).toBe(true);
    expect(selectedIdxs(tl)).toEqual([3]);
  });

  it('is a no-op on a single selection', () => {
    const tl = build();
    click(tl, 1);
    const before = calls.length;
    expect(tl.collapseSelection()).toBe(false);
    expect(calls).toHaveLength(before);
  });
});

describe('selection and existing navigation', () => {
  it('arrow keys collapse a multi-selection back to one event', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 4, { shiftKey: true });
    tl.querySelector('.subject-timeline-bubbles').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    // The anchor (index 0) moves one step into the future.
    expect(selectedIdxs(tl)).toEqual([1]);
  });

  it('selectAcquisition() resets to a single selection and exposes it', () => {
    const tl = build();
    click(tl, 0);
    click(tl, 4, { shiftKey: true });
    expect(tl.getSelection()).toHaveLength(4);
    expect(tl.selectAcquisition('behavior_844634_2026-05-04_120000')).toBe(true);
    expect(selectedIdxs(tl)).toEqual([3]);
    expect(tl.getSelection()).toHaveLength(1);
  });
});

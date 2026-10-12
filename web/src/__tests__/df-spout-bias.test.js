/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getShowSpoutBias, setShowSpoutBias } from '../dynamic_foraging/preferences.js';
import { _buildSpoutBiasData, createProbPlot } from '../dynamic_foraging/prob-plot.js';
import { _normalizeTrial, loadDfSession } from '../dynamic_foraging/data-loader.js';

vi.mock('../lib/behaviors/brush-overview.js', () => ({
  createBrushOverview: ({ renderMain }) => {
    const element = document.createElement('div');
    const mainWrap = document.createElement('div');
    const holder = document.createElement('div');
    mainWrap.append(holder);
    element.append(mainWrap);
    const redrawMain = () => renderMain(holder, 700, [0, 20]);
    redrawMain();
    return { element, mainWrap, overviewWrap: document.createElement('div'), redrawMain,
      dispose: vi.fn(), updatePlayhead: vi.fn(), setOnScrub: vi.fn() };
  },
}));

const trials = [
  { goCue_t: 0, pL: 0.5, pR: 0.1, side_bias: 0, lickspout_position_x: -3.2 },
  { goCue_t: 10, pL: 0.1, pR: 0.5, side_bias: 0.48, lickspout_position_x: -3.6 },
];

describe('DF spout position and bias', () => {
  beforeEach(() => localStorage.clear());

  it('restores the toggle and plot when another acquisition is displayed', () => {
    const first = createProbPlot({ trials, sessionEndS: 20 });
    const toggle = first.element.querySelector('input');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(getShowSpoutBias()).toBe(true);
    first.dispose();
    const next = createProbPlot({ trials: trials.slice(1), sessionEndS: 20 });
    expect(next.element.querySelector('input').checked).toBe(true);
    expect(next.element.querySelector('.df-spout-bias-row')).not.toBeNull();
    const nextToggle = next.element.querySelector('input');
    nextToggle.checked = false;
    nextToggle.dispatchEvent(new Event('change'));
    expect(getShowSpoutBias()).toBe(false);
    const last = createProbPlot({ trials, sessionEndS: 20 });
    expect(last.element.querySelector('input').checked).toBe(false);
    expect(last.element.querySelector('.df-spout-bias-row')).toBeNull();
  });

  it('keeps plotting when browser storage is unavailable', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
    try {
      expect(getShowSpoutBias()).toBe(false);
      expect(() => setShowSpoutBias(true)).not.toThrow();
    } finally {
      read.mockRestore();
      write.mockRestore();
    }
  });

  it('normalizes numeric optional values while preserving missing data', () => {
    expect(_normalizeTrial({ side_bias: '0.48', lickspout_position_x: -3.2,
      lickspout_position_y1: NaN })).toMatchObject({
      side_bias: 0.48, lickspout_position_x: -3.2, lickspout_position_y1: null,
      lickspout_position_y2: null, lickspout_position_z: null,
    });
  });

  it('retains zero bias, breaks at missing samples, and ends at each session boundary', () => {
    const rows = _buildSpoutBiasData([
      { goCue_t: 0, side_bias: 0, session: 0, sessionEnd_t: 5 },
      { goCue_t: 2, side_bias: null, session: 0, sessionEnd_t: 5 },
      { goCue_t: 5, side_bias: 0.4, session: 5, sessionEnd_t: 8 },
    ], 8);
    expect(rows.map((r) => [r.t, r.value])).toEqual([[0, 0], [2, 0], [5, 0.4], [8, 0.4]]);
    expect(rows[0].group).not.toBe(rows[2].group);
  });

  it('shows only X displacement and bias with one baseline across sessions', () => {
    const rows = _buildSpoutBiasData([
      { goCue_t: 0, lickspout_position_x: 10, side_bias: 0, lickspout_position_y1: 99,
        lickspout_position_y2: 98, lickspout_position_z: 97, session: 0, sessionEnd_t: 5 },
      { goCue_t: 2, lickspout_position_x: 12, session: 0, sessionEnd_t: 5 },
      { goCue_t: 5, lickspout_position_x: 15, side_bias: 0.4, session: 5, sessionEnd_t: 8 },
    ], 8);
    expect([...new Set(rows.map((r) => r.series))]).toEqual(['X', 'Bias']);
    const x = rows.filter((r) => r.series === 'X');
    expect(x.map((r) => [r.t, r.value])).toEqual([[0, 0], [2, 0], [2, 2], [5, 2], [5, 5], [8, 5]]);
    expect(x[0].group).not.toBe(x[4].group);
    expect(_buildSpoutBiasData([{ goCue_t: 0, lickspout_position_x: 15 }], 8, 10)[0].value).toBe(5);
  });

  it('does not replace a missing initial X with a later sample', () => {
    const rows = _buildSpoutBiasData([
      { goCue_t: 0, lickspout_position_x: null, side_bias: 0 },
      { goCue_t: 2, lickspout_position_x: 12, side_bias: 0.4 },
    ], 8);
    expect(rows.every((r) => r.series === 'Bias')).toBe(true);
    expect(_buildSpoutBiasData(trials, 20, null).every((r) => r.series === 'Bias')).toBe(true);
  });

  it('shows an optional bottom row, with position and bias axes, and hides it again', () => {
    const plot = createProbPlot({ trials, sessionEndS: 20 });
    expect(plot.element.querySelector('.df-spout-bias-row')).toBeNull();
    const toggle = plot.element.querySelector('input');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const row = plot.element.querySelector('.df-spout-bias-row');
    expect(row.textContent).toContain('X − X(0)');
    expect(row.textContent).toContain('Bias');
    expect(row.querySelectorAll('path').length).toBeGreaterThan(0);
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(plot.element.querySelector('.df-spout-bias-row')).toBeNull();
  });

  it('handles sessions without position or bias values', () => {
    const plot = createProbPlot({ trials: [{ goCue_t: 0, pL: 0.5, pR: 0.1 }], sessionEndS: 20 },
      { showSpoutBias: true });
    expect(plot.element.querySelector('.df-spout-bias-row').textContent)
      .toBe('X and bias unavailable.');
  });

  it('reads old shared-y schemas without requiring optional columns', async () => {
    const arrow = (rows) => ({ schema: { fields: Object.keys(rows[0] ?? {}).map((name) => ({ name })) },
      numRows: rows.length, getChild: (name) => ({ get: (i) => rows[i][name] }) });
    const query = vi.fn()
      .mockResolvedValueOnce(arrow([{ column_name: 'lickspout_position_y' }]))
      .mockResolvedValueOnce(arrow([{ trial: 0, goCue_t: 0 }]))
      .mockResolvedValueOnce(arrow([]));
    await loadDfSession({ query }, { subjectId: '869044', sessionDate: '2026-09-18', nwbSuffix: 160535 });
    const sql = query.mock.calls[1][0];
    expect(sql).toContain('lickspout_position_y AS lickspout_position_y1');
    expect(sql).toContain('lickspout_position_y AS lickspout_position_y2');
    expect(sql).toContain('NULL AS side_bias');
  });
});

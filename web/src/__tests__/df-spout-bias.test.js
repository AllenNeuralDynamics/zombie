/** @vitest-environment happy-dom */
import { describe, it, expect, vi } from 'vitest';
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

  it('shows an optional bottom row, with position and bias axes, and hides it again', () => {
    const plot = createProbPlot({ trials, sessionEndS: 20 });
    expect(plot.element.querySelector('.df-spout-bias-row')).toBeNull();
    const toggle = plot.element.querySelector('input');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    const row = plot.element.querySelector('.df-spout-bias-row');
    expect(row.textContent).toContain('Spout position');
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
      .toBe('Spout position and bias unavailable.');
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

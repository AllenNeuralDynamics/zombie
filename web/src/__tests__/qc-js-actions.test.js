// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import {
  describeJsAction,
  parseJsReference,
  referenceActions,
  referenceGroupKey,
  renderJsReference,
  runJsAction,
} from '../qc/js-references.js';
import { buildNeuroglancerState, createNeuroglancerActions } from '../qc/js-renderers/neuroglancer.js';
import { renderMetrics } from '../qc/metrics.js';

const BASE = 'js:neuroglancer?skeleton=s3://b/skel';

describe('js reference actions', () => {
  it('strips action params from render params and group key', () => {
    const ref = `${BASE}&action=segments:1,2&action=goto:1,2,3`;
    const { params, actions } = parseJsReference(ref);
    expect(params.has('action')).toBe(false);
    expect(actions).toEqual([{ name: 'segments', args: '1,2' }, { name: 'goto', args: '1,2,3' }]);
    expect(referenceGroupKey(ref)).toBe(referenceGroupKey(BASE));
    expect(referenceGroupKey('s3://b/x.png')).toBe('s3://b/x.png');
    expect(referenceActions('s3://b/x.png')).toEqual([]);
    expect(describeJsAction(ref, actions[0])).toBe('Show segments 1,2');
  });

  it('dispatches to renderer handlers and ignores unknown actions', () => {
    const el = { qcActions: { go: vi.fn() } };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(runJsAction(el, { name: 'go', args: 'a' })).toBe(true);
    expect(el.qcActions.go).toHaveBeenCalledWith('a');
    expect(runJsAction(el, { name: 'nope', args: '' })).toBe(false);
  });

  it('neuroglancer actions update state and re-show', async () => {
    const params = parseJsReference(BASE).params;
    const state = buildNeuroglancerState(params);
    const show = vi.fn();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const actions = createNeuroglancerActions(state, params, show, { fetchImpl });
    actions.segments('7, 8');
    expect(state.layers[0].segments).toEqual(['7', '8']);
    actions.goto('1,2,3');
    expect(state.position).toEqual([1, 2, 3]);
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('renders the view once per shared reference with an action button per metric', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const metrics = [
      { name: 'a', value: 1, reference: `${BASE}&action=segments:1` },
      { name: 'b', value: 2, reference: `${BASE}&action=segments:2` },
    ];
    const root = renderMetrics(metrics, 'b', 'p', 'asset');
    expect(root.querySelectorAll('details')).toHaveLength(1);
    expect(root.querySelectorAll('iframe')).toHaveLength(1);
    const buttons = [...root.querySelectorAll('.metric-action-btn')];
    expect(buttons.map(b => b.textContent)).toEqual(['Show segments 1', 'Show segments 2']);
    const target = root.querySelector('.qc-media-js-neuroglancer');
    target.qcActions.segments = vi.fn();
    buttons[1].click();
    expect(target.qcActions.segments).toHaveBeenCalledWith('2');
    vi.unstubAllGlobals();
  });

  it('applies a reference action when rendered on its own', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const el = renderJsReference(`${BASE}&action=goto:1,2,3`);
    expect(el.qcActions.goto).toBeTypeOf('function');
    vi.unstubAllGlobals();
  });
});

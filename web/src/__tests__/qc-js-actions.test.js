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
import { addReviewPoint, REVIEW_LAYER, selectReviewPoint } from '../qc/js-renderers/neuroglancer-review.js';
import { renderMetrics, renderMetricsTable } from '../qc/metrics.js';

const BASE = 'js:neuroglancer?skeleton=s3://b/skel';

const reviewLayer = state => state.layers.find(l => l.name === REVIEW_LAYER);

function iframeState(root) {
  const src = root.querySelector('iframe').src;
  return JSON.parse(decodeURIComponent(src.slice(src.indexOf('#!') + 2)));
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('neuroglancer review layer', () => {
  it('adds points with growing metric enum, status codes and dedupe', () => {
    const state = { layers: [] };
    expect(addReviewPoint(state, { xyz: [1, 2, 3], metric: 'a', status: 'Fail' })).toBe(true);
    expect(addReviewPoint(state, { xyz: [1, 2, 3], metric: 'a', status: 'Fail' })).toBe(false);
    expect(addReviewPoint(state, { xyz: [1, 2, 3], metric: 'b', status: 'weird' })).toBe(true);
    const layer = reviewLayer(state);
    expect(layer.type).toBe('annotation');
    expect(layer.source.url).toBe('local://annotations');
    expect(layer.annotationProperties[0]).toMatchObject({ id: 'metric', enum_labels: ['a', 'b'], enum_values: [0, 1] });
    expect(layer.annotations.map(a => [a.description, a.props, a.point])).toEqual([
      ['a · Fail', [0, 1], [1, 2, 3]],
      ['b · Pending', [1, 2], [1, 2, 3]],
    ]);
    expect(new Set(layer.annotations.map(a => a.id)).size).toBe(2);
    addReviewPoint(state, { xyz: [1, 2, 3], metric: 'c', status: 'Fail' });
    expect(selectReviewPoint(state, [1, 2, 3])).toBe(layer.annotations[0].id);
    addReviewPoint(state, { xyz: [7, 7, 7], metric: 'a', status: 'Pass' });
    addReviewPoint(state, { xyz: [7, 7, 7], metric: 'b', status: 'Pending' });
    expect(selectReviewPoint(state, [7, 7, 7])).toBe(layer.annotations[4].id);
    expect(state.selection.visible).toBe(true);
    expect(state.selectedLayer).toEqual({ layer: REVIEW_LAYER, visible: false });
    expect(layer.shader).toContain('if (status == 0u) {\n    setColor(vec3(0.00, 1.00, 0.00));');
    expect(layer.shader).toContain('} else if (status == 1u) {\n    setColor(vec3(1.00, 0.00, 0.00));');
    expect(layer.shader).toContain('} else if (status == 2u) {\n    setColor(vec3(1.00, 1.00, 0.00));');
  });

  it('annotate records goto points without moving the view', () => {
    const params = parseJsReference(BASE).params;
    const state = buildNeuroglancerState(params);
    const show = vi.fn();
    const actions = createNeuroglancerActions(state, params, show);
    expect(actions.annotate('segments', '1', { metric: 'a' })).toBe(false);
    expect(actions.annotate('goto', '4,5,6', { metric: 'a', status: 'Pass' })).toBe(true);
    expect(state.position).toBeUndefined();
    expect(reviewLayer(state).annotations).toHaveLength(1);
    expect(show).toHaveBeenCalledTimes(1);
    actions.goto('4,5,6');
    expect(state.selection.layers[REVIEW_LAYER].annotationId).toBe(reviewLayer(state).annotations[0].id);
    actions.goto('7,8,9');
    expect(state.selection.layers).toBeUndefined();
    expect(state.position).toEqual([7, 8, 9]);
  });

  it('accordion view holds every grouped metric point', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const metrics = [
      { name: 'a', value: 1, reference: `${BASE}&action=goto:1,2,3` },
      { name: 'b', value: 2, reference: `${BASE}&action=goto:4,5,6`, status_history: [{ status: 'Fail' }] },
    ];
    const root = renderMetrics(metrics, 'b', 'p', 'asset');
    await settle();
    const layer = reviewLayer(iframeState(root));
    expect(layer.annotations.map(a => a.description)).toEqual(['a · Pending', 'b · Fail']);
    vi.unstubAllGlobals();
  });

  it('table dialog shows the group points focused on the clicked metric, with no hover', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const metrics = [
      { name: 'a', value: 1, reference: `${BASE}&action=goto:1,2,3` },
      { name: 'b', value: 2, reference: `${BASE}&action=goto:4,5,6` },
    ];
    const table = renderMetricsTable(metrics, 'b', 'p', 'asset');
    document.body.appendChild(table);
    expect(table.querySelector('.qc-reference-preview')).toBeNull();
    table.querySelectorAll('.qc-reference-link')[1].click();
    await settle();
    const dialog = document.querySelector('.qc-reference-dialog');
    expect(dialog.querySelectorAll('iframe')).toHaveLength(1);
    const state = iframeState(dialog);
    expect(reviewLayer(state).annotations.map(a => a.point)).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(state.position).toEqual([4, 5, 6]);
    expect(state.crossSectionScale).toBe(2);
    expect(state.projectionScale).toBe(1000);
    const selected = reviewLayer(state).annotations[1].id;
    expect(state.selection.layers).toEqual({ [REVIEW_LAYER]: { annotationId: selected, annotationSource: 0 } });
    expect(state.selection.visible).toBe(true);
    dialog.remove();
    table.remove();
    vi.unstubAllGlobals();
  });
});

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

  it('pairs goto buttons with a copy-coordinates button', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeText = vi.fn().mockResolvedValue();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const root = renderMetrics([
      { name: 'a', value: 1, reference: `${BASE}&action=goto:1,2,3&action=segments:4` },
    ], 'b', 'p', 'asset');
    const pairs = root.querySelectorAll('.metric-action-pair');
    expect(pairs).toHaveLength(1);
    expect(pairs[0].querySelector('.metric-action-btn').textContent).toBe('Go to 1,2,3');
    pairs[0].querySelector('.metric-action-copy').click();
    expect(writeText).toHaveBeenCalledWith('1,2,3');
    vi.unstubAllGlobals();
  });

  it('applies a reference action when rendered on its own', () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const el = renderJsReference(`${BASE}&action=goto:1,2,3`);
    expect(el.qcActions.goto).toBeTypeOf('function');
    vi.unstubAllGlobals();
  });
});

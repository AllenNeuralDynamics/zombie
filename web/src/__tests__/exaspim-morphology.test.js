import { describe, it, expect } from 'vitest';
import { buildNgState, classifySearchToken, filterNeurons } from '../exaspim/morphology.js';
import { buildMouseLightAnnotationLayer, buildSearchContext, mouseLightColor } from '../exaspim/mouselight.js';

describe('buildNgState extraLayers', () => {
  it('appends extra layers after CCF + neuron layers', () => {
    const extra = { type: 'annotation', name: 'ML-AA0001' };
    const state = buildNgState(['997'], { full: ['1'], axon: [], dendrite: [] }, [extra]);
    // ccf (root only) + neurons + extra
    expect(state.layers).toHaveLength(3);
    expect(state.layers[0].name).toBe('ccf');
    expect(state.layers[1].name).toBe('neurons');
    expect(state.layers[2]).toBe(extra);
  });

  it('defaults to no extra layers', () => {
    const state = buildNgState(['997'], { full: [], axon: [], dendrite: [] });
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0].name).toBe('ccf');
  });
});

describe('buildNgState region opacity split', () => {
  it('keeps a single translucent ccf layer for the root only', () => {
    const state = buildNgState(['997'], { full: [], axon: [], dendrite: [] });
    expect(state.layers).toHaveLength(1);
    expect(state.layers[0].name).toBe('ccf');
    expect(state.layers[0].objectAlpha).toBe(0.18);
    expect(state.layers[0].meshSilhouetteRendering).toBe(3);
  });

  it('splits non-root regions into a more opaque ccf-regions layer', () => {
    const state = buildNgState(['997', '8', '4'], { full: [], axon: [], dendrite: [] });
    const root = state.layers.find((l) => l.name === 'ccf');
    const regions = state.layers.find((l) => l.name === 'ccf-regions');
    expect(root.segments).toEqual(['997']);
    expect(regions.segments).toEqual(['8', '4']);
    expect(regions.objectAlpha).toBeGreaterThan(root.objectAlpha);
    expect(regions.meshSilhouetteRendering).toBeUndefined();
  });

  it('emits only ccf-regions when the root is not selected', () => {
    const state = buildNgState(['8'], { full: [], axon: [], dendrite: [] });
    expect(state.layers.find((l) => l.name === 'ccf').segments).toEqual([]);
    expect(state.layers.find((l) => l.name === 'ccf-regions').segments).toEqual(['8']);
  });
});

describe('buildNgState ccf segmentColors', () => {
  it('omits segmentColors when no colour map is given', () => {
    const state = buildNgState(['997', '8'], { full: [], axon: [], dendrite: [] });
    expect(state.layers[0].segmentColors).toBeUndefined();
  });

  it('maps each selected CCF segment to its atlas colour across both layers', () => {
    const colors = new Map([['997', '#ffffff'], ['8', '#bfdae3'], ['1', '#ff4c3e']]);
    const state = buildNgState(['997', '8'], { full: [], axon: [], dendrite: [] }, [], undefined, colors);
    const root = state.layers.find((l) => l.name === 'ccf');
    const regions = state.layers.find((l) => l.name === 'ccf-regions');
    expect(root.segmentColors).toEqual({ '997': '#ffffff' });
    expect(regions.segmentColors).toEqual({ '8': '#bfdae3' });
  });

  it('skips segments missing from the colour map', () => {
    const colors = new Map([['997', '#ffffff']]);
    const state = buildNgState(['997', '12345'], { full: [], axon: [], dendrite: [] }, [], undefined, colors);
    const root = state.layers.find((l) => l.name === 'ccf');
    const regions = state.layers.find((l) => l.name === 'ccf-regions');
    expect(root.segmentColors).toEqual({ '997': '#ffffff' });
    expect(regions.segmentColors).toBeUndefined();
  });
});

describe('buildNgState neuron segmentColors', () => {
  it('omits segmentColors on neuron layers when no colour map is given', () => {
    const state = buildNgState(['997'], { full: ['10', '11'], axon: [], dendrite: [] });
    const neurons = state.layers.find((l) => l.name === 'neurons');
    expect(neurons.segmentColors).toBeUndefined();
  });

  it('maps each selected neuron to its chosen colour', () => {
    const colors = new Map([['10', '#aa0000'], ['11', '#00bb00']]);
    const state = buildNgState(
      ['997'], { full: ['10'], axon: ['11'], dendrite: [] }, [], undefined, null, colors,
    );
    const full = state.layers.find((l) => l.name === 'neurons');
    const axon = state.layers.find((l) => l.name === 'neurons-axon');
    expect(full.segmentColors).toEqual({ '10': '#aa0000' });
    expect(axon.segmentColors).toEqual({ '11': '#00bb00' });
  });

  it('skips neuron segments missing from the colour map', () => {
    const colors = new Map([['10', '#aa0000']]);
    const state = buildNgState(
      ['997'], { full: ['10', '99'], axon: [], dendrite: [] }, [], undefined, null, colors,
    );
    const full = state.layers.find((l) => l.name === 'neurons');
    expect(full.segmentColors).toEqual({ '10': '#aa0000' });
  });
});

describe('buildSearchContext', () => {
  it('scopes an ANATOMICAL root predicate for the full public neuron list', () => {
    const ctx = buildSearchContext();
    expect(ctx.scope).toBe(6);
    expect(ctx.ccfVersion).toBe('CCFV30');
    expect(ctx.predicates).toHaveLength(1);
    const p = ctx.predicates[0];
    expect(p.predicateType).toBe('ANATOMICAL');
    expect(p.brainAreaIds).toEqual(['464cb1ee-4664-40dc-948f-85dd1feb3e40']);
    expect(p.invert).toBe(false);
  });
});

describe('mouseLightColor', () => {
  it('cycles through the palette', () => {
    expect(mouseLightColor(0)).toBe(mouseLightColor(10));
    expect(mouseLightColor(0)).not.toBe(mouseLightColor(1));
  });
});

describe('buildMouseLightAnnotationLayer', () => {
  const tracings = [
    {
      nodes: [
        { sampleNumber: 1, parentNumber: -1, x: 100, y: 200, z: 300 },
        { sampleNumber: 2, parentNumber: 1, x: 110, y: 210, z: 310 },
        { sampleNumber: 3, parentNumber: 2, x: 120, y: 220, z: 320 },
      ],
    },
  ];

  it('builds one line per parent→child edge (root has no edge)', () => {
    const layer = buildMouseLightAnnotationLayer('AA0001', tracings, '#ff0000');
    expect(layer.type).toBe('annotation');
    expect(layer.name).toBe('ML-AA0001');
    expect(layer.annotationColor).toBe('#ff0000');
    expect(layer.annotations).toHaveLength(2);
  });

  it('scales µm coordinates to 10µm voxels (÷10)', () => {
    const layer = buildMouseLightAnnotationLayer('AA0001', tracings);
    const first = layer.annotations[0];
    expect(first.type).toBe('line');
    // node 2 → parent node 1
    expect(first.pointA).toEqual([11, 21, 31]);
    expect(first.pointB).toEqual([10, 20, 30]);
  });

  it('uses 10µm output dimensions matching the CCF atlas', () => {
    const layer = buildMouseLightAnnotationLayer('AA0001', tracings);
    expect(layer.source.transform.outputDimensions).toEqual({
      x: [1e-5, 'm'], y: [1e-5, 'm'], z: [1e-5, 'm'],
    });
  });

  it('skips edges whose parent node is missing', () => {
    const broken = [{ nodes: [{ sampleNumber: 5, parentNumber: 99, x: 1, y: 1, z: 1 }] }];
    const layer = buildMouseLightAnnotationLayer('X', broken);
    expect(layer.annotations).toHaveLength(0);
  });

  it('handles empty / missing tracings', () => {
    expect(buildMouseLightAnnotationLayer('X', []).annotations).toHaveLength(0);
    expect(buildMouseLightAnnotationLayer('X', undefined).annotations).toHaveLength(0);
  });
});

describe('classifySearchToken', () => {
  const acronymToNode = new Map([
    ['visp', { id: '385', acronym: 'VISp', name: 'Primary visual area' }],
  ]);
  const nameToNode = new Map([
    ['primary visual area', { id: '385', acronym: 'VISp', name: 'Primary visual area' }],
  ]);
  const maps = { acronymToNode, nameToNode };

  it('returns null for blank input', () => {
    expect(classifySearchToken('   ', maps)).toBeNull();
    expect(classifySearchToken('', maps)).toBeNull();
  });

  it('matches an exact CCF acronym case-insensitively', () => {
    const chip = classifySearchToken('visp', maps);
    expect(chip).toEqual({ kind: 'ccf', match: 'acronym', structureId: '385', acronym: 'VISp', name: 'Primary visual area' });
  });

  it('matches an exact full area name', () => {
    const chip = classifySearchToken('Primary Visual Area', maps);
    expect(chip.kind).toBe('ccf');
    expect(chip.match).toBe('name');
    expect(chip.acronym).toBe('VISp');
  });

  it('falls back to a keyword chip for free text', () => {
    expect(classifySearchToken('N004', maps)).toEqual({ kind: 'keyword', text: 'N004' });
  });
});

describe('filterNeurons', () => {
  const neurons = [
    { key: 'aind:1', dataset: 'aind', label: 'N004', region: 'VISp', regionAncestorIds: ['385', '669', '8'], searchText: 'n004 visp primary visual area' },
    { key: 'aind:2', dataset: 'aind', label: 'N010', region: 'MOs', regionAncestorIds: ['993', '500', '8'], searchText: 'n010 mos secondary motor area' },
    { key: 'ml:AA01', dataset: 'ml', label: 'AA0001', region: 'VISp1', regionAncestorIds: ['593', '385', '669', '8'], searchText: 'aa0001 visp1 primary visual area layer 1' },
  ];

  it('returns everything with no filters', () => {
    expect(filterNeurons(neurons, {})).toHaveLength(3);
  });

  it('filters hierarchically by region (parent matches descendants)', () => {
    const out = filterNeurons(neurons, { regionIds: ['385'] });
    expect(out.map((n) => n.key)).toEqual(['aind:1', 'ml:AA01']);
  });

  it('ORs multiple region chips', () => {
    const out = filterNeurons(neurons, { regionIds: ['385', '993'] });
    expect(out).toHaveLength(3);
  });

  it('ANDs keywords as substrings over label/region/name', () => {
    expect(filterNeurons(neurons, { keywords: ['n004'] }).map((n) => n.key)).toEqual(['aind:1']);
    expect(filterNeurons(neurons, { keywords: ['visual'] }).map((n) => n.key)).toEqual(['aind:1', 'ml:AA01']);
    expect(filterNeurons(neurons, { keywords: ['visual', 'aa0001'] }).map((n) => n.key)).toEqual(['ml:AA01']);
  });

  it('combines region and keyword filters', () => {
    const out = filterNeurons(neurons, { regionIds: ['385'], keywords: ['aa'] });
    expect(out.map((n) => n.key)).toEqual(['ml:AA01']);
  });
});

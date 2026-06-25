/**
 * ephys-view.test.js — Unit tests for ephys-related pure helpers in details.js.
 *
 * Tests hasEphysAssemblies and buildEphysProbeCard, which are Node-safe (no DOM/Three.js).
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => ({ default: {} }));
vi.mock('three/addons/loaders/OBJLoader.js', () => ({ OBJLoader: class {} }));

vi.mock('../subject/brain-viz-3d.js', () => ({
  STRUCTURE_COLORS: {},
  TARGET_X: 0, TARGET_Y: -3.668, TARGET_Z: -1.2,
  makeCCFMatrix: () => ({}),
  cssHexToThree: (h) => parseInt(h.replace('#', ''), 16),
  surfaceY: () => null,
  loadBrainMesh: () => {},
  createBrainViz3D: () => document.createElement('div'),
}));

vi.mock('../subject/brain-viz.js', () => ({
  ITEM_COLORS: ['#FF6B6B', '#4ECDC4', '#45B7D1'],
  createBrainVizCanvas: () => ({ canvas: document.createElement('canvas') }),
}));

vi.mock('../assets/links.js', () => ({
  buildQcLink: () => null,
  buildMetadataLink: () => null,
  buildCoLink: () => null,
  buildS3ConsoleUrl: () => null,
}));

import {
  hasEphysAssemblies,
  buildEphysProbeCard,
  buildCraniotomySubProcHtml,
  buildHeadframeSubProcHtml,
} from '../subject/details.js';

const EPHYS_CONFIG = {
  object_type: 'Ephys assembly config',
  device_name: 'Ephys Assembly 46121',
  modules: [
    { object_type: 'MIS module config', arc_angle: -10, module_angle: -15, angle_unit: 'degrees' },
  ],
  probes: [
    {
      device_name: '46121',
      dye: 'DiD',
      notes: 'Some notes here.',
      primary_targeted_structure: { acronym: 'PAL', id: '803', name: 'Pallidum' },
      other_targeted_structure: null,
      coordinate_system: {
        name: 'PROBE_RUFD',
        origin: 'Tip',
        axis_unit: 'micrometer',
        axes: [
          { direction: 'Left_to_right', name: 'X' },
          { direction: 'Down_to_up', name: 'Y' },
          { direction: 'Back_to_front', name: 'Z' },
          { direction: 'Up_to_down', name: 'Depth' },
        ],
      },
      transform: [
        { object_type: 'Rotation', angles: [90, 0, -90], angles_unit: 'degrees' },
        { object_type: 'Translation', translation: [3.96, -12.10, -4.04, 3.611] },
      ],
    },
  ],
};

const ACQUISITION_WITH_EPHYS = {
  data_streams: [
    {
      object_type: 'Data stream',
      configurations: [EPHYS_CONFIG],
    },
  ],
};

const ACQUISITION_WITHOUT_EPHYS = {
  data_streams: [
    {
      object_type: 'Data stream',
      configurations: [
        { object_type: 'Camera config', device_name: 'Camera 1' },
      ],
    },
  ],
};

describe('hasEphysAssemblies', () => {
  it('returns true when acquisition has at least one Ephys assembly config', () => {
    expect(hasEphysAssemblies(ACQUISITION_WITH_EPHYS)).toBe(true);
  });

  it('returns false when no Ephys assembly config exists', () => {
    expect(hasEphysAssemblies(ACQUISITION_WITHOUT_EPHYS)).toBe(false);
  });

  it('returns false for empty data_streams', () => {
    expect(hasEphysAssemblies({ data_streams: [] })).toBe(false);
  });

  it('returns false for null input', () => {
    expect(hasEphysAssemblies(null)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(hasEphysAssemblies(undefined)).toBe(false);
  });

  it('finds ephys config nested inside a stream with mixed configs', () => {
    const mixed = {
      data_streams: [
        {
          configurations: [
            { object_type: 'Camera config' },
            { object_type: 'Ephys assembly config', probes: [] },
          ],
        },
      ],
    };
    expect(hasEphysAssemblies(mixed)).toBe(true);
  });
});

describe('buildEphysProbeCard', () => {
  const probe = {
    name: '46121',
    dye: 'DiD',
    notes: 'Probe notes.',
    ap: -4.04,
    ml: 3.96,
    depth: 3.611,
    probeDir: [-0.258, 0.070, 0.964],
    modules: [{ arc_angle: -10, module_angle: -15 }],
    primaryStructure: { acronym: 'PAL', id: '803', name: 'Pallidum' },
    otherStructures: [],
    structureIds: ['803'],
  };

  it('renders the probe name in a heading', () => {
    const html = buildEphysProbeCard(probe, 0);
    expect(html).toContain('46121');
  });

  it('renders the primary targeted structure', () => {
    const html = buildEphysProbeCard(probe, 0);
    expect(html).toContain('Pallidum');
    expect(html).toContain('PAL');
  });

  it('renders the dye', () => {
    const html = buildEphysProbeCard(probe, 0);
    expect(html).toContain('DiD');
  });

  it('renders module angles', () => {
    const html = buildEphysProbeCard(probe, 0);
    expect(html).toContain('arc -10');
    expect(html).toContain('module -15');
  });

  it('renders notes', () => {
    const html = buildEphysProbeCard(probe, 0);
    expect(html).toContain('Probe notes.');
  });

  it('does not render other targets section when otherStructures is empty', () => {
    const html = buildEphysProbeCard(probe, 0);
    expect(html).not.toContain('Other targets');
  });

  it('renders other targeted structures when present', () => {
    const p2 = {
      ...probe,
      otherStructures: [{ acronym: 'MD', id: '362', name: 'Mediodorsal nucleus of thalamus' }],
    };
    const html = buildEphysProbeCard(p2, 0);
    expect(html).toContain('Mediodorsal nucleus of thalamus');
    expect(html).toContain('Other targets');
  });

  it('omits dye row when dye is null', () => {
    const p2 = { ...probe, dye: null };
    const html = buildEphysProbeCard(p2, 0);
    expect(html).not.toContain('DiD');
  });

  it('omits notes row when notes is null', () => {
    const p2 = { ...probe, notes: null };
    const html = buildEphysProbeCard(p2, 1);
    expect(html).not.toContain('Probe notes.');
  });

  it('handles probe with no modules gracefully', () => {
    const p2 = { ...probe, modules: [] };
    const html = buildEphysProbeCard(p2, 0);
    expect(html).not.toContain('Module angles');
  });

  it('shows "Probe N:" prefix using 1-based index', () => {
    const html = buildEphysProbeCard(probe, 0);
    expect(html).toContain('Probe 1:');
  });

  it('index 2 shows "Probe 3:"', () => {
    const html = buildEphysProbeCard(probe, 2);
    expect(html).toContain('Probe 3:');
  });
});

describe('buildCraniotomySubProcHtml', () => {
  it('renders craniotomy-specific fields', () => {
    const html = buildCraniotomySubProcHtml({
      object_type: 'Craniotomy',
      protocol_id: null,
      craniotomy_type: 'Circle',
      coordinate_system_name: 'BREGMA_ARID',
      position: ['Origin'],
      size: 5,
      size_unit: 'millimeter',
      protective_material: null,
      implant_part_number: '5mm stacked coverslip',
      dura_removed: null,
    });

    expect(html).toContain('Craniotomy');
    expect(html).toContain('Circle');
    expect(html).toContain('BREGMA_ARID');
    expect(html).toContain('Origin');
    expect(html).toContain('5 millimeter');
    expect(html).toContain('5mm stacked coverslip');
    expect(html).toContain('Unknown');
  });
});

describe('buildHeadframeSubProcHtml', () => {
  it('renders headframe-specific fields', () => {
    const html = buildHeadframeSubProcHtml({
      object_type: 'Headframe',
      protocol_id: null,
      headframe_type: 'Visual Ctx',
      headframe_part_number: '0160-100-10',
      headframe_material: null,
      well_part_number: '0160-200-20',
      well_type: 'Mesoscope',
    });

    expect(html).toContain('Headframe');
    expect(html).toContain('Visual Ctx');
    expect(html).toContain('0160-100-10');
    expect(html).toContain('0160-200-20');
    expect(html).toContain('Mesoscope');
    expect(html).toContain('Unknown');
  });
});

import { describe, it, expect } from 'vitest';
import { computeProbeDirection, computeProbeDirectionSteps } from '../lib/coord-systems.js';
import { extractEphysProbes } from '../subject/ephys-data.js';

const XYZ = {
  axes: [
    { direction: 'Right_to_left' },
    { direction: 'Inferior_to_superior' },
    { direction: 'Posterior_to_anterior' },
  ],
};

const PERMUTE_FRAME = {
  object_type: 'Rotation',
  angles: [90, 0, 90],
  reference_coordinate_system: 'global',
};

function expectVector(actual, expected) {
  expect(actual).toHaveLength(3);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 10));
}

function finalState(transforms, coordinateSystem = XYZ) {
  return computeProbeDirectionSteps(transforms, coordinateSystem).at(-1);
}

describe('probe transform reference frames', () => {
  it('rotates about the current local X, not the original global X', () => {
    const transforms = [
      { object_type: 'Rotation', angles: [0, 0, 90], reference_coordinate_system: 'global' },
      { object_type: 'Rotation', angles: [90, 0, 0], reference_coordinate_system: 'local' },
    ];
    const steps = computeProbeDirectionSteps(transforms, XYZ);
    expectVector(steps[1].wid, [0, 1, 0]);
    expectVector(steps[1].dir, [-1, 0, 0]);
    expectVector(steps[2].wid, [0, 1, 0]);
    expectVector(steps[2].dir, [0, 0, 1]);
    expectVector(computeProbeDirection(transforms, XYZ), [0, 0, 1]);
  });

  it('permutes the local frame to X=global Y, Y=global Z, Z=global X', () => {
    const state = finalState([PERMUTE_FRAME]);
    expectVector(state.wid, [0, 1, 0]);
    expectVector(state.dir, [0, 0, 1]);
  });

  it.each([
    { reference: 'local', axis: 'X', angles: [90, 0, 0], wid: [0, 1, 0], dir: [1, 0, 0] },
    { reference: 'local', axis: 'Y', angles: [0, 90, 0], wid: [-1, 0, 0], dir: [0, 0, 1] },
    { reference: 'local', axis: 'Z', angles: [0, 0, 90], wid: [0, 0, 1], dir: [0, -1, 0] },
    { reference: 'global', axis: 'X', angles: [90, 0, 0], wid: [0, 0, 1], dir: [0, -1, 0] },
    { reference: 'global', axis: 'Y', angles: [0, 90, 0], wid: [0, 1, 0], dir: [1, 0, 0] },
    { reference: 'global', axis: 'Z', angles: [0, 0, 90], wid: [-1, 0, 0], dir: [0, 0, 1] },
  ])('applies a positive quarter-turn about $reference $axis', ({ reference, angles, wid, dir }) => {
    const transforms = [PERMUTE_FRAME, { object_type: 'Rotation', angles, reference_coordinate_system: reference }];
    const state = finalState(transforms);
    expectVector(state.wid, wid);
    expectVector(state.dir, dir);
    expectVector(computeProbeDirection(transforms, XYZ), dir);
  });

  it('applies a negative local quarter-turn with the opposite sign', () => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Rotation', angles: [-90, 0, 0], reference_coordinate_system: 'local' },
    ]);
    expectVector(state.wid, [0, 1, 0]);
    expectVector(state.dir, [-1, 0, 0]);
  });

  it('uses the newly rotated local frame for the next rotation object', () => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Rotation', angles: [90, 0, 0], reference_coordinate_system: 'local' },
      { object_type: 'Rotation', angles: [0, 90, 0], reference_coordinate_system: 'local' },
    ]);
    expectVector(state.wid, [0, 0, 1]);
    expectVector(state.dir, [1, 0, 0]);
  });

  it('applies compound XYZ angles in the frame at the start of the transform', () => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [2, 3, 5], reference_coordinate_system: 'global' },
      { object_type: 'Rotation', angles: [90, 90, 0], reference_coordinate_system: 'local', pivot: 'global' },
    ]);
    expectVector(state.wid, [-1, 0, 0]);
    expectVector(state.dir, [0, 1, 0]);
    expectVector(state.pos, [-3, 5, -2]);
  });

  it.each([
    { reference: 'global', pivot: 'global', position: [2, -5, 3], dir: [0, -1, 0] },
    { reference: 'global', pivot: 'local', position: [2, 3, 5], dir: [0, -1, 0] },
    { reference: 'local', pivot: 'global', position: [5, 3, -2], dir: [1, 0, 0] },
    { reference: 'local', pivot: 'local', position: [2, 3, 5], dir: [1, 0, 0] },
  ])('handles $reference axes independently of the $pivot pivot', ({ reference, pivot, position, dir }) => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [2, 3, 5], reference_coordinate_system: 'global' },
      { object_type: 'Rotation', angles: [90, 0, 0], reference_coordinate_system: reference, pivot },
    ]);
    expectVector(state.pos, position);
    expectVector(state.dir, dir);
  });

  it.each([
    {},
    { reference_coordinate_system: null, pivot: null },
    { reference_coordinate_system: 'global', pivot: 'global' },
  ])('defaults missing rotation references and pivots to global: %j', fields => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [2, 3, 5] },
      { object_type: 'Rotation', angles: [90, 0, 0], ...fields },
    ]);
    expectVector(state.pos, [2, -5, 3]);
    expectVector(state.dir, [0, -1, 0]);
  });

  it.each([
    { fields: { reference_coordinate_system: 'local' }, position: [5, 3, -2], dir: [1, 0, 0] },
    { fields: { pivot: 'local' }, position: [2, 3, 5], dir: [0, -1, 0] },
  ])('defaults only the missing rotation field to global: $fields', ({ fields, position, dir }) => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [2, 3, 5] },
      { object_type: 'Rotation', angles: [90, 0, 0], ...fields },
    ]);
    expectVector(state.pos, position);
    expectVector(state.dir, dir);
  });

  it.each([
    { axis: 'X', translation: [1, 0, 0], position: [0, 1, 0] },
    { axis: 'Y', translation: [0, 1, 0], position: [0, 0, 1] },
    { axis: 'Z', translation: [0, 0, 1], position: [1, 0, 0] },
  ])('translates one unit along current local $axis', ({ translation, position }) => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation, reference_coordinate_system: 'local' },
    ]);
    expectVector(state.pos, position);
    expectVector(state.wid, [0, 1, 0]);
    expectVector(state.dir, [0, 0, 1]);
  });

  it.each([
    { fields: { reference_coordinate_system: 'local' }, delta: [2, 3, 5], position: [12, 13, 16] },
    { fields: { reference_coordinate_system: 'local' }, delta: [-2, -3, -5], position: [2, 9, 10] },
    { fields: { reference_coordinate_system: 'global' }, delta: [2, 3, 5], position: [9, 14, 18] },
    { fields: {}, delta: [2, 3, 5], position: [9, 14, 18] },
    { fields: { reference_coordinate_system: null }, delta: [2, 3, 5], position: [9, 14, 18] },
    { fields: { intrinsic: true }, delta: [2, 3, 5], position: [9, 14, 18] },
    { fields: { reference_coordinate_system: 'global', intrinsic: true }, delta: [2, 3, 5], position: [9, 14, 18] },
  ])('adds a translation to an existing tip without rotating it: $fields, $delta', ({ fields, delta, position }) => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [7, 11, 13] },
      { object_type: 'Translation', translation: delta, ...fields },
    ]);
    expectVector(state.pos, position);
    expectVector(state.wid, [0, 1, 0]);
    expectVector(state.dir, [0, 0, 1]);
  });

  it('honors local references on every translation, not just the first', () => {
    const steps = computeProbeDirectionSteps([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [2, 3, 5], reference_coordinate_system: 'local' },
      { object_type: 'Translation', translation: [7, 11, 13], reference_coordinate_system: 'local' },
    ], XYZ);
    expectVector(steps[2].pos, [5, 2, 3]);
    expectVector(steps[3].pos, [18, 9, 14]);
  });

  it('uses the updated local frame after a rotation between translations', () => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [2, 0, 0], reference_coordinate_system: 'local' },
      { object_type: 'Rotation', angles: [0, 0, 90], reference_coordinate_system: 'local', pivot: 'local' },
      { object_type: 'Translation', translation: [0, 3, 0], reference_coordinate_system: 'local' },
    ]);
    expectVector(state.pos, [0, -1, 0]);
    expectVector(state.dir, [0, -1, 0]);
  });

  it.each([
    { reference: 'local', translation: [0, 0, 4, 2], position: [4, 0, -2] },
    { reference: 'global', translation: [0, 0, 4, 2], position: [0, 0, 2] },
    { reference: undefined, translation: [0, 0, 4, 2], position: [0, 0, 2] },
    { reference: 'local', translation: [0, 0, 0, -2], position: [0, 0, 2] },
  ])('preserves signed fourth-component depth along the probe: $reference, $translation', ({ reference, translation, position }) => {
    const state = finalState([
      PERMUTE_FRAME,
      { object_type: 'Translation', translation, reference_coordinate_system: reference },
    ]);
    expectVector(state.pos, position);
  });

  it('uses the anatomical default basis for both global and local transforms', () => {
    const transforms = [
      { object_type: 'Rotation', angles: [0, 0, 90], reference_coordinate_system: 'global' },
      { object_type: 'Rotation', angles: [90, 0, 0], reference_coordinate_system: 'local' },
      { object_type: 'Translation', translation: [2, 3, 5], reference_coordinate_system: 'local' },
    ];
    const state = finalState(transforms, null);
    expectVector(state.wid, [0, 0, 1]);
    expectVector(state.dir, [0, 1, 0]);
    expectVector(state.pos, [-5, 3, 2]);
    expectVector(computeProbeDirection(transforms), [0, 1, 0]);
  });

  it('retains the supplied third axis even for a left-handed basis', () => {
    const coordinateSystem = {
      axes: [
        { direction: 'Right_to_left' },
        { direction: 'Inferior_to_superior' },
        { direction: 'Anterior_to_posterior' },
      ],
    };
    const state = finalState([
      { object_type: 'Translation', translation: [2, 3, 5], reference_coordinate_system: 'local' },
    ], coordinateSystem);
    expectVector(state.pos, [2, 3, -5]);
  });

  it('keeps every frame orthonormal and preserves earlier snapshots and input', () => {
    const transforms = [
      PERMUTE_FRAME,
      { object_type: 'Translation', translation: [2, 3, 5], reference_coordinate_system: 'local' },
      { object_type: 'Rotation', angles: [30, -45, 60], reference_coordinate_system: 'local', pivot: 'local' },
      { object_type: 'Rotation', angles: [-60, 15, 80], reference_coordinate_system: 'global' },
    ];
    const original = structuredClone(transforms);
    const steps = computeProbeDirectionSteps(transforms, XYZ);
    expect(transforms).toEqual(original);
    expectVector(steps[0].wid, [1, 0, 0]);
    expectVector(steps[0].dir, [0, 1, 0]);
    expectVector(steps[0].pos, [0, 0, 0]);
    expectVector(steps[2].pos, [5, 2, 3]);
    expectVector(steps[3].pos, [5, 2, 3]);
    for (const state of steps) {
      expect(Math.hypot(...state.wid)).toBeCloseTo(1, 10);
      expect(Math.hypot(...state.dir)).toBeCloseTo(1, 10);
      expect(state.wid.reduce((sum, value, index) => sum + value * state.dir[index], 0)).toBeCloseTo(0, 10);
    }
    expectVector(computeProbeDirection(transforms, XYZ), steps.at(-1).dir);
  });

  it('keeps zero, missing, and unknown transforms harmless', () => {
    const state = finalState([
      { object_type: 'Rotation', angles: [0, 0, 0], reference_coordinate_system: 'local', pivot: 'local' },
      { object_type: 'Rotation', reference_coordinate_system: 'local' },
      { object_type: 'Translation', reference_coordinate_system: 'local' },
      null,
      { object_type: 'Unknown' },
    ]);
    expectVector(state.wid, [1, 0, 0]);
    expectVector(state.dir, [0, 1, 0]);
    expectVector(state.pos, [0, 0, 0]);
    expectVector(computeProbeDirection(null, XYZ), [0, 1, 0]);
  });
});

describe('ephys extraction reference frames', () => {
  function acquisition(transforms) {
    return { data_streams: [{ configurations: [{
      object_type: 'Ephys assembly config',
      probes: [{ device_name: 'test-probe', transform: transforms }],
    }] }] };
  }

  it.each([
    { fields: {}, position: [-1, 3, 2] },
    { fields: { reference_coordinate_system: 'global' }, position: [-1, 3, 2] },
    { fields: { reference_coordinate_system: 'local' }, position: [2, 3, 1] },
  ])('does not force the first translation into a local frame: $fields', ({ fields, position }) => {
    const transforms = [
      { object_type: 'Rotation', angles: [0, 0, 90], reference_coordinate_system: 'global' },
      { object_type: 'Translation', translation: [1, 2, 3], ...fields },
    ];
    const original = structuredClone(transforms);
    const [probe] = extractEphysProbes(acquisition(transforms));
    expectVector(probe.tipPos, position);
    expectVector(probe.probeDir, [1, 0, 0]);
    expect(probe.transforms).toEqual(original);
    expect(transforms).toEqual(original);
  });

  it('retains local behavior on the second translation in the acquisition', () => {
    const transforms = [
      { object_type: 'Rotation', angles: [0, 0, 90], reference_coordinate_system: 'global' },
      { object_type: 'Translation', translation: [1, 2, 3], reference_coordinate_system: 'local' },
      { object_type: 'Translation', translation: [4, 5, 6], reference_coordinate_system: 'local' },
    ];
    const [probe] = extractEphysProbes(acquisition(transforms));
    expectVector(probe.tipPos, [7, 9, 5]);
  });

  it('honors local rotations and local pivots through the extraction path', () => {
    const [probe] = extractEphysProbes(acquisition([
      { object_type: 'Rotation', angles: [0, 0, 90], reference_coordinate_system: 'global' },
      { object_type: 'Translation', translation: [1, 2, 3], reference_coordinate_system: 'global' },
      { object_type: 'Rotation', angles: [90, 0, 0], reference_coordinate_system: 'local', pivot: 'local' },
    ]));
    expectVector(probe.tipPos, [-1, 3, 2]);
    expectVector(probe.probeDir, [0, 1, 0]);
  });
});
/**
 * coord-systems.test.js — Unit tests for parseTranslation and parseDeviceConfigCoords.
 *
 * Canonical output conventions:
 *   ap:    positive = anterior
 *   ml:    positive = right
 *   dv:    positive = dorsal (superior)
 *   depth: positive = deeper from brain surface (always abs)
 */

import { describe, it, expect } from 'vitest';
import {
  parseTranslation,
  parseDeviceConfigCoords,
  directionToThreeJS,
  buildCoordBasis,
  applyExtrinsicRotation,
  applyTranslation,
  computeProbeDirection,
  computeProbeDirectionSteps,
} from '../lib/coord-systems.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * The BREGMA_ARID coordinate system as it appears in procedures.coordinate_system:
 *   AP axis  → Posterior_to_anterior  (positive = anterior)
 *   ML axis  → Left_to_right          (positive = right)
 *   SI axis  → Superior_to_inferior   (positive = ventral, i.e. canonical DV flipped)
 *   Depth    → depth-from-surface     (index 3, always abs)
 */
const BREGMA_ARID_COORD_SYS = {
  object_type: 'Coordinate system',
  name: 'BREGMA_ARID',
  origin: 'Bregma',
  axes: [
    { object_type: 'Axis', name: 'AP', direction: 'Posterior_to_anterior' },
    { object_type: 'Axis', name: 'ML', direction: 'Left_to_right' },
    { object_type: 'Axis', name: 'SI', direction: 'Superior_to_inferior' },
    { object_type: 'Axis', name: 'Depth', direction: 'Superior_to_inferior' }, // index 3 — ignored (depth always uses abs v[3])
  ],
  axis_unit: 'millimeter',
};

// ── parseTranslation ────────────────────────────────────────────────────────

describe('parseTranslation', () => {
  describe('BREGMA_ARID coordinate system', () => {
    it('maps PA axis correctly: positive value → positive AP (anterior)', () => {
      // v[0]=1.3 along Posterior_to_anterior → ap = +1.3
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [1.3, 0, 0, 0]);
      expect(result.ap).toBeCloseTo(1.3);
    });

    it('maps PA axis correctly: negative value → negative AP (posterior)', () => {
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [-1.5, 0, 0, 0]);
      expect(result.ap).toBeCloseTo(-1.5);
    });

    it('maps LR axis correctly: positive value → positive ML (right)', () => {
      // v[1]=1.8 along Left_to_right → ml = +1.8
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [0, 1.8, 0, 0]);
      expect(result.ml).toBeCloseTo(1.8);
    });

    it('maps LR axis correctly: negative value → negative ML (left)', () => {
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [0, -1.8, 0, 0]);
      expect(result.ml).toBeCloseTo(-1.8);
    });

    it('maps SI axis correctly: positive value → negative DV (ventral)', () => {
      // v[2]=1 along Superior_to_inferior → dv = -1 (ventral in canonical)
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [0, 0, 1, 0]);
      expect(result.dv).toBeCloseTo(-1);
    });

    it('maps SI axis correctly: negative value → positive DV (dorsal)', () => {
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [0, 0, -1, 0]);
      expect(result.dv).toBeCloseTo(1);
    });

    it('depth is always abs of v[3] regardless of sign', () => {
      expect(parseTranslation(BREGMA_ARID_COORD_SYS, [0, 0, 0, 4.4]).depth).toBeCloseTo(4.4);
      expect(parseTranslation(BREGMA_ARID_COORD_SYS, [0, 0, 0, -4.4]).depth).toBeCloseTo(4.4);
    });

    it('parses a complete realistic probe translation correctly', () => {
      // [AP=1.3, ML=-1.8, SI=0, depth=4.4]
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [1.3, -1.8, 0, 4.4]);
      expect(result.ap).toBeCloseTo(1.3);
      expect(result.ml).toBeCloseTo(-1.8);
      expect(result.dv).toBeCloseTo(0);
      expect(result.depth).toBeCloseTo(4.4);
    });

    it('parses a right-hemisphere probe correctly', () => {
      // [AP=1.1, ML=1.8, SI=0, depth=4.4]
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [1.1, 1.8, 0, 4.4]);
      expect(result.ap).toBeCloseTo(1.1);
      expect(result.ml).toBeCloseTo(1.8);
      expect(result.depth).toBeCloseTo(4.4);
    });

    it('parses a posterior probe correctly', () => {
      // [AP=-1.5, ML=3.0, SI=0, depth=3.9]
      const result = parseTranslation(BREGMA_ARID_COORD_SYS, [-1.5, 3.0, 0, 3.9]);
      expect(result.ap).toBeCloseTo(-1.5);
      expect(result.ml).toBeCloseTo(3.0);
      expect(result.depth).toBeCloseTo(3.9);
    });
  });

  describe('axis direction sign conventions', () => {
    it('Anterior_to_posterior: positive value → negative AP (posterior)', () => {
      const cs = { axes: [{ direction: 'Anterior_to_posterior' }] };
      expect(parseTranslation(cs, [2, 0, 0, 0]).ap).toBeCloseTo(-2);
    });

    it('Posterior_to_anterior: positive value → positive AP (anterior)', () => {
      const cs = { axes: [{ direction: 'Posterior_to_anterior' }] };
      expect(parseTranslation(cs, [2, 0, 0, 0]).ap).toBeCloseTo(2);
    });

    it('Left_to_right: positive value → positive ML (right)', () => {
      const cs = { axes: [{ direction: 'Left_to_right' }] };
      expect(parseTranslation(cs, [3, 0, 0, 0]).ml).toBeCloseTo(3);
    });

    it('Right_to_left: positive value → negative ML (left)', () => {
      const cs = { axes: [{ direction: 'Right_to_left' }] };
      expect(parseTranslation(cs, [3, 0, 0, 0]).ml).toBeCloseTo(-3);
    });

    it('Superior_to_inferior: positive value → negative DV (ventral)', () => {
      const cs = { axes: [{ direction: 'Superior_to_inferior' }] };
      expect(parseTranslation(cs, [1, 0, 0, 0]).dv).toBeCloseTo(-1);
    });

    it('Inferior_to_superior: positive value → positive DV (dorsal)', () => {
      const cs = { axes: [{ direction: 'Inferior_to_superior' }] };
      expect(parseTranslation(cs, [1, 0, 0, 0]).dv).toBeCloseTo(1);
    });
  });

  describe('null/missing coordinate system fallback', () => {
    it('null coordinate system uses BREGMA_ARID index order: v0=AP+, v1=ML+, v2=DV+', () => {
      const result = parseTranslation(null, [1.3, -1.8, 0, 4.4]);
      expect(result.ap).toBeCloseTo(1.3);
      expect(result.ml).toBeCloseTo(-1.8);
      expect(result.dv).toBeCloseTo(0);
      expect(result.depth).toBeCloseTo(4.4);
    });

    it('missing axes array falls back to index order', () => {
      const result = parseTranslation({ name: 'CUSTOM' }, [2.0, -1.0, 0, 3.0]);
      expect(result.ap).toBeCloseTo(2.0);
      expect(result.ml).toBeCloseTo(-1.0);
      expect(result.depth).toBeCloseTo(3.0);
    });

    it('empty translation returns zeros with null depth', () => {
      const result = parseTranslation(null, []);
      expect(result.ap).toBe(0);
      expect(result.ml).toBe(0);
      expect(result.dv).toBeNull();
      expect(result.depth).toBeNull();
    });
  });
});

// ── parseDeviceConfigCoords ──────────────────────────────────────────────────

describe('parseDeviceConfigCoords', () => {
  it('reads coordinate_system and first Translation from transform', () => {
    const deviceConfig = {
      coordinate_system: BREGMA_ARID_COORD_SYS,
      transform: [
        { object_type: 'Translation', translation: [1.3, -1.8, 0, 4.4] },
      ],
    };
    const result = parseDeviceConfigCoords(deviceConfig);
    expect(result.ap).toBeCloseTo(1.3);
    expect(result.ml).toBeCloseTo(-1.8);
    expect(result.depth).toBeCloseTo(4.4);
  });

  it('skips non-Translation transform entries to find Translation', () => {
    const deviceConfig = {
      coordinate_system: BREGMA_ARID_COORD_SYS,
      transform: [
        { object_type: 'Rotation', angles: [0, 0, 0] },
        { object_type: 'Translation', translation: [1.1, 1.8, 0, -4.4] },
      ],
    };
    const result = parseDeviceConfigCoords(deviceConfig);
    expect(result.ap).toBeCloseTo(1.1);
    expect(result.ml).toBeCloseTo(1.8);
    expect(result.depth).toBeCloseTo(4.4);
  });

  it('falls back gracefully when no coordinate_system present', () => {
    const deviceConfig = {
      coordinate_system: null,
      transform: [
        { object_type: 'Translation', translation: [2.0, 1.0, 0, 3.5] },
      ],
    };
    const result = parseDeviceConfigCoords(deviceConfig);
    expect(result.ap).toBeCloseTo(2.0);
    expect(result.ml).toBeCloseTo(1.0);
    expect(result.depth).toBeCloseTo(3.5);
  });

  it('returns zeros when no transform present', () => {
    const deviceConfig = {
      coordinate_system: BREGMA_ARID_COORD_SYS,
      transform: [],
    };
    const result = parseDeviceConfigCoords(deviceConfig);
    expect(result.ap).toBe(0);
    expect(result.ml).toBe(0);
    expect(result.depth).toBeNull();
  });

  it('handles null deviceConfig gracefully', () => {
    const result = parseDeviceConfigCoords(null);
    expect(result.ap).toBe(0);
    expect(result.ml).toBe(0);
    expect(result.depth).toBeNull();
  });
});

// ── directionToThreeJS ──────────────────────────────────────────────────────

describe('directionToThreeJS', () => {
  it('Left_to_right → +R → three.js (−1, 0, 0)', () => {
    expect(directionToThreeJS('Left_to_right')).toEqual([-1, 0, 0]);
  });

  it('Right_to_left → −R → three.js (+1, 0, 0)', () => {
    expect(directionToThreeJS('Right_to_left')).toEqual([1, 0, 0]);
  });

  it('Posterior_to_anterior → +A → three.js (0, 0, +1)', () => {
    expect(directionToThreeJS('Posterior_to_anterior')).toEqual([0, 0, 1]);
  });

  it('Anterior_to_posterior → −A → three.js (0, 0, −1)', () => {
    expect(directionToThreeJS('Anterior_to_posterior')).toEqual([0, 0, -1]);
  });

  it('Inferior_to_superior → +S → three.js (0, +1, 0)', () => {
    expect(directionToThreeJS('Inferior_to_superior')).toEqual([0, 1, 0]);
  });

  it('Superior_to_inferior → −S → three.js (0, −1, 0)', () => {
    expect(directionToThreeJS('Superior_to_inferior')).toEqual([0, -1, 0]);
  });

  it('is case-insensitive', () => {
    expect(directionToThreeJS('left_to_right')).toEqual([-1, 0, 0]);
    expect(directionToThreeJS('LEFT_TO_RIGHT')).toEqual([-1, 0, 0]);
  });

  it('returns null for unrecognised direction', () => {
    expect(directionToThreeJS('bogus')).toBeNull();
    expect(directionToThreeJS(null)).toBeNull();
  });
});

// ── buildCoordBasis ─────────────────────────────────────────────────────────

describe('buildCoordBasis', () => {
  it('returns default BREGMA_RAS basis when no coordinate system provided', () => {
    const { columns } = buildCoordBasis(null);
    expect(columns[0]).toEqual([-1, 0, 0]); // R
    expect(columns[1]).toEqual([0, 0, 1]);  // A
    expect(columns[2]).toEqual([0, 1, 0]);  // S
  });

  it('builds correct basis from BREGMA_ARID axes', () => {
    const cs = {
      axes: [
        { direction: 'Posterior_to_anterior' }, // AP → +A
        { direction: 'Left_to_right' },         // ML → +R
        { direction: 'Superior_to_inferior' },  // SI → −S
      ],
    };
    const { columns } = buildCoordBasis(cs);
    expect(columns[0]).toEqual([0, 0, 1]);  // AP axis → three.js +Z
    expect(columns[1]).toEqual([-1, 0, 0]); // ML axis → three.js −X
    expect(columns[2]).toEqual([0, -1, 0]); // SI axis → three.js −Y
  });

  it('falls back to default on unrecognised direction', () => {
    const cs = { axes: [{ direction: 'Posterior_to_anterior' }, { direction: 'bogus' }] };
    const { columns } = buildCoordBasis(cs);
    expect(columns[0]).toEqual([-1, 0, 0]); // default R
  });
});

// ── applyExtrinsicRotation ──────────────────────────────────────────────────

describe('applyExtrinsicRotation', () => {
  const RAS = buildCoordBasis(null).columns;

  it('zero angles leave vector unchanged', () => {
    const v = applyExtrinsicRotation([0, 0, 1], [0, 0, 0], RAS);
    expect(v[0]).toBeCloseTo(0);
    expect(v[1]).toBeCloseTo(0);
    expect(v[2]).toBeCloseTo(1);
  });

  it('90° around R axis (axis 0) rotates A toward S', () => {
    // +A = (0,0,1) → +S = (0,1,0)
    const v = applyExtrinsicRotation([0, 0, 1], [90, 0, 0], RAS);
    expect(v[0]).toBeCloseTo(0);
    expect(v[1]).toBeCloseTo(1);
    expect(v[2]).toBeCloseTo(0);
  });

  it('90° around A axis (axis 1) rotates R toward −S', () => {
    // +R in three.js = (-1,0,0). After 90° around A: should become −S = (0,−1,0).
    // RAS: Ry(90°) takes R(1,0,0) → −S(0,0,−1). In three.js: R(-1,0,0) → −S(0,−1,0).
    const v = applyExtrinsicRotation([-1, 0, 0], [0, 90, 0], RAS);
    expect(v[0]).toBeCloseTo(0);
    expect(v[1]).toBeCloseTo(-1);
    expect(v[2]).toBeCloseTo(0);
  });

  it('90° around S axis (axis 2) rotates R toward A', () => {
    // +R = (-1,0,0) → +A = (0,0,1)
    const v = applyExtrinsicRotation([-1, 0, 0], [0, 0, 90], RAS);
    expect(v[0]).toBeCloseTo(0);
    expect(v[1]).toBeCloseTo(0);
    expect(v[2]).toBeCloseTo(1);
  });
});

// ── applyTranslation ────────────────────────────────────────────────────────

describe('applyTranslation', () => {
  const RAS = buildCoordBasis(null).columns;

  it('+R translation moves to three.js −X', () => {
    const pos = applyTranslation([0, 0, 0], [5, 0, 0], RAS);
    expect(pos[0]).toBeCloseTo(-5);
    expect(pos[1]).toBeCloseTo(0);
    expect(pos[2]).toBeCloseTo(0);
  });

  it('+A translation moves to three.js +Z', () => {
    const pos = applyTranslation([0, 0, 0], [0, 5, 0], RAS);
    expect(pos[0]).toBeCloseTo(0);
    expect(pos[1]).toBeCloseTo(0);
    expect(pos[2]).toBeCloseTo(5);
  });

  it('+S translation moves to three.js +Y', () => {
    const pos = applyTranslation([0, 0, 0], [0, 0, 5], RAS);
    expect(pos[0]).toBeCloseTo(0);
    expect(pos[1]).toBeCloseTo(5);
    expect(pos[2]).toBeCloseTo(0);
  });

  it('works with BREGMA_ARID basis', () => {
    const cs = {
      axes: [
        { direction: 'Posterior_to_anterior' },
        { direction: 'Left_to_right' },
        { direction: 'Superior_to_inferior' },
      ],
    };
    const cols = buildCoordBasis(cs).columns;
    // v[0]=AP(+anterior) → three.js +Z; v[1]=ML(+right) → three.js −X
    const pos = applyTranslation([0, 0, 0], [3, 2, 1], cols);
    expect(pos[0]).toBeCloseTo(-2); // ML=2 → −2 in X
    expect(pos[1]).toBeCloseTo(-1); // SI=1 (S→I) → −1 in Y
    expect(pos[2]).toBeCloseTo(3);  // AP=3 → +3 in Z
  });
});

// ── computeProbeDirection ───────────────────────────────────────────────────
// Three.js: X = −R, Y = +S, Z = +A.  Probe at rest = +A = (0, 0, 1).

describe('computeProbeDirection', () => {
  it('returns +Z unit vector when no transforms are given (probe points anterior)', () => {
    const [x, y, z] = computeProbeDirection([]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it('returns +Z when only a zero rotation is given', () => {
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [0, 0, 0] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it('ignores Translation objects (only rotations affect direction)', () => {
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Translation', translation: [10, 20, 30] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it('Rx(90°) rotates anterior probe to point superior (dorsal)', () => {
    // RAS Rx(90°) around R axis: A→S.  three.js: (0,0,1)→(0,1,0).
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [90, 0, 0] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });

  it('Rx(-90°) rotates anterior probe to point inferior (ventral)', () => {
    // RAS Rx(-90°): A→−S.  three.js: (0,0,1)→(0,−1,0).
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [-90, 0, 0] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-1);
    expect(z).toBeCloseTo(0);
  });

  it('Ry(90°) leaves anterior probe unchanged (A axis is the probe direction at rest)', () => {
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [0, 90, 0] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it('Rz(90°) rotates anterior probe to point left (−R)', () => {
    // RAS Rz(90°) around S axis: A→−R.
    // −R in three.js = −(−1,0,0) = (+1,0,0).
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [0, 0, 90] },
    ]);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it('Rz(-90°) rotates anterior probe to point right (+R)', () => {
    // RAS Rz(-90°) around S axis: A→+R.
    // +R in three.js = (−1,0,0).
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [0, 0, -90] },
    ]);
    expect(x).toBeCloseTo(-1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it('result is a unit vector', () => {
    const dir = computeProbeDirection([
      { object_type: 'Rotation', angles: [30, 45, -20] },
    ]);
    const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
    expect(len).toBeCloseTo(1, 6);
  });

  it('applies multiple rotations in sequence (extrinsic, around fixed world axes)', () => {
    // Rx(-90°): A → −S.  three.js: (0,0,1) → (0,−1,0).
    // Ry(90°): rotate around A axis; −S → −R (RAS Ry(90°): S → R, so −S → −R).
    //          −R in three.js = (+1,0,0).
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [-90, 0, 0] },
      { object_type: 'Rotation', angles: [0, 90, 0] },
    ]);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it('handles null transforms array gracefully', () => {
    const [x, y, z] = computeProbeDirection(null);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it('handles missing angles array gracefully', () => {
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation' },
    ]);
    expect(z).toBeCloseTo(1);
  });

  it('compound [90, 0, -90]: Rx(90) makes probe vertical, Rz(-90) around S leaves it vertical', () => {
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [90, 0, -90] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });

  it('accepts a custom coordinate system', () => {
    // BREGMA_ARID: axis-0=AP, axis-1=ML, axis-2=SI.
    // Probe at rest along axis 1 = ML = +R → three.js (−1,0,0).
    const cs = {
      axes: [
        { direction: 'Posterior_to_anterior' },
        { direction: 'Left_to_right' },
        { direction: 'Superior_to_inferior' },
      ],
    };
    const [x, y, z] = computeProbeDirection([], cs);
    expect(x).toBeCloseTo(-1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });
});

// ── computeProbeDirectionSteps ──────────────────────────────────────────────

describe('computeProbeDirectionSteps', () => {
  it('returns initial state when no transforms', () => {
    const steps = computeProbeDirectionSteps([]);
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('initial');
    expect(steps[0].dir[2]).toBeCloseTo(1); // anterior
    expect(steps[0].pos).toEqual([0, 0, 0]);
  });

  it('tracks direction and width through rotations', () => {
    const steps = computeProbeDirectionSteps([
      { object_type: 'Rotation', angles: [90, 0, 0] },
    ]);
    expect(steps).toHaveLength(2);
    // After Rx(90°): dir was A=(0,0,1), now S=(0,1,0)
    expect(steps[1].dir[1]).toBeCloseTo(1);
    // wid was R=(-1,0,0), Rx around R leaves it unchanged
    expect(steps[1].wid[0]).toBeCloseTo(-1);
  });

  it('tracks position through translations', () => {
    const steps = computeProbeDirectionSteps([
      { object_type: 'Translation', translation: [5, 3, 2] },
    ]);
    expect(steps).toHaveLength(2);
    // Default RAS: v[0]=R→-X, v[1]=A→+Z, v[2]=S→+Y
    expect(steps[1].pos[0]).toBeCloseTo(-5); // R → −X
    expect(steps[1].pos[1]).toBeCloseTo(2);  // S → +Y
    expect(steps[1].pos[2]).toBeCloseTo(3);  // A → +Z
  });

  it('accumulates position across multiple translations', () => {
    const steps = computeProbeDirectionSteps([
      { object_type: 'Translation', translation: [1, 0, 0] },
      { object_type: 'Translation', translation: [1, 0, 0] },
    ]);
    expect(steps[2].pos[0]).toBeCloseTo(-2); // 2 × R → −2 in X
  });

  it('includes wid field for roll tracking', () => {
    const steps = computeProbeDirectionSteps([
      { object_type: 'Rotation', angles: [0, 90, 0] },
    ]);
    // Ry(90°) around A: wid was R=(-1,0,0), should rotate to −S=(0,−1,0)
    expect(steps[1].wid[0]).toBeCloseTo(0);
    expect(steps[1].wid[1]).toBeCloseTo(-1);
    expect(steps[1].wid[2]).toBeCloseTo(0);
  });
});

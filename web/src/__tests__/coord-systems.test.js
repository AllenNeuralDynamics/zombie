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
import { parseTranslation, parseDeviceConfigCoords, computeProbeDirection } from '../lib/coord-systems.js';

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

// ── computeProbeDirection ───────────────────────────────────────────────────

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

  it('Rx(90°) rotates +Z to -Y (ventral)', () => {
    // Rx: y1 = cos(90)*z_y - sin(90)*z_z = 0 - 1 = -1, z1 = sin(90)*0 + cos(90)*1 = 0
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [90, 0, 0] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-1);
    expect(z).toBeCloseTo(0);
  });

  it('Rx(-90°) rotates +Z to +Y (dorsal)', () => {
    // Rx(-90): y1 = cos(-90)*0 - sin(-90)*1 = 1, z1 = sin(-90)*0 + cos(-90)*1 = 0
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [-90, 0, 0] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
    expect(z).toBeCloseTo(0);
  });

  it('Ry(90°) rotates +Z to +X (right/ML)', () => {
    // Ry: x2 = cos(90)*0 + sin(90)*1 = 1, z2 = -sin(90)*0 + cos(90)*1 = 0
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [0, 90, 0] },
    ]);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
  });

  it('Rz(90°) does not affect +Z (Rz only rotates the XY plane)', () => {
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [0, 0, 90] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it('Rz(-90°) does not affect +Z', () => {
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [0, 0, -90] },
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
  });

  it('result is a unit vector', () => {
    const dir = computeProbeDirection([
      { object_type: 'Rotation', angles: [30, 45, -20] },
    ]);
    const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2);
    expect(len).toBeCloseTo(1, 6);
  });

  it('applies multiple rotations in sequence (extrinsic)', () => {
    // Rx(-90) makes +Z → +Y (dorsal), then Ry(90) rotates +Y unchanged → +Y
    // because Ry only rotates the XZ plane.
    const [x, y, z] = computeProbeDirection([
      { object_type: 'Rotation', angles: [-90, 0, 0] }, // +Z → +Y
      { object_type: 'Rotation', angles: [0, 90, 0] },  // Ry on (0,1,0): Y unaffected
    ]);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(1);
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
      { object_type: 'Rotation' }, // no angles property — defaults to [0,0,0]
    ]);
    expect(z).toBeCloseTo(1); // unchanged
  });
});

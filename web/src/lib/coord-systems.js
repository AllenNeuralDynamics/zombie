/**
 * coord-systems.js — Coordinate system parsing for AIND procedure metadata.
 *
 * Two levels of coordinate conversion:
 *
 * 1. Semantic (ap / ml / dv / depth) — for display and data tables.
 *    See: parseTranslation, parseDeviceConfigCoords.
 *
 * 2. Three.js space — for 3D rendering (rotations, translations, probe direction).
 *    See: buildCoordBasis, applyExtrinsicRotation, applyTranslation,
 *         computeProbeDirection, computeProbeDirectionSteps.
 *
 * Canonical three.js layout (origin = Bregma, units = mm):
 *   X = −R   (screen-right when viewing from behind the brain)
 *   Y = +S   (superior / dorsal = up)
 *   Z = +A   (anterior, into screen when viewing from behind)
 *
 * Any source coordinate system is described by a 3×3 basis whose columns
 * map the system's axes [0, 1, 2] to three.js unit vectors.  Rotations and
 * translations apply through this basis, so the math is coordinate-system-
 * agnostic once the basis is built.
 */

/**
 * Map an axis direction string to a canonical dimension and the sign
 * needed to convert from "positive in named direction" to "positive in
 * canonical direction" (anterior, right, dorsal).
 *
 * Supported directions (case-insensitive):
 *   ML: "Left_to_right", "Right_to_left"
 *   AP: "Anterior_to_posterior", "Posterior_to_anterior"
 *   DV: "Inferior_to_superior", "Superior_to_inferior"
 *
 * Returns { dim: 'ap'|'ml'|'dv', sign: 1|-1 } or null if unrecognised.
 */
function _directionToCanonical(direction) {
  if (!direction) return null;
  const dir = direction.toLowerCase().trim();

  // ── ML (canonical: right = positive) ──────────────────────────────
  if (dir === 'left_to_right') return { dim: 'ml', sign: 1 };
  if (dir === 'right_to_left') return { dim: 'ml', sign: -1 };

  // ── AP (canonical: anterior = positive) ───────────────────────────
  if (dir === 'anterior_to_posterior') return { dim: 'ap', sign: -1 }; // positive direction is posterior → flip
  if (dir === 'posterior_to_anterior') return { dim: 'ap', sign: 1 };  // positive direction is anterior ✓

  // ── DV (canonical: dorsal = positive) ─────────────────────────────
  if (dir === 'superior_to_inferior') return { dim: 'dv', sign: -1 }; // positive direction is ventral → flip
  if (dir === 'inferior_to_superior') return { dim: 'dv', sign: 1 };  // positive direction is dorsal ✓

  console.warn('[coord-systems] Unrecognised axis direction:', direction);
  return null;
}

/**
 * Parse a coordinate_system object and a translation array into canonical
 * brain coordinates.
 *
 * @param {object|null} coordinateSystem - The coordinate_system object from metadata,
 *   or null to use the BREGMA_ARID fallback (v0=AP, v1=ML, v2=DV, v3=depth).
 * @param {number[]} translation - Array of up to 4 numeric values.
 * @returns {{ ap: number, ml: number, dv: number|null, depth: number|null }}
 *   All values in millimetres, canonical sign conventions.
 */
export function parseTranslation(coordinateSystem, translation) {
  const v = Array.isArray(translation) ? translation : [];
  const safeNum = (x) => (x != null && isFinite(Number(x)) ? Number(x) : null);

  // Always read depth from index 3 regardless of coordinate system
  const depth = v.length > 3 ? Math.abs(safeNum(v[3]) ?? 0) : null;

  // Fallback: BREGMA_ARID convention (v0=AP anterior+, v1=ML right+, v2=DV dorsal+)
  if (!coordinateSystem || !Array.isArray(coordinateSystem.axes)) {
    return {
      ap:    safeNum(v[0]) ?? 0,
      ml:    safeNum(v[1]) ?? 0,
      dv:    safeNum(v[2]),
      depth,
    };
  }

  const result = { ap: 0, ml: 0, dv: null, depth };

  coordinateSystem.axes.forEach((axis, i) => {
    if (i >= 3) return; // only first 3 axis components
    const val = safeNum(v[i]);
    if (val == null) return;
    const mapping = _directionToCanonical(axis?.direction);
    if (!mapping) return;
    result[mapping.dim] = val * mapping.sign;
  });

  return result;
}

/**
 * Convenience wrapper: extract canonical coords from a device_config object.
 * Reads device_config.coordinate_system and the first Translation in
 * device_config.transform.
 *
 * @param {object} deviceConfig
 * @returns {{ ap: number, ml: number, dv: number|null, depth: number|null }}
 */
export function parseDeviceConfigCoords(deviceConfig) {
  const coordSys = deviceConfig?.coordinate_system ?? null;
  let translation = null;
  for (const t of (deviceConfig?.transform ?? [])) {
    if (t?.object_type === 'Translation') {
      translation = t.translation;
      break;
    }
  }
  return parseTranslation(coordSys, translation ?? []);
}

// ── Three.js coordinate basis ───────────────────────────────────────────────
//
// Maps anatomical direction strings to three.js unit vectors.
// Canonical three.js layout: X = −R, Y = +S, Z = +A.

/**
 * Map an anatomical direction string to its three.js unit vector.
 *
 * @param {string} direction - e.g. 'Left_to_right', 'Posterior_to_anterior'.
 * @returns {[number,number,number]|null} Three.js unit vector, or null.
 */
export function directionToThreeJS(direction) {
  if (!direction) return null;
  const dir = direction.toLowerCase().trim();

  if (dir === 'left_to_right')        return [-1,  0,  0]; // +R → three.js −X
  if (dir === 'right_to_left')        return [ 1,  0,  0]; // −R → three.js +X
  if (dir === 'posterior_to_anterior') return [ 0,  0,  1]; // +A → three.js +Z
  if (dir === 'anterior_to_posterior') return [ 0,  0, -1]; // −A → three.js −Z
  if (dir === 'inferior_to_superior') return [ 0,  1,  0]; // +S → three.js +Y
  if (dir === 'superior_to_inferior') return [ 0, -1,  0]; // −S → three.js −Y

  return null;
}

/**
 * Default basis for BREGMA_RAS: axis-0 = R, axis-1 = A, axis-2 = S.
 * Probe at rest points along axis 1 (anterior).
 */
const DEFAULT_BASIS = [
  [-1, 0, 0], // R → three.js −X
  [ 0, 0, 1], // A → three.js +Z
  [ 0, 1, 0], // S → three.js +Y
];

/**
 * Build a 3×3 orthogonal basis (as column vectors) that maps a source
 * coordinate system's axes to three.js directions.
 *
 * @param {object|null} coordinateSystem - coordinate_system with axes[], or null.
 * @returns {{ columns: Array<[number,number,number]> }}
 *   columns[i] is the three.js unit vector for source axis i.
 */
export function buildCoordBasis(coordinateSystem) {
  if (!coordinateSystem?.axes?.length) return { columns: DEFAULT_BASIS };

  const columns = [];
  for (let i = 0; i < 3 && i < coordinateSystem.axes.length; i++) {
    const vec = directionToThreeJS(coordinateSystem.axes[i]?.direction);
    if (!vec) {
      console.warn('[coord-systems] Unrecognised axis direction, using default basis');
      return { columns: DEFAULT_BASIS };
    }
    columns.push(vec);
  }
  if (columns.length < 3) return { columns: DEFAULT_BASIS };
  return { columns };
}

/**
 * Rotate a 3-vector around an arbitrary unit axis by an angle (right-hand rule).
 * Uses Rodrigues' rotation formula.  Pure math — no Three.js dependency.
 */
function _axisAngleRotate(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const [ax, ay, az] = axis;
  const [vx, vy, vz] = v;
  const dot = ax * vx + ay * vy + az * vz;
  return [
    vx * c + (ay * vz - az * vy) * s + ax * dot * (1 - c),
    vy * c + (az * vx - ax * vz) * s + ay * dot * (1 - c),
    vz * c + (ax * vy - ay * vx) * s + az * dot * (1 - c),
  ];
}

/**
 * Apply extrinsic (fixed-axes) rotations to a vector.
 *
 * For each axis i, rotates by angles[i] degrees around basisColumns[i],
 * applied in order i = 0, 1, 2.  Extrinsic means each rotation is around
 * the fixed world axis, not the rotated body axis.
 *
 * @param {[number,number,number]} v - Input vector in three.js space.
 * @param {number[]} angles - [a, b, c] rotation angles in degrees.
 * @param {Array<[number,number,number]>} basisColumns - Three.js axis vectors.
 * @returns {[number,number,number]} Rotated vector.
 */
export function applyExtrinsicRotation(v, angles, basisColumns) {
  const deg = Math.PI / 180;
  let result = [v[0], v[1], v[2]];
  for (let i = 0; i < 3; i++) {
    const a = (angles[i] ?? 0) * deg;
    if (Math.abs(a) < 1e-12) continue;
    result = _axisAngleRotate(result, basisColumns[i], a);
  }
  return result;
}

/**
 * Translate a position using basis columns.
 *
 * @param {[number,number,number]} pos - Current position in three.js space.
 * @param {number[]} translation - [v0, v1, v2, ...] in source coordinate system.
 * @param {Array<[number,number,number]>} basisColumns - Three.js axis vectors.
 * @returns {[number,number,number]} Updated position.
 */
export function applyTranslation(pos, translation, basisColumns) {
  const result = [pos[0], pos[1], pos[2]];
  for (let i = 0; i < 3 && i < translation.length; i++) {
    const v = translation[i] ?? 0;
    result[0] += v * basisColumns[i][0];
    result[1] += v * basisColumns[i][1];
    result[2] += v * basisColumns[i][2];
  }
  return result;
}

/**
 * Compute the probe direction unit vector after applying a sequence of extrinsic
 * rotations from a probe's transform list.
 *
 * The probe at rest points along basis axis 1 (anterior in BREGMA_RAS).
 * Translation objects are ignored (they do not change direction).
 *
 * @param {Array} transforms - Array of Rotation/Translation objects from probe.transform.
 * @param {object|null} [coordinateSystem=null] - coordinate_system defining the axes.
 * @returns {[number, number, number]} Unit vector [x, y, z] in three.js space.
 */
export function computeProbeDirection(transforms, coordinateSystem = null) {
  const { columns } = buildCoordBasis(coordinateSystem);
  let dir = [columns[1][0], columns[1][1], columns[1][2]]; // at rest: axis 1

  for (const t of (transforms ?? [])) {
    if (t?.object_type !== 'Rotation') continue;
    dir = applyExtrinsicRotation(dir, t.angles ?? [], columns);
  }

  const len = Math.sqrt(dir[0] ** 2 + dir[1] ** 2 + dir[2] ** 2) || 1;
  return [dir[0] / len, dir[1] / len, dir[2] / len];
}

/**
 * Walk through a probe's transform chain and return a state snapshot after
 * every step (Rotation OR Translation), including the initial at-rest state.
 *
 * Both rotations and translations are interpreted in the given coordinate
 * system (default BREGMA_RAS).  The probe at rest points along axis 1 with
 * its width along axis 0.
 *
 * @param {Array} transforms - Array of Rotation/Translation objects.
 * @param {object|null} [coordinateSystem=null] - coordinate_system defining the axes.
 * @returns {Array<{dir, wid, pos, type}>}
 */
export function computeProbeDirectionSteps(transforms, coordinateSystem = null) {
  const { columns } = buildCoordBasis(coordinateSystem);
  let dir = [columns[1][0], columns[1][1], columns[1][2]]; // axis 1
  let wid = [columns[0][0], columns[0][1], columns[0][2]]; // axis 0
  let pos = [0, 0, 0];

  const norm = (v) => {
    const l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  const steps = [{ dir: norm(dir), wid: norm(wid), pos: [...pos], type: 'initial' }];

  for (const t of (transforms ?? [])) {
    const type = t?.object_type ?? 'Unknown';

    if (type === 'Rotation') {
      dir = applyExtrinsicRotation(dir, t.angles ?? [], columns);
      wid = applyExtrinsicRotation(wid, t.angles ?? [], columns);
    } else if (type === 'Translation') {
      pos = applyTranslation(pos, t.translation ?? [], columns);
    }

    steps.push({ dir: norm(dir), wid: norm(wid), pos: [...pos], type });
  }

  return steps;
}

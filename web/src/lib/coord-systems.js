/**
 * coord-systems.js — Coordinate system parsing for AIND procedure metadata.
 *
 * Converts a `coordinate_system` object (from a device_config or procedure) plus
 * a `translation` array into canonical brain coordinates:
 *
 *   ap    — mm from bregma, positive = anterior
 *   ml    — mm from bregma, positive = right
 *   dv    — mm from bregma, positive = dorsal (up)
 *   depth — mm from brain surface, always positive
 *
 * The translation array has up to 4 values: [v0, v1, v2, v3].
 *   v0..v2 correspond to coordinate_system.axes[0..2] in order.
 *   v3 is always depth-from-surface (axis-independent, sign is ignored).
 *
 * If no coordinate_system is provided, falls back to the BREGMA_ARID convention:
 *   v0 = AP (positive anterior), v1 = ML (positive right), v2 = DV, v3 = depth.
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

/**
 * Compute the probe direction unit vector after applying a sequence of extrinsic
 * right-hand-rule rotations from an ephys probe's transform list.
 *
 * The probe starts pointing in the +Y direction (vertical, tip down).
 * Each Rotation object with angles [a, b, c] applies an extrinsic XYZ rotation:
 * rotate around world X by `a` degrees, then world Y by `b`, then world Z by `c`.
 * The combined matrix for one step is Rz(c) · Ry(b) · Rx(a).
 * Translation objects are ignored (translations do not change direction).
 *
 * Result coordinates are in PROBE_RUFD space (X=ML right+, Y=DV dorsal+, Z=AP anterior+).
 *
 * @param {Array} transforms - Array of Rotation/Translation objects from probe.transform.
 * @returns {[number, number, number]} Unit vector [x, y, z].
 */
export function computeProbeDirection(transforms) {
  // Initial direction: probe points in +Z (anterior) before any rotations
  let x = 0, y = 0, z = 1;

  for (const t of (transforms ?? [])) {
    if (t?.object_type !== 'Rotation') continue;
    const [aDeg = 0, bDeg = 0, cDeg = 0] = t.angles ?? [];
    const a = aDeg * (Math.PI / 180);
    const b = bDeg * (Math.PI / 180);
    const c = cDeg * (Math.PI / 180);

    // Extrinsic XYZ: apply Rx(a), then Ry(b), then Rz(c) around world axes.
    // Equivalent to combined matrix Rz(c) · Ry(b) · Rx(a) applied to column vector.

    // Rx(a): rotates Y→Y·cos-Z·sin, Z→Y·sin+Z·cos  (X unchanged)
    const y1 = Math.cos(a) * y - Math.sin(a) * z;
    const z1 = Math.sin(a) * y + Math.cos(a) * z;
    y = y1; z = z1;

    // Ry(b): rotates X→X·cos+Z·sin, Z→-X·sin+Z·cos  (Y unchanged)
    const x2 = Math.cos(b) * x + Math.sin(b) * z;
    const z2 = -Math.sin(b) * x + Math.cos(b) * z;
    x = x2; z = z2;

    // Rz(c): rotates X→X·cos-Y·sin, Y→X·sin+Y·cos  (Z unchanged)
    const x3 = Math.cos(c) * x - Math.sin(c) * y;
    const y3 = Math.sin(c) * x + Math.cos(c) * y;
    x = x3; y = y3;
  }

  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / len, y / len, z / len];
}

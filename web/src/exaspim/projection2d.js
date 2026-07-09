/**
 * exaspim/projection2d.js — Geometry helpers for the 2D neuron-morphology
 * projection view.
 *
 * Everything here is pure / data-only (no Three.js, no DOM) so it can be unit
 * tested in node. The Three.js renderer lives in `projection2d-view.js`.
 *
 * Coordinate space: micrometres (µm) in CCFv3, the SAME space used by:
 *   - the CCF area surface meshes on S3 (`…/data-asset-cache/meshes/{id}.obj`)
 *   - the AIND precomputed neuron skeletons (`…/ngv01/full/skeleton/{segId}`,
 *     stored in µm — the precomputed `transform` scales ×1000 to nm)
 *   - the MouseLight `/tracings` skeleton nodes (µm)
 *
 * A "projection" drops one axis and maps the remaining two onto screen X/Y.
 * Outlines of the (closed, solid) area meshes are recovered by rasterising the
 * projected triangles into an occupancy grid and tracing the 0.5 iso-contour
 * with marching squares (d3-contour) — this naturally yields multiple rings
 * (e.g. the left/right boundaries seen in a coronal view) and any holes.
 */

import { contours as d3contours } from 'd3-contour';

// ─── Projection planes ──────────────────────────────────────────────────────
// CCF axes (µm):  index 0 = x = AP,  1 = y = DV,  2 = z = ML.
// `h` / `v` pick the horizontal / vertical data axis; `sh` / `sv` flip the
// sign so the rendered orientation reads correctly (dorsal up).

/** @type {Record<string,{label:string,h:number,v:number,sh:number,sv:number}>} */
export const PLANES = {
  sagittal: { label: 'Sagittal', h: 0, v: 1, sh: 1, sv: -1 }, // AP × DV  (view along ML)
  coronal: { label: 'Coronal', h: 2, v: 1, sh: 1, sv: -1 }, //  ML × DV  (view along AP)
  axial: { label: 'Axial', h: 0, v: 2, sh: 1, sv: 1 },       //  AP × ML  (view along DV)
};

export const PLANE_KEYS = ['sagittal', 'coronal', 'axial'];

// ─── OBJ parsing ────────────────────────────────────────────────────────────

/**
 * Parse a Wavefront OBJ into flat typed arrays. Only `v` (vertex) and `f`
 * (face) records are used; faces are fan-triangulated and may carry `v/vt/vn`
 * slash references. Vertex indices are 1-based (negative = relative).
 *
 * @param {string} text
 * @returns {{positions: Float32Array, index: Uint32Array}}
 */
export function parseObjMesh(text) {
  const verts = [];
  const faces = [];
  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const c0 = line.charCodeAt(0);
    if (c0 === 118 /* v */ && line.charCodeAt(1) === 32 /* space */) {
      const p = line.split(/\s+/);
      verts.push(+p[1], +p[2], +p[3]);
    } else if (c0 === 102 /* f */ && line.charCodeAt(1) === 32) {
      const p = line.trim().split(/\s+/);
      const nVerts = verts.length / 3;
      const resolve = (tok) => {
        const s = tok.indexOf('/');
        const vi = parseInt(s === -1 ? tok : tok.slice(0, s), 10);
        return vi > 0 ? vi - 1 : nVerts + vi;
      };
      const a = resolve(p[1]);
      for (let i = 3; i < p.length; i++) {
        faces.push(a, resolve(p[i - 1]), resolve(p[i]));
      }
    }
  }
  return { positions: Float32Array.from(verts), index: Uint32Array.from(faces) };
}

// ─── Silhouette extraction ──────────────────────────────────────────────────

function edgeFn(ax, ay, bx, by, px, py) {
  return (px - ax) * (by - ay) - (py - ay) * (bx - ax);
}

/** Fill a projected triangle into the occupancy grid (winding-agnostic). */
function rasterTriangle(grid, nx, ny, oH, oV, cell, ax, ay, bx, by, cx, cy) {
  const area = edgeFn(ax, ay, bx, by, cx, cy);
  if (area === 0) return;
  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minY = Math.min(ay, by, cy);
  const maxY = Math.max(ay, by, cy);
  const ix0 = Math.max(0, Math.floor((minX - oH) / cell));
  const ix1 = Math.min(nx - 1, Math.ceil((maxX - oH) / cell));
  const iy0 = Math.max(0, Math.floor((minY - oV) / cell));
  const iy1 = Math.min(ny - 1, Math.ceil((maxY - oV) / cell));
  for (let iy = iy0; iy <= iy1; iy++) {
    const py = oV + iy * cell;
    for (let ix = ix0; ix <= ix1; ix++) {
      const px = oH + ix * cell;
      const w0 = edgeFn(bx, by, cx, cy, px, py);
      const w1 = edgeFn(cx, cy, ax, ay, px, py);
      const w2 = edgeFn(ax, ay, bx, by, px, py);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        grid[iy * nx + ix] = 1;
      }
    }
  }
}

/**
 * Recover the projected outline(s) of a solid mesh on a plane.
 *
 * @param {Float32Array} positions  Flat vertex coords (x,y,z…).
 * @param {Uint32Array} index       Triangle vertex indices.
 * @param {{h:number,v:number}} plane
 * @param {{cell?:number, pad?:number}} [opts]  Grid cell size + padding (µm).
 * @returns {Array<Array<[number,number]>>}  Rings in (h,v) µm space.
 */
export function computeSilhouettePolylines(positions, index, plane, opts = {}) {
  const cell = opts.cell ?? 40;
  const pad = opts.pad ?? cell * 3;
  const hI = plane.h;
  const vI = plane.v;
  const nVerts = positions.length / 3;
  if (nVerts === 0 || index.length === 0) return [];

  let minH = Infinity;
  let maxH = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let i = 0; i < nVerts; i++) {
    const h = positions[i * 3 + hI];
    const v = positions[i * 3 + vI];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const originH = minH - pad;
  const originV = minV - pad;
  const nx = Math.max(2, Math.ceil((maxH - minH + 2 * pad) / cell) + 1);
  const ny = Math.max(2, Math.ceil((maxV - minV + 2 * pad) / cell) + 1);
  const grid = new Float64Array(nx * ny);

  const nTri = index.length / 3;
  for (let t = 0; t < nTri; t++) {
    const a = index[t * 3];
    const b = index[t * 3 + 1];
    const c = index[t * 3 + 2];
    rasterTriangle(
      grid, nx, ny, originH, originV, cell,
      positions[a * 3 + hI], positions[a * 3 + vI],
      positions[b * 3 + hI], positions[b * 3 + vI],
      positions[c * 3 + hI], positions[c * 3 + vI],
    );
  }

  const geometries = d3contours().size([nx, ny]).thresholds([0.5])(grid);
  const out = [];
  for (const geo of geometries) {
    for (const polygon of geo.coordinates) {
      for (const ring of polygon) {
        const line = new Array(ring.length);
        for (let i = 0; i < ring.length; i++) {
          line[i] = [originH + ring[i][0] * cell, originV + ring[i][1] * cell];
        }
        out.push(line);
      }
    }
  }
  return out;
}

// ─── Skeleton parsing + projection ──────────────────────────────────────────

/**
 * Parse a Neuroglancer precomputed skeleton fragment.
 * Layout (little-endian): uint32 numVertices, uint32 numEdges,
 *   float32[numVertices*3] vertices, uint32[numEdges*2] edges, then vertex
 *   attributes (ignored here).
 *
 * @param {ArrayBuffer} buffer
 * @returns {{vertices: Float32Array, edges: Uint32Array}}  Vertices in µm.
 */
export function parseSkeletonBinary(buffer) {
  const dv = new DataView(buffer);
  const nv = dv.getUint32(0, true);
  const ne = dv.getUint32(4, true);
  const vertices = new Float32Array(buffer, 8, nv * 3).slice();
  const edges = new Uint32Array(buffer, 8 + nv * 12, ne * 2).slice();
  return { vertices, edges };
}

/**
 * Flatten MouseLight `/tracings` node arrays into the same {vertices, edges}
 * shape as a precomputed skeleton (parent→child edges). Coords are µm.
 *
 * @param {Array<{nodes:Array<{sampleNumber:number,parentNumber:number,x:number,y:number,z:number}>}>} tracings
 * @returns {{vertices: Float32Array, edges: Uint32Array}}
 */
export function tracingsToSkeleton(tracings) {
  const verts = [];
  const edges = [];
  for (const tr of tracings ?? []) {
    const idxByNum = new Map();
    const nodes = tr.nodes ?? [];
    for (const n of nodes) {
      idxByNum.set(n.sampleNumber, verts.length / 3);
      verts.push(n.x, n.y, n.z);
    }
    for (const n of nodes) {
      if (n.parentNumber == null || n.parentNumber < 0) continue;
      const pi = idxByNum.get(n.parentNumber);
      const ci = idxByNum.get(n.sampleNumber);
      if (pi == null || ci == null) continue;
      edges.push(ci, pi);
    }
  }
  return { vertices: Float32Array.from(verts), edges: Uint32Array.from(edges) };
}

/**
 * Project skeleton edges to flat screen-space line-segment endpoints
 * (consecutive pairs = one segment), z = 0.
 *
 * @returns {Float32Array}
 */
export function projectEdgesToSegments(vertices, edges, plane) {
  const m = edges.length / 2;
  const arr = new Float32Array(m * 6);
  let o = 0;
  for (let i = 0; i < m; i++) {
    const a = edges[i * 2];
    const b = edges[i * 2 + 1];
    arr[o++] = plane.sh * vertices[a * 3 + plane.h];
    arr[o++] = plane.sv * vertices[a * 3 + plane.v];
    arr[o++] = 0;
    arr[o++] = plane.sh * vertices[b * 3 + plane.h];
    arr[o++] = plane.sv * vertices[b * 3 + plane.v];
    arr[o++] = 0;
  }
  return arr;
}

/**
 * Convert outline rings (in (h,v) µm) to flat screen-space line-segment
 * endpoints, closing each ring.
 *
 * @returns {Float32Array}
 */
export function polylinesToSegments(polylines, plane) {
  let total = 0;
  for (const ring of polylines) total += ring.length;
  const arr = new Float32Array(total * 6);
  let o = 0;
  for (const ring of polylines) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % n];
      arr[o++] = plane.sh * p[0];
      arr[o++] = plane.sv * p[1];
      arr[o++] = 0;
      arr[o++] = plane.sh * q[0];
      arr[o++] = plane.sv * q[1];
      arr[o++] = 0;
    }
  }
  return arr;
}

/** Axis-aligned bounds (screen space) across a list of {positions} items. */
export function boundsOfItems(items) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const it of items) {
    const p = it.positions;
    if (!p) continue;
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i];
      const y = p[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      any = true;
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

// ─── Remote geometry (fetch + cache) ────────────────────────────────────────

const MESH_BASE = 'https://allen-data-views.s3.us-west-2.amazonaws.com/data-asset-cache/meshes/';
const AIND_SKEL_BASE = 'https://aind-neuron-morphology-community-portal-prod-o5171v.s3.amazonaws.com/ngv01/';

const _meshCache = new Map(); // id → Promise<{positions, index}>
const _outlineCache = new Map(); // `${id}:${plane}` → Promise<Float32Array>
const _polylineCache = new Map(); // `${id}:${plane}` → Promise<Array<Array<[number,number]>>>
const _skelCache = new Map(); // `${compartment}:${segId}` → Promise<{vertices, edges}>

/** Fetch + parse a CCF area surface mesh (cached). */
export function loadCcfMesh(id, signal) {
  const key = String(id);
  if (!_meshCache.has(key)) {
    _meshCache.set(key, fetch(MESH_BASE + key + '.obj', { signal })
      .then((r) => { if (!r.ok) throw new Error(`mesh ${key} HTTP ${r.status}`); return r.text(); })
      .then(parseObjMesh)
      .catch((e) => { _meshCache.delete(key); throw e; }));
  }
  return _meshCache.get(key);
}

/** Outline line-segments for an area on a plane (cached per id+plane). */
export function getCcfOutlineSegments(id, planeKey, signal) {
  const ck = `${id}:${planeKey}`;
  if (!_outlineCache.has(ck)) {
    const plane = PLANES[planeKey];
    const p = loadCcfMesh(id, signal)
      .then((mesh) => polylinesToSegments(
        computeSilhouettePolylines(mesh.positions, mesh.index, plane), plane))
      .catch((e) => { _outlineCache.delete(ck); throw e; });
    _outlineCache.set(ck, p);
  }
  return _outlineCache.get(ck);
}

/**
 * Screen-space polyline rings for a CCF area on a plane (cached). Returns
 * `Array<Array<[x, y]>>` with the plane's sign flips already applied — the
 * same coordinate space used by the Three.js 2D renderer.
 */
export function getCcfScreenPolylines(id, planeKey, signal) {
  const ck = `polys:${id}:${planeKey}`;
  if (!_polylineCache.has(ck)) {
    const plane = PLANES[planeKey];
    const p = loadCcfMesh(id, signal)
      .then((mesh) => {
        const rings = computeSilhouettePolylines(mesh.positions, mesh.index, plane);
        return rings.map((ring) => ring.map(([h, v]) => [plane.sh * h, plane.sv * v]));
      })
      .catch((e) => { _polylineCache.delete(ck); throw e; });
    _polylineCache.set(ck, p);
  }
  return _polylineCache.get(ck);
}

/** Fetch + parse an AIND precomputed neuron skeleton (cached per compartment). */
export function loadAindSkeleton(segId, compartment = 'full', signal) {
  const comp = compartment || 'full';
  const key = `${comp}:${segId}`;
  if (!_skelCache.has(key)) {
    _skelCache.set(key, fetch(`${AIND_SKEL_BASE}${comp}/skeleton/${segId}`, { signal })
      .then((r) => { if (!r.ok) throw new Error(`skeleton ${key} HTTP ${r.status}`); return r.arrayBuffer(); })
      .then(parseSkeletonBinary)
      .catch((e) => { _skelCache.delete(key); throw e; }));
  }
  return _skelCache.get(key);
}

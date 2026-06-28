import { describe, it, expect } from 'vitest';
import {
  PLANES,
  PLANE_KEYS,
  parseObjMesh,
  parseSkeletonBinary,
  tracingsToSkeleton,
  projectEdgesToSegments,
  polylinesToSegments,
  computeSilhouettePolylines,
  boundsOfItems,
} from '../exaspim/projection2d.js';

describe('PLANES / PLANE_KEYS', () => {
  it('defines the three anatomical planes with data-axis + screen-sign mappings', () => {
    expect(PLANE_KEYS).toEqual(['sagittal', 'coronal', 'axial']);
    for (const key of PLANE_KEYS) {
      const p = PLANES[key];
      expect(typeof p.label).toBe('string');
      expect(p.h).toBeGreaterThanOrEqual(0);
      expect(p.h).toBeLessThanOrEqual(2);
      expect(p.v).toBeGreaterThanOrEqual(0);
      expect(p.v).toBeLessThanOrEqual(2);
      expect(Math.abs(p.sh)).toBe(1);
      expect(Math.abs(p.sv)).toBe(1);
    }
  });
});

describe('parseObjMesh', () => {
  it('parses vertices and fan-triangulates a quad face', () => {
    const obj = [
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'f 1 2 3 4',
    ].join('\n');
    const { positions, index } = parseObjMesh(obj);
    expect(positions.length).toBe(12); // 4 verts × 3
    expect(index.length).toBe(6); // quad → 2 triangles
    expect(Array.from(index)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('handles v/vt/vn slash refs and negative (relative) indices', () => {
    const obj = [
      'v 0 0 0',
      'v 1 0 0',
      'v 0 1 0',
      'f -3/1/1 -2/2/2 -1/3/3',
    ].join('\n');
    const { positions, index } = parseObjMesh(obj);
    expect(positions.length).toBe(9);
    expect(Array.from(index)).toEqual([0, 1, 2]);
  });
});

describe('parseSkeletonBinary', () => {
  it('reads numVertices/numEdges header then vertex + edge arrays', () => {
    const nv = 3;
    const ne = 2;
    const buf = new ArrayBuffer(8 + nv * 12 + ne * 8);
    const dv = new DataView(buf);
    dv.setUint32(0, nv, true);
    dv.setUint32(4, ne, true);
    const verts = new Float32Array(buf, 8, nv * 3);
    verts.set([0, 0, 0, 10, 0, 0, 10, 10, 0]);
    const edges = new Uint32Array(buf, 8 + nv * 12, ne * 2);
    edges.set([0, 1, 1, 2]);

    const skel = parseSkeletonBinary(buf);
    expect(Array.from(skel.vertices)).toEqual([0, 0, 0, 10, 0, 0, 10, 10, 0]);
    expect(Array.from(skel.edges)).toEqual([0, 1, 1, 2]);
  });
});

describe('tracingsToSkeleton', () => {
  it('flattens MouseLight nodes into parent→child edges', () => {
    const tracings = [{
      nodes: [
        { sampleNumber: 1, parentNumber: -1, x: 0, y: 0, z: 0 },
        { sampleNumber: 2, parentNumber: 1, x: 1, y: 0, z: 0 },
        { sampleNumber: 3, parentNumber: 2, x: 2, y: 0, z: 0 },
      ],
    }];
    const { vertices, edges } = tracingsToSkeleton(tracings);
    expect(Array.from(vertices)).toEqual([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    // two edges (root has no parent): child→parent index pairs
    expect(Array.from(edges)).toEqual([1, 0, 2, 1]);
  });

  it('returns empty arrays for nullish input', () => {
    const { vertices, edges } = tracingsToSkeleton(null);
    expect(vertices.length).toBe(0);
    expect(edges.length).toBe(0);
  });
});

describe('projectEdgesToSegments', () => {
  it('projects edges to flat z=0 endpoint pairs with screen signs applied', () => {
    const vertices = Float32Array.from([2, 4, 0, 3, 5, 7]);
    const edges = Uint32Array.from([0, 1]);
    // sagittal: h=0 (x), v=1 (y), sh=1, sv=-1
    const seg = projectEdgesToSegments(vertices, edges, PLANES.sagittal);
    expect(seg.length).toBe(6);
    expect(Array.from(seg)).toEqual([2, -4, 0, 3, -5, 0]);
  });

  it('uses the plane axis indices (coronal reads ML=z on h)', () => {
    const vertices = Float32Array.from([0, 0, 0, 1, 2, 9]);
    const edges = Uint32Array.from([0, 1]);
    // coronal: h=2 (z), v=1 (y)
    const seg = projectEdgesToSegments(vertices, edges, PLANES.coronal);
    expect(seg[3]).toBe(9); // h of second vertex = z = 9
    expect(seg[4]).toBe(-2); // v of second vertex = -y
  });
});

describe('polylinesToSegments', () => {
  it('closes each ring and emits one segment per edge', () => {
    const ring = [[0, 0], [10, 0], [10, 10]];
    // axial: h=0, v=2, sh=1, sv=1
    const seg = polylinesToSegments([ring], PLANES.axial);
    expect(seg.length).toBe(ring.length * 6); // 3 edges incl. closing
  });
});

describe('computeSilhouettePolylines', () => {
  it('produces at least one ring for a solid square mesh', () => {
    // A filled square in the x/y plane (two triangles), 1000µm wide.
    const positions = Float32Array.from([
      0, 0, 0,
      1000, 0, 0,
      1000, 1000, 0,
      0, 1000, 0,
    ]);
    const index = Uint32Array.from([0, 1, 2, 0, 2, 3]);
    const rings = computeSilhouettePolylines(positions, index, PLANES.sagittal, { cell: 100 });
    expect(rings.length).toBeGreaterThanOrEqual(1);
    expect(rings[0].length).toBeGreaterThanOrEqual(4);
  });

  it('returns empty for empty geometry', () => {
    expect(computeSilhouettePolylines(new Float32Array(0), new Uint32Array(0), PLANES.sagittal)).toEqual([]);
  });
});

describe('boundsOfItems', () => {
  it('computes screen-space bounds across items', () => {
    const items = [
      { positions: Float32Array.from([0, 0, 0, 5, 7, 0]) },
      { positions: Float32Array.from([-3, 2, 0, 1, 1, 0]) },
    ];
    expect(boundsOfItems(items)).toEqual({ minX: -3, minY: 0, maxX: 5, maxY: 7 });
  });

  it('returns null when there is nothing to bound', () => {
    expect(boundsOfItems([])).toBeNull();
    expect(boundsOfItems([{ positions: null }])).toBeNull();
  });
});

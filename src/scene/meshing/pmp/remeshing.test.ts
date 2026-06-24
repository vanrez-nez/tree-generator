import { describe, it, expect } from "vitest";
import { HalfedgeMesh } from "./halfedge-mesh";
import { uniformRemeshing, adaptiveRemeshing } from "./remeshing";
import { TriangleKdTree, type Triangle } from "./spatial";

// Closed sphere: octahedron, linearly subdivided with every vertex re-projected to the unit sphere.
function sphere(subdiv: number): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const verts = [
    m.addVertex(1, 0, 0), m.addVertex(-1, 0, 0),
    m.addVertex(0, 1, 0), m.addVertex(0, -1, 0),
    m.addVertex(0, 0, 1), m.addVertex(0, 0, -1),
  ];
  const [v0, v1, v2, v3, v4, v5] = verts;
  m.addTriangle(v0, v2, v4);
  m.addTriangle(v2, v1, v4);
  m.addTriangle(v1, v3, v4);
  m.addTriangle(v3, v0, v4);
  m.addTriangle(v2, v0, v5);
  m.addTriangle(v1, v2, v5);
  m.addTriangle(v3, v1, v5);
  m.addTriangle(v0, v3, v5);
  for (let i = 0; i < subdiv; i += 1) {
    // linear subdivision then project to unit sphere
    // (import lazily to avoid a cycle in fixtures)
    linearSubdivideInPlace(m);
    for (const v of m.vertices()) {
      const p = m.position(v);
      const n = Math.hypot(p[0], p[1], p[2]) || 1;
      m.setPosition(v, p[0] / n, p[1] / n, p[2] / n);
    }
  }
  return m;
}

function linearSubdivideInPlace(m: HalfedgeMesh): void {
  // minimal mid-point linear subdivision (avoids importing subdivision into this fixture loop)
  const edgeCount = m.edgesSize();
  for (let e = 0; e < edgeCount; e += 1) {
    if (m.isDeletedEdge(e)) continue;
    const a = m.position(m.edgeVertex(e, 0));
    const b = m.position(m.edgeVertex(e, 1));
    const v = m.addVertex((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    m.insertVertexOnEdge(e, v);
  }
  const faceCount = m.facesSize();
  for (let f = 0; f < faceCount; f += 1) {
    if (m.isDeletedFace(f)) continue;
    let h0 = m.halfedgeOfFace(f);
    let h1 = m.nextHalfedge(m.nextHalfedge(h0));
    m.insertEdge(h0, h1);
    h0 = m.nextHalfedge(h0);
    h1 = m.nextHalfedge(m.nextHalfedge(h0));
    m.insertEdge(h0, h1);
    h0 = m.nextHalfedge(h0);
    h1 = m.nextHalfedge(m.nextHalfedge(h0));
    m.insertEdge(h0, h1);
  }
}

function meanEdgeLength(m: HalfedgeMesh): number {
  let sum = 0;
  let n = 0;
  for (const e of m.edges()) {
    const a = m.position(m.edgeVertex(e, 0));
    const b = m.position(m.edgeVertex(e, 1));
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

function checkValid(m: HalfedgeMesh): void {
  expect(m.hasGarbage()).toBe(false);
  expect(m.isTriangleMesh()).toBe(true);
  for (const h of m.halfedges()) {
    expect(m.opposite(m.opposite(h))).toBe(h);
    expect(m.fromVertex(m.nextHalfedge(h))).toBe(m.toVertex(h));
  }
}

describe("uniform remeshing", () => {
  it("drives edge lengths toward the target and stays a valid triangle mesh", () => {
    const m = sphere(3);
    const target = 0.3;
    uniformRemeshing(m, { edgeLength: target, iterations: 10, useProjection: true });
    m.garbageCollection();
    checkValid(m);
    const mean = meanEdgeLength(m);
    // target band is [4/5, 4/3]·target = [0.24, 0.40]; mean should land near it
    expect(mean).toBeGreaterThan(0.2);
    expect(mean).toBeLessThan(0.45);
  });

  it("keeps vertices close to the original surface when projecting", () => {
    const ref = sphere(3);
    // snapshot reference triangles
    const tris: Triangle[] = [];
    for (const f of ref.faces()) {
      const [a, b, c] = [...ref.verticesAroundFace(f)];
      tris.push([
        [...ref.position(a)], [...ref.position(b)], [...ref.position(c)],
      ] as Triangle);
    }
    const tree = new TriangleKdTree(tris, 0);

    const m = sphere(3);
    uniformRemeshing(m, { edgeLength: 0.25, iterations: 8, useProjection: true });
    m.garbageCollection();

    let maxDist = 0;
    for (const v of m.vertices()) maxDist = Math.max(maxDist, tree.nearest(m.position(v)).dist);
    // projected vertices stay glued to the reference surface
    expect(maxDist).toBeLessThan(0.05);
  });

  it("runs without projection too", () => {
    const m = sphere(2);
    uniformRemeshing(m, { edgeLength: 0.4, iterations: 5, useProjection: false });
    m.garbageCollection();
    checkValid(m);
    for (const v of m.vertices()) {
      const p = m.position(v);
      expect(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])).toBe(true);
    }
  });
});

describe("adaptive remeshing", () => {
  it("respects min/max edge lengths and stays valid", () => {
    const m = sphere(3);
    adaptiveRemeshing(m, {
      minEdgeLength: 0.1,
      maxEdgeLength: 0.8,
      approxError: 0.02,
      iterations: 8,
      useProjection: true,
    });
    m.garbageCollection();
    checkValid(m);
    let count = 0;
    let inBand = 0;
    for (const e of m.edges()) {
      const a = m.position(m.edgeVertex(e, 0));
      const b = m.position(m.edgeVertex(e, 1));
      const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      count += 1;
      if (len >= 0.05 && len <= 1.2) inBand += 1;
    }
    // the overwhelming majority of edges land within the sizing band
    expect(inBand / count).toBeGreaterThan(0.9);
  });

  it("uses shorter edges on high-curvature regions (prolate spheroid)", () => {
    const m = sphere(3);
    for (const v of m.vertices()) {
      const p = m.position(v);
      m.setPosition(v, p[0], p[1], p[2] * 2.2); // sharp poles, flatter equator
    }
    adaptiveRemeshing(m, {
      minEdgeLength: 0.05,
      maxEdgeLength: 1.0,
      approxError: 0.02,
      iterations: 8,
      useProjection: true,
    });
    m.garbageCollection();
    checkValid(m);

    let poleSum = 0, poleN = 0, eqSum = 0, eqN = 0;
    for (const e of m.edges()) {
      const a = m.position(m.edgeVertex(e, 0));
      const b = m.position(m.edgeVertex(e, 1));
      const len = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const z = Math.abs((a[2] + b[2]) / 2);
      if (z > 1.8) { poleSum += len; poleN += 1; }
      else if (z < 0.4) { eqSum += len; eqN += 1; }
    }
    expect(poleN).toBeGreaterThan(0);
    expect(eqN).toBeGreaterThan(0);
    expect(poleSum / poleN).toBeLessThan(eqSum / eqN);
  });
});

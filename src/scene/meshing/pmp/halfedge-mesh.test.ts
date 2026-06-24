import { describe, it, expect } from "vitest";
import { HalfedgeMesh } from "./halfedge-mesh";

// --- fixtures ---

// Closed tetrahedron: 4 vertices, 6 edges, 4 triangles, no boundary.
function tetrahedron(): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const v0 = m.addVertex(0, 0, 0);
  const v1 = m.addVertex(1, 0, 0);
  const v2 = m.addVertex(0, 1, 0);
  const v3 = m.addVertex(0, 0, 1);
  m.addTriangle(v0, v1, v2);
  m.addTriangle(v0, v2, v3);
  m.addTriangle(v0, v3, v1);
  m.addTriangle(v1, v3, v2);
  return m;
}

// Two triangles sharing the diagonal 0-2 of a unit square. Edge 0-2 is interior.
function quadTwoTris(): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const v0 = m.addVertex(0, 0, 0);
  const v1 = m.addVertex(1, 0, 0);
  const v2 = m.addVertex(1, 1, 0);
  const v3 = m.addVertex(0, 1, 0);
  m.addTriangle(v0, v1, v2);
  m.addTriangle(v0, v2, v3);
  return m;
}

// n×n grid of quads, each split into two triangles. Has interior vertices/edges.
function grid(n: number): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const idx = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j <= n; j += 1)
    for (let i = 0; i <= n; i += 1) m.addVertex(i, j, 0);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const a = idx(i, j);
      const b = idx(i + 1, j);
      const c = idx(i + 1, j + 1);
      const d = idx(i, j + 1);
      m.addTriangle(a, b, c);
      m.addTriangle(a, c, d);
    }
  }
  return m;
}

// Asserts the halfedge data structure is internally consistent.
function checkIntegrity(m: HalfedgeMesh): void {
  for (const h of m.halfedges()) {
    expect(m.opposite(m.opposite(h))).toBe(h);
    expect(m.prevHalfedge(m.nextHalfedge(h))).toBe(h);
    expect(m.nextHalfedge(m.prevHalfedge(h))).toBe(h);
    // each halfedge's next emanates from its tip
    expect(m.fromVertex(m.nextHalfedge(h))).toBe(m.toVertex(h));
    // handle arithmetic round-trips
    expect(m.edgeHalfedge(m.edge(h), (h & 1) as 0 | 1)).toBe(h);
  }
  for (const f of m.faces()) {
    const start = m.halfedgeOfFace(f);
    let h = start;
    let steps = 0;
    do {
      expect(m.face(h)).toBe(f);
      h = m.nextHalfedge(h);
      steps += 1;
      expect(steps).toBeLessThanOrEqual(64);
    } while (h !== start);
    expect(steps).toBe(m.valenceFace(f));
  }
  for (const v of m.vertices()) {
    const h = m.halfedgeOfVertex(v);
    if (h < 0) continue;
    expect(m.fromVertex(h)).toBe(v);
    if (m.isBoundaryVertex(v)) expect(m.isBoundaryHalfedge(h)).toBe(true);
  }
}

// --- tests ---

describe("HalfedgeMesh construction", () => {
  it("builds a closed tetrahedron with correct counts", () => {
    const m = tetrahedron();
    expect(m.nVertices()).toBe(4);
    expect(m.nEdges()).toBe(6);
    expect(m.nFaces()).toBe(4);
    expect(m.nHalfedges()).toBe(12);
    expect(m.isTriangleMesh()).toBe(true);
    for (const v of m.vertices()) expect(m.isBoundaryVertex(v)).toBe(false);
    checkIntegrity(m);
  });

  it("builds an open single triangle with boundary", () => {
    const m = new HalfedgeMesh();
    const v0 = m.addVertex(0, 0, 0);
    const v1 = m.addVertex(1, 0, 0);
    const v2 = m.addVertex(0, 1, 0);
    m.addTriangle(v0, v1, v2);
    expect(m.nVertices()).toBe(3);
    expect(m.nEdges()).toBe(3);
    expect(m.nFaces()).toBe(1);
    expect(m.nHalfedges()).toBe(6);
    for (const v of m.vertices()) expect(m.isBoundaryVertex(v)).toBe(true);
    for (const e of m.edges()) expect(m.isBoundaryEdge(e)).toBe(true);
    checkIntegrity(m);
  });

  it("computes valence and one-ring neighbours", () => {
    const m = grid(2); // center vertex idx 4 has valence 6 in this triangulation
    const center = 4;
    expect(m.isBoundaryVertex(center)).toBe(false);
    expect(m.valenceVertex(center)).toBe(6);
    const neighbours = [...m.verticesAroundVertex(center)].sort((a, b) => a - b);
    expect(neighbours).toEqual([0, 1, 3, 5, 7, 8]);
    checkIntegrity(m);
  });
});

describe("HalfedgeMesh edge operations", () => {
  it("flips an interior edge", () => {
    const m = quadTwoTris();
    const e = m.findEdge(0, 2);
    expect(e).toBeGreaterThanOrEqual(0);
    expect(m.isFlipOk(e)).toBe(true);
    m.flip(e);
    expect(m.findEdge(0, 2)).toBe(-1); // diagonal gone
    expect(m.findEdge(1, 3)).toBeGreaterThanOrEqual(0); // new diagonal
    expect(m.nVertices()).toBe(4);
    expect(m.nFaces()).toBe(2);
    expect(m.nEdges()).toBe(5);
    checkIntegrity(m);
  });

  it("rejects flipping a boundary edge", () => {
    const m = quadTwoTris();
    const e = m.findEdge(0, 1); // boundary
    expect(m.isFlipOk(e)).toBe(false);
  });

  it("splits an interior edge (V+1, F+2, E+3)", () => {
    const m = quadTwoTris();
    const v0 = m.nVertices();
    const f0 = m.nFaces();
    const e0 = m.nEdges();
    const e = m.findEdge(0, 2);
    m.splitEdge(e, m.addVertex(0.5, 0.5, 0));
    expect(m.nVertices()).toBe(v0 + 1);
    expect(m.nFaces()).toBe(f0 + 2);
    expect(m.nEdges()).toBe(e0 + 3);
    expect(m.isTriangleMesh()).toBe(true);
    checkIntegrity(m);
  });

  it("splits a boundary edge (V+1, F+1, E+2)", () => {
    const m = quadTwoTris();
    const v0 = m.nVertices();
    const f0 = m.nFaces();
    const e0 = m.nEdges();
    const e = m.findEdge(0, 1); // boundary edge of face (0,1,2)
    m.splitEdge(e, m.addVertex(0.5, 0, 0));
    expect(m.nVertices()).toBe(v0 + 1);
    expect(m.nFaces()).toBe(f0 + 1);
    expect(m.nEdges()).toBe(e0 + 2);
    expect(m.isTriangleMesh()).toBe(true);
    checkIntegrity(m);
  });
});

describe("HalfedgeMesh face split", () => {
  it("splits a triangle into three (V+1, F+2, E+3)", () => {
    const m = new HalfedgeMesh();
    const v0 = m.addVertex(0, 0, 0);
    const v1 = m.addVertex(1, 0, 0);
    const v2 = m.addVertex(0, 1, 0);
    const f = m.addTriangle(v0, v1, v2);
    m.splitFaceAt(f, 0.25, 0.25, 0);
    expect(m.nVertices()).toBe(4);
    expect(m.nFaces()).toBe(3);
    expect(m.nEdges()).toBe(6);
    expect(m.isTriangleMesh()).toBe(true);
    checkIntegrity(m);
  });
});

describe("HalfedgeMesh collapse + garbage collection", () => {
  it("collapses an interior edge and garbage-collects cleanly", () => {
    const m = grid(3);
    // find an interior halfedge whose collapse is legal
    let target = -1;
    for (const h of m.halfedges()) {
      if (m.isCollapseOk(h)) {
        target = h;
        break;
      }
    }
    expect(target).toBeGreaterThanOrEqual(0);

    const vBefore = m.nVertices();
    m.collapse(target);
    expect(m.hasGarbage()).toBe(true);
    // a non-boundary edge collapse removes 1 vertex, 3 edges, 2 faces
    expect(m.nVertices()).toBe(vBefore - 1);

    m.garbageCollection();
    expect(m.hasGarbage()).toBe(false);
    // no deleted slots remain: sizes equal live counts
    expect(m.verticesSize()).toBe(m.nVertices());
    expect(m.edgesSize()).toBe(m.nEdges());
    expect(m.facesSize()).toBe(m.nFaces());
    expect(m.isTriangleMesh()).toBe(true);
    checkIntegrity(m);
  });

  it("preserves a valid triangulation after many collapses + gc", () => {
    const m = grid(5);
    let collapses = 0;
    for (const h of m.halfedges()) {
      if (m.nFaces() <= 4) break;
      if (!m.isDeletedEdge(m.edge(h)) && m.isCollapseOk(h)) {
        m.collapse(h);
        collapses += 1;
      }
    }
    expect(collapses).toBeGreaterThan(0);
    m.garbageCollection();
    expect(m.hasGarbage()).toBe(false);
    expect(m.isTriangleMesh()).toBe(true);
    expect(m.verticesSize()).toBe(m.nVertices());
    checkIntegrity(m);
  });
});

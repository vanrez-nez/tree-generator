import { describe, it, expect } from "vitest";
import { HalfedgeMesh, type Point } from "./halfedge-mesh";
import {
  linearSubdivision,
  loopSubdivision,
  catmullClarkSubdivision,
  quadTriSubdivision,
} from "./subdivision";

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

function singleTriangle(): HalfedgeMesh {
  const m = new HalfedgeMesh();
  m.addTriangle(m.addVertex(0, 0, 0), m.addVertex(1, 0, 0), m.addVertex(0, 1, 0));
  return m;
}

function noNaN(m: HalfedgeMesh): void {
  for (const v of m.vertices()) {
    const p = m.position(v);
    expect(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])).toBe(true);
  }
}

describe("linear subdivision", () => {
  it("quadruples triangle faces (V+E, 2E+3F, 4F)", () => {
    const m = tetrahedron();
    linearSubdivision(m);
    expect(m.nVertices()).toBe(10); // 4 + 6
    expect(m.nEdges()).toBe(24); // 2*6 + 3*4
    expect(m.nFaces()).toBe(16); // 4*4
    expect(m.isTriangleMesh()).toBe(true);
    noNaN(m);
  });
});

describe("loop subdivision", () => {
  it("matches linear connectivity on a triangle mesh", () => {
    const m = tetrahedron();
    loopSubdivision(m);
    expect(m.nVertices()).toBe(10);
    expect(m.nEdges()).toBe(24);
    expect(m.nFaces()).toBe(16);
    expect(m.isTriangleMesh()).toBe(true);
    noNaN(m);
  });

  it("rejects a non-triangle mesh", () => {
    const m = new HalfedgeMesh();
    m.addQuad(m.addVertex(0, 0, 0), m.addVertex(1, 0, 0), m.addVertex(1, 1, 0), m.addVertex(0, 1, 0));
    expect(() => loopSubdivision(m)).toThrow();
  });

  it("preserves boundary vertex positions in preserve mode", () => {
    const m = singleTriangle();
    const before: Point[] = [...m.vertices()].map((v) => [...m.position(v)] as Point);
    loopSubdivision(m, "preserve");
    // original 3 corners keep their indices and positions
    for (let v = 0; v < 3; v += 1) {
      expect(m.position(v)).toEqual(before[v]);
    }
    noNaN(m);
  });

  it("keeps feature edges marked after subdivision", () => {
    const m = tetrahedron();
    const efeature = m.edgeProperty<boolean>("e:feature", () => false);
    m.vertexProperty<boolean>("v:feature", () => false);
    const fe = m.findEdge(0, 1);
    efeature[fe] = true;

    loopSubdivision(m);
    // the split produced two feature child edges between v0/v1 and the new midpoint
    let featureEdges = 0;
    for (const e of m.edges()) if (efeature[e]) featureEdges += 1;
    expect(featureEdges).toBe(2);
  });
});

describe("catmull-clark subdivision", () => {
  it("turns each triangle into 3 quads", () => {
    const m = tetrahedron();
    catmullClarkSubdivision(m);
    expect(m.nVertices()).toBe(14); // V + E + F
    expect(m.nFaces()).toBe(12); // sum of face valences = 4*3
    expect(m.nEdges()).toBe(24);
    expect(m.isQuadMesh()).toBe(true);
    noNaN(m);
  });
});

describe("quad-tri subdivision", () => {
  it("keeps an all-triangle mesh triangular with linear connectivity", () => {
    const m = tetrahedron();
    quadTriSubdivision(m);
    expect(m.nVertices()).toBe(10);
    expect(m.nFaces()).toBe(16);
    expect(m.isTriangleMesh()).toBe(true);
    noNaN(m);
  });
});

import { describe, it, expect } from "vitest";
import { HalfedgeMesh, type Point } from "./halfedge-mesh";
import {
  triangleArea,
  faceArea,
  surfaceArea,
  centroid,
  triangleAspectRatio,
  boundingBox,
  barycentricCoordinates,
  distPointTriangle,
} from "./geometry";
import { faceNormal, vertexNormal } from "./normals";
import { cotanWeight, voronoiArea } from "./laplace";

// Unit square (0,0)-(1,1) split into two triangles along the 0-2 diagonal.
function quad(): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const v0 = m.addVertex(0, 0, 0);
  const v1 = m.addVertex(1, 0, 0);
  const v2 = m.addVertex(1, 1, 0);
  const v3 = m.addVertex(0, 1, 0);
  m.addTriangle(v0, v1, v2);
  m.addTriangle(v0, v2, v3);
  return m;
}

describe("areas and centroid", () => {
  it("triangle and face area agree", () => {
    expect(triangleArea([0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(0.5);
    const m = quad();
    for (const f of m.faces()) expect(faceArea(m, f)).toBeCloseTo(0.5);
    expect(surfaceArea(m)).toBeCloseTo(1);
  });

  it("centroid of the unit square is its middle", () => {
    const c = centroid(quad());
    expect(c[0]).toBeCloseTo(0.5);
    expect(c[1]).toBeCloseTo(0.5);
    expect(c[2]).toBeCloseTo(0);
  });

  it("bounding box spans the square", () => {
    const { min, max } = boundingBox(quad());
    expect(min).toEqual([0, 0, 0]);
    expect(max).toEqual([1, 1, 0]);
  });

  it("aspect ratio of a right isoceles triangle", () => {
    const m = new HalfedgeMesh();
    const f = m.addTriangle(m.addVertex(0, 0, 0), m.addVertex(1, 0, 0), m.addVertex(0, 1, 0));
    // max sq edge = 2 (hypotenuse), 2*area = 1 → ratio 2
    expect(triangleAspectRatio(m, f)).toBeCloseTo(2);
  });
});

describe("normals", () => {
  it("planar faces share a unit normal along ±z", () => {
    const m = quad();
    const normals = [...m.faces()].map((f) => faceNormal(m, f));
    for (const n of normals) {
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1);
      expect(Math.abs(n[2])).toBeCloseTo(1);
    }
    // consistent winding ⇒ same orientation
    expect(Math.sign(normals[0][2])).toBe(Math.sign(normals[1][2]));
  });

  it("vertex normal of a flat patch is the face normal", () => {
    const m = quad();
    const n = vertexNormal(m, 0);
    expect(Math.abs(n[2])).toBeCloseTo(1);
  });
});

describe("cotan weights", () => {
  it("interior diagonal has zero weight (right angles opposite)", () => {
    const m = quad();
    const e = m.findEdge(0, 2);
    expect(cotanWeight(m, e)).toBeCloseTo(0);
  });

  it("boundary edge weight is cot(45°) = 1", () => {
    const m = quad();
    const e = m.findEdge(0, 1);
    expect(cotanWeight(m, e)).toBeCloseTo(1);
  });

  it("voronoi area sums incident face thirds", () => {
    const m = quad();
    expect(voronoiArea(m, 0)).toBeCloseTo(1 / 3);
  });
});

describe("barycentric + point-triangle distance", () => {
  const a: Point = [0, 0, 0];
  const b: Point = [1, 0, 0];
  const c: Point = [0, 1, 0];

  it("barycentric of a corner and the centroid", () => {
    expect(barycentricCoordinates([0, 0, 0], a, b, c)).toEqual([1, 0, 0]);
    const g = barycentricCoordinates([1 / 3, 1 / 3, 0], a, b, c);
    expect(g[0]).toBeCloseTo(1 / 3);
    expect(g[1]).toBeCloseTo(1 / 3);
    expect(g[2]).toBeCloseTo(1 / 3);
  });

  it("distance for an interior point above the plane", () => {
    const r = distPointTriangle([0.25, 0.25, 2], a, b, c);
    expect(r.distance).toBeCloseTo(2);
    expect(r.nearest[2]).toBeCloseTo(0);
  });

  it("distance for a point past a corner clamps to that vertex", () => {
    const r = distPointTriangle([-1, -1, 0], a, b, c);
    expect(r.nearest).toEqual([0, 0, 0]);
    expect(r.distance).toBeCloseTo(Math.SQRT2);
  });
});

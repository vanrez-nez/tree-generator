import { describe, it, expect } from "vitest";
import { HalfedgeMesh, type Point } from "./halfedge-mesh";
import { explicitSmoothing, implicitSmoothing } from "./smoothing";
import { linearSubdivision } from "./subdivision";
import { centroid, surfaceArea } from "./geometry";

// n×n triangulated grid in the z=0 plane.
function grid(n: number): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const idx = (i: number, j: number) => j * (n + 1) + i;
  for (let j = 0; j <= n; j += 1)
    for (let i = 0; i <= n; i += 1) m.addVertex(i, j, 0);
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      m.addTriangle(idx(i, j), idx(i + 1, j), idx(i + 1, j + 1));
      m.addTriangle(idx(i, j), idx(i + 1, j + 1), idx(i, j + 1));
    }
  }
  return m;
}

describe("explicit smoothing", () => {
  it("freezes boundary vertices", () => {
    const m = grid(4);
    const before: Map<number, Point> = new Map();
    for (const v of m.vertices())
      if (m.isBoundaryVertex(v)) before.set(v, [...m.position(v)] as Point);

    explicitSmoothing(m, { iterations: 5, laplace: "uniform" });

    for (const [v, p] of before) expect(m.position(v)).toEqual(p);
  });

  it("produces no NaN/inf coordinates (cotan)", () => {
    const m = grid(4);
    // perturb interior vertices
    for (const v of m.vertices())
      if (!m.isBoundaryVertex(v)) {
        const p = m.position(v);
        m.setPosition(v, p[0], p[1], Math.sin(p[0]) * 0.7);
      }
    explicitSmoothing(m, { iterations: 10, laplace: "cotan" });
    for (const v of m.vertices()) {
      const p = m.position(v);
      expect(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])).toBe(true);
    }
  });

  it("reduces a high-frequency bump on an interior vertex", () => {
    const m = grid(4);
    const center = 12; // interior vertex of a 5×5 grid (index (2,2))
    expect(m.isBoundaryVertex(center)).toBe(false);
    m.setPosition(center, 2, 2, 1); // z = 1 bump
    const before = Math.abs(m.position(center)[2]);

    explicitSmoothing(m, { iterations: 1, laplace: "uniform" });
    const after = Math.abs(m.position(center)[2]);
    expect(after).toBeLessThan(before);
  });
});

// Closed sphere: octahedron, linearly subdivided, every vertex re-projected to the unit sphere.
function sphere(subdiv: number): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const v = [
    m.addVertex(1, 0, 0), m.addVertex(-1, 0, 0),
    m.addVertex(0, 1, 0), m.addVertex(0, -1, 0),
    m.addVertex(0, 0, 1), m.addVertex(0, 0, -1),
  ];
  m.addTriangle(v[0], v[2], v[4]);
  m.addTriangle(v[2], v[1], v[4]);
  m.addTriangle(v[1], v[3], v[4]);
  m.addTriangle(v[3], v[0], v[4]);
  m.addTriangle(v[2], v[0], v[5]);
  m.addTriangle(v[1], v[2], v[5]);
  m.addTriangle(v[3], v[1], v[5]);
  m.addTriangle(v[0], v[3], v[5]);
  for (let i = 0; i < subdiv; i += 1) {
    linearSubdivision(m);
    for (const w of m.vertices()) {
      const p = m.position(w);
      const len = Math.hypot(p[0], p[1], p[2]) || 1;
      m.setPosition(w, p[0] / len, p[1] / len, p[2] / len);
    }
  }
  return m;
}

describe("implicit smoothing", () => {
  it("freezes boundary vertices", () => {
    const m = grid(4);
    for (const v of m.vertices())
      if (!m.isBoundaryVertex(v)) {
        const p = m.position(v);
        m.setPosition(v, p[0], p[1], Math.sin(p[0] * 2) * 0.5);
      }
    const before: Map<number, Point> = new Map();
    for (const v of m.vertices())
      if (m.isBoundaryVertex(v)) before.set(v, [...m.position(v)] as Point);

    implicitSmoothing(m, { timestep: 0.01, iterations: 2, laplace: "cotan", rescale: false });

    for (const [v, p] of before) {
      const q = m.position(v);
      expect(q[0]).toBeCloseTo(p[0]);
      expect(q[1]).toBeCloseTo(p[1]);
      expect(q[2]).toBeCloseTo(p[2]);
    }
  });

  it("produces no NaN/inf and reduces noise", () => {
    const m = grid(5);
    let bumpBefore = 0;
    for (const v of m.vertices())
      if (!m.isBoundaryVertex(v)) {
        const p = m.position(v);
        const z = Math.sin(p[0] * 3) * Math.cos(p[1] * 3) * 0.4;
        m.setPosition(v, p[0], p[1], z);
        bumpBefore += Math.abs(z);
      }
    implicitSmoothing(m, { timestep: 0.05, iterations: 3, laplace: "uniform", rescale: false });
    let bumpAfter = 0;
    for (const v of m.vertices()) {
      const p = m.position(v);
      expect(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])).toBe(true);
      if (!m.isBoundaryVertex(v)) bumpAfter += Math.abs(p[2]);
    }
    expect(bumpAfter).toBeLessThan(bumpBefore);
  });

  it("restores center and surface area when rescale is enabled", () => {
    const m = sphere(3);
    // add noise
    let seed = 1;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed / 0x7fffffff) * 2 - 1;
    };
    for (const v of m.vertices()) {
      const p = m.position(v);
      m.setPosition(v, p[0] + rand() * 0.05, p[1] + rand() * 0.05, p[2] + rand() * 0.05);
    }
    const areaBefore = surfaceArea(m);
    const centerBefore = centroid(m);

    implicitSmoothing(m, { timestep: 0.01, iterations: 3, laplace: "cotan", rescale: true });

    const areaAfter = surfaceArea(m);
    const centerAfter = centroid(m);
    expect(areaAfter).toBeCloseTo(areaBefore, 1); // area preserved
    expect(centerAfter[0]).toBeCloseTo(centerBefore[0], 3);
    expect(centerAfter[1]).toBeCloseTo(centerBefore[1], 3);
    expect(centerAfter[2]).toBeCloseTo(centerBefore[2], 3);
  });
});

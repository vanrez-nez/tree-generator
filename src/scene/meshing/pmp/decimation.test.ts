import { describe, it, expect } from "vitest";
import { HalfedgeMesh } from "./halfedge-mesh";
import { linearSubdivision } from "./subdivision";
import { decimate } from "./decimation";

// Octahedron (closed) → linear-subdivided into a denser closed triangle "sphere".
function sphere(subdiv: number): HalfedgeMesh {
  const m = new HalfedgeMesh();
  const v0 = m.addVertex(1, 0, 0);
  const v1 = m.addVertex(-1, 0, 0);
  const v2 = m.addVertex(0, 1, 0);
  const v3 = m.addVertex(0, -1, 0);
  const v4 = m.addVertex(0, 0, 1);
  const v5 = m.addVertex(0, 0, -1);
  m.addTriangle(v0, v2, v4);
  m.addTriangle(v2, v1, v4);
  m.addTriangle(v1, v3, v4);
  m.addTriangle(v3, v0, v4);
  m.addTriangle(v2, v0, v5);
  m.addTriangle(v1, v2, v5);
  m.addTriangle(v3, v1, v5);
  m.addTriangle(v0, v3, v5);
  for (let i = 0; i < subdiv; i += 1) linearSubdivision(m);
  return m;
}

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

function checkIntegrity(m: HalfedgeMesh): void {
  expect(m.hasGarbage()).toBe(false);
  expect(m.isTriangleMesh()).toBe(true);
  for (const h of m.halfedges()) {
    expect(m.opposite(m.opposite(h))).toBe(h);
    expect(m.fromVertex(m.nextHalfedge(h))).toBe(m.toVertex(h));
  }
  for (const v of m.vertices()) {
    const h = m.halfedgeOfVertex(v);
    if (h >= 0) expect(m.fromVertex(h)).toBe(v);
  }
}

describe("decimation", () => {
  it("reaches the target vertex count on a closed sphere", () => {
    const m = sphere(2);
    const before = m.nVertices();
    expect(before).toBeGreaterThan(60);
    decimate(m, { targetVertices: 30 });
    expect(m.nVertices()).toBeLessThanOrEqual(30);
    expect(m.nVertices()).toBeGreaterThan(3);
    // still a closed manifold sphere
    for (const v of m.vertices()) expect(m.isBoundaryVertex(v)).toBe(false);
    checkIntegrity(m);
  });

  it("keeps boundary vertices on the original perimeter (open grid)", () => {
    const n = 6;
    const m = grid(n);
    decimate(m, { targetVertices: 12 });
    checkIntegrity(m);
    for (const v of m.vertices()) {
      if (!m.isBoundaryVertex(v)) continue;
      const [x, y] = m.position(v);
      const onPerimeter =
        Math.abs(x) < 1e-6 || Math.abs(x - n) < 1e-6 || Math.abs(y) < 1e-6 || Math.abs(y - n) < 1e-6;
      expect(onPerimeter).toBe(true);
    }
  });

  it("the normal-deviation constraint limits how far it collapses", () => {
    const free = sphere(2);
    decimate(free, { targetVertices: 10 });

    const constrained = sphere(2);
    decimate(constrained, { targetVertices: 10, normalDeviation: 5 });

    // a tight normal cone should block collapses, leaving more vertices
    expect(constrained.nVertices()).toBeGreaterThanOrEqual(free.nVertices());
    checkIntegrity(constrained);
  });

  it("refuses to collapse when every edge is a texture seam", () => {
    const m = sphere(1);
    const tc = m.halfedgeProperty<[number, number]>("h:tex", () => [0, 0]);
    // distinct uv per halfedge ⇒ every edge is detected as a seam ⇒ no legal collapse
    for (const h of m.halfedges()) tc[h] = [h, 0];
    const before = m.nVertices();
    decimate(m, { targetVertices: 4 });
    expect(m.nVertices()).toBe(before);
  });
});

import { describe, it, expect } from "vitest";
import { HalfedgeMesh } from "./halfedge-mesh";
import { linearSubdivision } from "./subdivision";
import { maxAbsCurvatures } from "./curvature";

function sphere(subdiv: number, radius = 1): HalfedgeMesh {
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
      m.setPosition(w, (p[0] / len) * radius, (p[1] / len) * radius, (p[2] / len) * radius);
    }
  }
  return m;
}

describe("curvature", () => {
  it("recovers ~1/R on a sphere", () => {
    for (const R of [1, 2]) {
      const m = sphere(3, R);
      const curv = maxAbsCurvatures(m);
      let sum = 0;
      let n = 0;
      for (const v of m.vertices()) {
        sum += curv[v];
        n += 1;
      }
      const mean = sum / n;
      // principal curvature of a sphere is 1/R
      expect(mean).toBeGreaterThan(0.7 / R);
      expect(mean).toBeLessThan(1.4 / R);
    }
  });

  it("is higher on the pointy poles of a prolate spheroid", () => {
    const m = sphere(3);
    for (const v of m.vertices()) {
      const p = m.position(v);
      m.setPosition(v, p[0], p[1], p[2] * 2.2); // stretch along z → sharp poles
    }
    const curv = maxAbsCurvatures(m);
    let poleSum = 0, poleN = 0, eqSum = 0, eqN = 0;
    for (const v of m.vertices()) {
      const z = Math.abs(m.position(v)[2]);
      if (z > 1.8) { poleSum += curv[v]; poleN += 1; }
      else if (z < 0.4) { eqSum += curv[v]; eqN += 1; }
    }
    expect(poleN).toBeGreaterThan(0);
    expect(eqN).toBeGreaterThan(0);
    expect(poleSum / poleN).toBeGreaterThan(eqSum / eqN);
  });
});

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { fromBufferGeometry, toBufferGeometry } from "./geometry-adapter";
import { loopSubdivision } from "./subdivision";

describe("BufferGeometry adapters", () => {
  it("welds a BoxGeometry into a closed manifold cube", () => {
    const box = new THREE.BoxGeometry(1, 1, 1); // 24 dup verts, 12 triangles
    const mesh = fromBufferGeometry(box);
    expect(mesh.nVertices()).toBe(8);
    expect(mesh.nFaces()).toBe(12);
    expect(mesh.nEdges()).toBe(18); // Euler: 8 - 18 + 12 = 2
    expect(mesh.isTriangleMesh()).toBe(true);
    for (const v of mesh.vertices()) expect(mesh.isBoundaryVertex(v)).toBe(false);
  });

  it("round-trips back to a BufferGeometry", () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const out = toBufferGeometry(fromBufferGeometry(box));
    const pos = out.getAttribute("position");
    const idx = out.getIndex();
    expect(pos.count).toBe(8);
    expect(idx?.count).toBe(12 * 3);
    expect(out.getAttribute("normal")).toBeTruthy();
  });

  it("supports a full Three → PMP → subdivide → Three pipeline", () => {
    const mesh = fromBufferGeometry(new THREE.BoxGeometry(1, 1, 1));
    loopSubdivision(mesh);
    const out = toBufferGeometry(mesh);
    const idx = out.getIndex();
    expect(idx?.count).toBe(12 * 4 * 3); // each triangle → 4
    const pos = out.getAttribute("position");
    for (let i = 0; i < pos.count; i += 1) {
      expect(Number.isFinite(pos.getX(i))).toBe(true);
      expect(Number.isFinite(pos.getY(i))).toBe(true);
      expect(Number.isFinite(pos.getZ(i))).toBe(true);
    }
  });

  it("supports non-indexed geometry by welding", () => {
    // A single triangle as non-indexed (9 floats, no index).
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    const mesh = fromBufferGeometry(g);
    expect(mesh.nVertices()).toBe(3);
    expect(mesh.nFaces()).toBe(1);
  });
});

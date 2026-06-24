// Three.js import/export boundary for the PMP halfedge mesh. Topology-changing algorithms run on
// HalfedgeMesh; BufferGeometry is only converted in and out here.

import * as THREE from "three";
import { HalfedgeMesh, TopologyError, type VertexId } from "./halfedge-mesh";

const WELD_EPSILON = 1e-5;

export class NonManifoldError extends Error {}

// Build a HalfedgeMesh from a BufferGeometry. Coincident positions are welded so that indexed,
// non-indexed, and duplicated-vertex geometries all recover shared topology. Throws
// NonManifoldError if the welded connectivity is not 2-manifold.
export function fromBufferGeometry(geometry: THREE.BufferGeometry): HalfedgeMesh {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
  if (!pos) throw new Error("fromBufferGeometry: geometry has no position attribute");
  const index = geometry.getIndex();

  const mesh = new HalfedgeMesh();
  const weld = new Map<string, VertexId>();

  const q = (x: number) => Math.round(x / WELD_EPSILON);
  const vertexOf = (i: number): VertexId => {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = `${q(x)},${q(y)},${q(z)}`;
    const existing = weld.get(key);
    if (existing !== undefined) return existing;
    const v = mesh.addVertex(x, y, z);
    weld.set(key, v);
    return v;
  };

  const triCount = index ? index.count : pos.count;
  for (let t = 0; t + 2 < triCount; t += 3) {
    const i0 = index ? index.getX(t) : t;
    const i1 = index ? index.getX(t + 1) : t + 1;
    const i2 = index ? index.getX(t + 2) : t + 2;
    const a = vertexOf(i0);
    const b = vertexOf(i1);
    const c = vertexOf(i2);
    if (a === b || b === c || a === c) continue; // skip degenerate triangle
    try {
      mesh.addTriangle(a, b, c);
    } catch (err) {
      if (err instanceof TopologyError) {
        throw new NonManifoldError(`fromBufferGeometry: non-manifold at triangle ${t / 3}: ${err.message}`);
      }
      throw err;
    }
  }

  return mesh;
}

// Export a HalfedgeMesh to an indexed BufferGeometry. Compacts deleted elements first, fan-
// triangulates any non-triangle faces, and recomputes vertex normals.
export function toBufferGeometry(mesh: HalfedgeMesh): THREE.BufferGeometry {
  mesh.garbageCollection();

  const nv = mesh.verticesSize();
  const positions = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v += 1) {
    const p = mesh.position(v);
    positions[v * 3] = p[0];
    positions[v * 3 + 1] = p[1];
    positions[v * 3 + 2] = p[2];
  }

  const indices: number[] = [];
  for (const f of mesh.faces()) {
    const verts = [...mesh.verticesAroundFace(f)];
    for (let j = 1; j + 1 < verts.length; j += 1) {
      indices.push(verts[0], verts[j], verts[j + 1]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

import { BufferGeometry, Float32BufferAttribute } from "three";
import type { WeldMesh } from "./weld-mesh";

// Convert the welded mesh into a THREE.BufferGeometry.
//
// The geometry is NON-INDEXED on purpose: welded vertices are shared by faces that legitimately
// disagree on UV (the trunk wrap seam, and the junction skirts), so an indexed buffer can only keep
// one UV per vertex and the rest are lost. Emitting per-corner UVs preserves the mesher's per-loop
// UVs (`uvLoops`) verbatim.
//
// Smooth shading is kept by computing smooth per-vertex normals on a temporary INDEXED geometry
// (shared vertices → averaged normals) and copying them per corner — non-indexed
// `computeVertexNormals` would give flat/faceted normals.
//
// The mesher's ring winding is clockwise w.r.t. the growth direction, so each quad is triangulated
// reversed ([a,b,c,d] -> [a,c,b] + [a,d,c]) to make face normals point outward. Cap apex quads have
// c === d (the fan), so their second triangle is degenerate and dropped.
export function weldMeshToBufferGeometry(mesh: WeldMesh): BufferGeometry {
  // 1. Smooth per-vertex normals from the welded (shared-vertex) topology.
  const vertexCount = mesh.vertices.length;
  const sharedPositions = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    const v = mesh.vertices[i];
    sharedPositions[i * 3] = v.x;
    sharedPositions[i * 3 + 1] = v.y;
    sharedPositions[i * 3 + 2] = v.z;
  }
  const indexed = new BufferGeometry();
  indexed.setAttribute("position", new Float32BufferAttribute(sharedPositions, 3));
  const indices: number[] = [];
  for (const [a, b, c, d] of mesh.polygons) {
    indices.push(a, c, b, a, d, c);
  }
  indexed.setIndex(indices);
  indexed.computeVertexNormals();
  const smoothNormals = indexed.getAttribute("normal").array as Float32Array;

  // 2. Expand to non-indexed, preserving per-loop UVs and copying the smooth normals per corner.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];

  const pushCorner = (vertexIndex: number, uvIndex: number): void => {
    const v = mesh.vertices[vertexIndex];
    positions.push(v.x, v.y, v.z);
    normals.push(
      smoothNormals[vertexIndex * 3],
      smoothNormals[vertexIndex * 3 + 1],
      smoothNormals[vertexIndex * 3 + 2],
    );
    const uv = mesh.uvs[uvIndex];
    uvs.push(uv ? uv.x : 0, uv ? uv.y : 0);
  };

  const pushTri = (
    v0: number,
    v1: number,
    v2: number,
    u0: number,
    u1: number,
    u2: number,
  ): void => {
    if (v0 === v1 || v1 === v2 || v0 === v2) return; // skip degenerate triangles
    pushCorner(v0, u0);
    pushCorner(v1, u1);
    pushCorner(v2, u2);
  };

  for (let p = 0; p < mesh.polygons.length; p++) {
    const [a, b, c, d] = mesh.polygons[p];
    const l = mesh.uvLoops[p];
    pushTri(a, c, b, l[0], l[2], l[1]);
    if (c !== d) {
      pushTri(a, d, c, l[0], l[3], l[2]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

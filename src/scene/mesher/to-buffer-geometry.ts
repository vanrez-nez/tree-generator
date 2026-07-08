import { BufferGeometry, Float32BufferAttribute, Vector3 } from "three";
import type { WeldMesh } from "./weld-mesh";
import { computeVertexCavityAo } from "./vertex-ao";

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
// Explicit per-corner TANGENTS are supplied so normal mapping doesn't fall back to screen-space UV
// derivatives, which break (a visible seam) where `u` jumps 1→0 at the cylinder wrap. Tangents are
// computed per triangle from its own per-corner UVs (so the seam's two sides agree) and
// orthonormalized against the smooth normal.
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

  // Baked per-vertex cavity AO over the same welded topology (form occlusion at the fork crotches /
  // junctions). Material-independent; expanded per-corner below and multiplied into the surface AO.
  const vertexAo = computeVertexCavityAo(mesh, sharedPositions, smoothNormals);

  // 2. Expand to non-indexed, preserving per-loop UVs and copying the smooth normals per corner.
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const uvs2: number[] = [];
  const blends: number[] = [];
  const tangents: number[] = [];
  const tangents2: number[] = [];
  const ao: number[] = [];

  // Scratch vectors (reused) for the per-triangle tangent bases.
  const p0 = new Vector3();
  const p1 = new Vector3();
  const p2 = new Vector3();
  const e1 = new Vector3();
  const e2 = new Vector3();
  const triT = new Vector3();
  const triB = new Vector3();
  const triT2 = new Vector3();
  const triB2 = new Vector3();
  const n = new Vector3();
  const t = new Vector3();
  const tmp = new Vector3();

  const normalOf = (vi: number, out: Vector3): Vector3 =>
    out.set(smoothNormals[vi * 3], smoothNormals[vi * 3 + 1], smoothNormals[vi * 3 + 2]);

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
    const uv2 = mesh.uvs2[uvIndex];
    uvs2.push(uv2 ? uv2.x : 0, uv2 ? uv2.y : 0);
    blends.push(mesh.blend[uvIndex] ?? 0);
    ao.push(vertexAo[vertexIndex]);
  };

  const pushCornerTangent = (vi: number, srcT: Vector3, srcB: Vector3, out: number[]): void => {
    normalOf(vi, n);
    // Gram-Schmidt: project the triangle tangent onto the plane of this corner's normal.
    t.copy(srcT).addScaledVector(n, -n.dot(srcT));
    if (t.lengthSq() < 1e-12) {
      // Tangent parallel to the normal (degenerate UVs) — pick any perpendicular.
      t.set(1, 0, 0).addScaledVector(n, -n.x);
      if (t.lengthSq() < 1e-12) t.set(0, 1, 0).addScaledVector(n, -n.y);
    }
    t.normalize();
    // Handedness for the bitangent reconstruction (bitangent = cross(n, t) * w).
    const w = tmp.copy(n).cross(t).dot(srcB) < 0 ? -1 : 1;
    out.push(t.x, t.y, t.z, w);
  };

  // Tangent basis of the current triangle (e1/e2 edges) in the given uv set → (outT, outB).
  const triBasis = (
    uvSet: typeof mesh.uvs,
    u0: number,
    u1: number,
    u2: number,
    outT: Vector3,
    outB: Vector3,
  ): void => {
    const uv0 = uvSet[u0];
    const uv1 = uvSet[u1];
    const uv2 = uvSet[u2];
    const du1 = uv1.x - uv0.x;
    const dv1 = uv1.y - uv0.y;
    const du2 = uv2.x - uv0.x;
    const dv2 = uv2.y - uv0.y;
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) > 1e-12) {
      const f = 1 / det;
      outT.copy(e1).multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(f);
      outB.copy(e2).multiplyScalar(du1).addScaledVector(e1, -du2).multiplyScalar(f);
    } else {
      outT.copy(e1); // degenerate UVs — approximate
      outB.copy(e2);
    }
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

    // Per-triangle tangent bases from positions + this triangle's own UVs — one per chart, so the
    // skirt's cross-fade can rotate the normal-map frame along with its second UV set.
    p0.copy(mesh.vertices[v0]);
    p1.copy(mesh.vertices[v1]);
    p2.copy(mesh.vertices[v2]);
    e1.subVectors(p1, p0);
    e2.subVectors(p2, p0);
    triBasis(mesh.uvs, u0, u1, u2, triT, triB);
    triBasis(mesh.uvs2, u0, u1, u2, triT2, triB2);

    pushCorner(v0, u0);
    pushCornerTangent(v0, triT, triB, tangents);
    pushCornerTangent(v0, triT2, triB2, tangents2);
    pushCorner(v1, u1);
    pushCornerTangent(v1, triT, triB, tangents);
    pushCornerTangent(v1, triT2, triB2, tangents2);
    pushCorner(v2, u2);
    pushCornerTangent(v2, triT, triB, tangents);
    pushCornerTangent(v2, triT2, triB2, tangents2);
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
  geometry.setAttribute("tangent", new Float32BufferAttribute(tangents, 4));
  const uvAttribute = new Float32BufferAttribute(uvs, 2);
  geometry.setAttribute("uv", uvAttribute);
  // MeshStandardMaterial.aoMap samples the SECOND UV set (`uv1` in r184). We have one UV layout, so
  // duplicate it — the AO map shares the bark UVs.
  geometry.setAttribute("uv1", uvAttribute.clone());
  // Junction cross-fade inputs (see weld-mesh.ts): the OTHER chart's uv + its tangent frame, and
  // the fade weight. Identical to uv/tangent (weight 0) everywhere except the junction skirts.
  geometry.setAttribute("uvParent", new Float32BufferAttribute(uvs2, 2));
  geometry.setAttribute("uvBlend", new Float32BufferAttribute(blends, 1));
  geometry.setAttribute("tangentParent", new Float32BufferAttribute(tangents2, 4));
  // Baked form AO, consumed by the surface material's aoNode (multiplied into any node-graph AO).
  geometry.setAttribute("vertexAo", new Float32BufferAttribute(ao, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

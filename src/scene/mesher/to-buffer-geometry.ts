import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from "three";
import type { WeldMesh } from "./weld-mesh";

// Convert the welded mesh into a THREE.BufferGeometry.
//
// Indexed geometry: positions = mesh.vertices, index = each quad triangulated. The mesher's ring
// winding is clockwise w.r.t. the growth direction, so each triangle is reversed
// ([a,b,c,d] -> [a,c,b] + [a,d,c]) to make face normals point outward.
//
// Leaf tips are closed by the mesher (see addCap): each terminal ring is fanned to an apex with a
// per-group cap profile, so ends are watertight rather than open holes.
//
// UVs are assigned per-vertex from the loop UVs (last write wins) — approximate at the seam but
// fine for bark. `radius` is exposed as an extra `aRadius` attribute.
export function weldMeshToBufferGeometry(mesh: WeldMesh): BufferGeometry {
  const geometry = new BufferGeometry();

  const positions = new Float32Array(mesh.vertices.length * 3);
  for (let i = 0; i < mesh.vertices.length; i++) {
    const v = mesh.vertices[i];
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }
  geometry.setAttribute("position", new BufferAttribute(positions, 3));

  // Triangulate quads with reversed winding (outward normals).
  const indices: number[] = [];
  for (const [a, b, c, d] of mesh.polygons) {
    indices.push(a, c, b, a, d, c);
  }
  geometry.setIndex(indices);

  // Per-vertex UVs from loop UVs (last write wins).
  const uvArray = new Float32Array(mesh.vertices.length * 2);
  for (let p = 0; p < mesh.polygons.length; p++) {
    const verts = mesh.polygons[p];
    const loops = mesh.uvLoops[p];
    for (let k = 0; k < 4; k++) {
      const vi = verts[k];
      const uv = mesh.uvs[loops[k]];
      if (uv) {
        uvArray[vi * 2] = uv.x;
        uvArray[vi * 2 + 1] = uv.y;
      }
    }
  }
  geometry.setAttribute("uv", new BufferAttribute(uvArray, 2));

  geometry.setAttribute(
    "aRadius",
    new Float32BufferAttribute(mesh.radius.slice(), 1),
  );

  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

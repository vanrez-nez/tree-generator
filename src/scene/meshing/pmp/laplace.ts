// Laplacian weights ported from pmp::algorithms/differential_geometry.cpp.
// cotanWeight + voronoiArea drive cotan smoothing; uniform weights are 1 per neighbour.

import type { HalfedgeMesh, EdgeId, VertexId } from "./halfedge-mesh";
import { sub, cross, dot, norm, sqrnorm, faceArea } from "./geometry";

// Clamp cotangent as if angles are in [3°, 177°].
export function clampCot(v: number): number {
  const bound = 19.1;
  return v < -bound ? -bound : v > bound ? bound : v;
}

// Sum of the cotangents of the two angles opposite edge e (one per incident triangle).
export function cotanWeight(mesh: HalfedgeMesh, e: EdgeId): number {
  let weight = 0;
  const h0 = mesh.edgeHalfedge(e, 0);
  const h1 = mesh.edgeHalfedge(e, 1);
  const p0 = mesh.position(mesh.toVertex(h0));
  const p1 = mesh.position(mesh.toVertex(h1));

  if (!mesh.isBoundaryHalfedge(h0)) {
    const p2 = mesh.position(mesh.toVertex(mesh.nextHalfedge(h0)));
    const d0 = sub(p0, p2);
    const d1 = sub(p1, p2);
    const area = norm(cross(d0, d1));
    if (area > 1e-20) weight += dot(d0, d1) / area;
  }
  if (!mesh.isBoundaryHalfedge(h1)) {
    const p2 = mesh.position(mesh.toVertex(mesh.nextHalfedge(h1)));
    const d0 = sub(p0, p2);
    const d1 = sub(p1, p2);
    const area = norm(cross(d0, d1));
    if (area > 1e-20) weight += dot(d0, d1) / area;
  }
  return weight;
}

// Barycentric Voronoi area of v: each incident face contributes area/valence.
export function voronoiArea(mesh: HalfedgeMesh, v: VertexId): number {
  let a = 0;
  for (const f of mesh.facesAroundVertex(v)) a += faceArea(mesh, f) / mesh.valenceFace(f);
  return a;
}

// Mixed Voronoi area of v (Meyer et al. 2003) — the lumped mass used by the cotan Laplacian.
// Triangle meshes only. Ported from pmp differential_geometry.cpp::voronoi_area_mixed.
export function voronoiAreaMixed(mesh: HalfedgeMesh, v: VertexId): number {
  let area = 0;
  if (mesh.isIsolated(v)) return 0;

  for (const h0 of mesh.halfedgesAroundVertex(v)) {
    if (mesh.isBoundaryHalfedge(h0)) continue;
    const h1 = mesh.nextHalfedge(h0);
    const p = mesh.position(mesh.toVertex(mesh.nextHalfedge(h1))); // = v
    const q = mesh.position(mesh.toVertex(h0));
    const r = mesh.position(mesh.toVertex(h1));

    const pq = sub(q, p);
    const qr = sub(r, q);
    const pr = sub(r, p);

    const triArea = norm(cross(pq, pr)); // = 2 × triangle area
    if (triArea <= 1e-20) continue;

    const dotp = dot(pq, pr);
    const dotq = -dot(qr, pq);
    const dotr = dot(qr, pr);

    if (dotp < 0) {
      area += 0.25 * triArea;
    } else if (dotq < 0 || dotr < 0) {
      area += 0.125 * triArea;
    } else {
      const cotq = dotq / triArea;
      const cotr = dotr / triArea;
      area += 0.125 * (sqrnorm(pr) * clampCot(cotq) + sqrnorm(pq) * clampCot(cotr));
    }
  }
  return area;
}

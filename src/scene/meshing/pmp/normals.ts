// Face and vertex normals, ported from pmp::algorithms/normals.cpp.

import type { HalfedgeMesh, FaceId, VertexId, Point } from "./halfedge-mesh";
import { cross, sub, normalize, add, scale } from "./geometry";

export function faceNormal(mesh: HalfedgeMesh, f: FaceId): Point {
  const hend = mesh.halfedgeOfFace(f);
  let h = hend;
  const p0 = mesh.position(mesh.toVertex(h));
  h = mesh.nextHalfedge(h);
  const p1 = mesh.position(mesh.toVertex(h));
  h = mesh.nextHalfedge(h);
  const p2 = mesh.position(mesh.toVertex(h));

  if (mesh.nextHalfedge(h) === hend) {
    // triangle
    return normalize(cross(sub(p2, p1), sub(p0, p1)));
  }
  // general polygon: sum of (from × to) over its halfedges
  let n: Point = [0, 0, 0];
  for (const fh of mesh.halfedgesAroundFace(f)) {
    n = add(n, cross(mesh.position(mesh.fromVertex(fh)), mesh.position(mesh.toVertex(fh))));
  }
  return normalize(n);
}

// Angle-weighted vertex normal.
export function vertexNormal(mesh: HalfedgeMesh, v: VertexId): Point {
  let nn: Point = [0, 0, 0];
  if (mesh.isIsolated(v)) return nn;
  const p0 = mesh.position(v);

  for (const h of mesh.halfedgesAroundVertex(v)) {
    if (mesh.isBoundaryHalfedge(h)) continue;
    const p1 = sub(mesh.position(mesh.toVertex(h)), p0);
    const p2 = sub(mesh.position(mesh.fromVertex(mesh.prevHalfedge(h))), p0);

    const denom = Math.sqrt((p1[0] * p1[0] + p1[1] * p1[1] + p1[2] * p1[2]) *
      (p2[0] * p2[0] + p2[1] * p2[1] + p2[2] * p2[2]));
    if (denom <= 1e-20) continue;

    let cosine = (p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]) / denom;
    cosine = cosine < -1 ? -1 : cosine > 1 ? 1 : cosine;
    const angle = Math.acos(cosine);

    const isTriangle =
      mesh.nextHalfedge(mesh.nextHalfedge(mesh.nextHalfedge(h))) === h;
    const n = isTriangle ? normalize(cross(p1, p2)) : faceNormal(mesh, mesh.face(h));
    nn = add(nn, scale(n, angle));
  }
  return normalize(nn);
}

// Compute and store f:normal for every face. Returns the property array.
export function computeFaceNormals(mesh: HalfedgeMesh): Point[] {
  const prop = mesh.faceProperty<Point>("f:normal", () => [0, 0, 0]);
  for (const f of mesh.faces()) prop[f] = faceNormal(mesh, f);
  return prop;
}

// Compute and store v:normal for every vertex. Returns the property array.
export function computeVertexNormals(mesh: HalfedgeMesh): Point[] {
  const prop = mesh.vertexProperty<Point>("v:normal", () => [0, 0, 0]);
  for (const v of mesh.vertices()) prop[v] = vertexNormal(mesh, v);
  return prop;
}

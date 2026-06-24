// Geometry helpers ported from pmp::algorithms (differential_geometry, distance_point_triangle,
// barycentric_coordinates, decimation::aspect_ratio). Operate on plain [x,y,z] tuples to avoid
// THREE.Vector allocations in hot loops.

import type { HalfedgeMesh, FaceId, Point } from "./halfedge-mesh";

// --- small vector ops on Point tuples ---

export function sub(a: Point, b: Point): Point {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function add(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
export function scale(a: Point, s: number): Point {
  return [a[0] * s, a[1] * s, a[2] * s];
}
export function dot(a: Point, b: Point): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
export function cross(a: Point, b: Point): Point {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
export function sqrnorm(a: Point): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}
export function norm(a: Point): number {
  return Math.sqrt(sqrnorm(a));
}
export function normalize(a: Point): Point {
  const n = norm(a);
  return n > 1e-20 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
}

// --- areas / centroids ---

export function triangleArea(p0: Point, p1: Point, p2: Point): number {
  return 0.5 * norm(cross(sub(p1, p0), sub(p2, p0)));
}

// Standard area for triangles; norm of the vector area for general polygons.
export function faceArea(mesh: HalfedgeMesh, f: FaceId): number {
  let ax = 0;
  let ay = 0;
  let az = 0;
  for (const h of mesh.halfedgesAroundFace(f)) {
    const q = mesh.position(mesh.fromVertex(h));
    const r = mesh.position(mesh.toVertex(h));
    ax += q[1] * r[2] - q[2] * r[1];
    ay += q[2] * r[0] - q[0] * r[2];
    az += q[0] * r[1] - q[1] * r[0];
  }
  return 0.5 * Math.sqrt(ax * ax + ay * ay + az * az);
}

export function surfaceArea(mesh: HalfedgeMesh): number {
  let a = 0;
  for (const f of mesh.faces()) a += faceArea(mesh, f);
  return a;
}

export function faceCentroid(mesh: HalfedgeMesh, f: FaceId): Point {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let n = 0;
  for (const v of mesh.verticesAroundFace(f)) {
    const p = mesh.position(v);
    cx += p[0];
    cy += p[1];
    cz += p[2];
    n += 1;
  }
  return [cx / n, cy / n, cz / n];
}

// Area-weighted mean of face centroids.
export function centroid(mesh: HalfedgeMesh): Point {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let aa = 0;
  for (const f of mesh.faces()) {
    const a = faceArea(mesh, f);
    const c = faceCentroid(mesh, f);
    aa += a;
    cx += a * c[0];
    cy += a * c[1];
    cz += a * c[2];
  }
  if (aa <= 0) return [0, 0, 0];
  return [cx / aa, cy / aa, cz / aa];
}

// Triangle aspect ratio = max squared edge length / (2·area) (pmp Decimation::aspect_ratio).
export function triangleAspectRatio(mesh: HalfedgeMesh, f: FaceId): number {
  const verts = [...mesh.verticesAroundFace(f)];
  if (verts.length !== 3) return 0;
  const p0 = mesh.position(verts[0]);
  const p1 = mesh.position(verts[1]);
  const p2 = mesh.position(verts[2]);
  const d0 = sub(p0, p1);
  const d1 = sub(p1, p2);
  const d2 = sub(p2, p0);
  const l = Math.max(sqrnorm(d0), sqrnorm(d1), sqrnorm(d2));
  const a = norm(cross(d0, d1));
  return a > 0 ? l / a : 0;
}

export type BoundingBox = { min: Point; max: Point };

export function boundingBox(mesh: HalfedgeMesh): BoundingBox {
  const min: Point = [Infinity, Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices()) {
    const p = mesh.position(v);
    for (let i = 0; i < 3; i += 1) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return { min, max };
}

// --- barycentric coordinates (robust, projects onto the dominant plane) ---

export function barycentricCoordinates(p: Point, u: Point, v: Point, w: Point): Point {
  const result: Point = [1 / 3, 1 / 3, 1 / 3];
  const vu = sub(v, u);
  const wu = sub(w, u);
  const pu = sub(p, u);

  const nx = vu[1] * wu[2] - vu[2] * wu[1];
  const ny = vu[2] * wu[0] - vu[0] * wu[2];
  const nz = vu[0] * wu[1] - vu[1] * wu[0];
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);

  let maxCoord: 0 | 1 | 2;
  if (ax > ay) maxCoord = ax > az ? 0 : 2;
  else maxCoord = ay > az ? 1 : 2;

  switch (maxCoord) {
    case 0:
      if (1 + ax !== 1) {
        result[1] = (pu[1] * wu[2] - pu[2] * wu[1]) / nx;
        result[2] = (vu[1] * pu[2] - vu[2] * pu[1]) / nx;
        result[0] = 1 - result[1] - result[2];
      }
      break;
    case 1:
      if (1 + ay !== 1) {
        result[1] = (pu[2] * wu[0] - pu[0] * wu[2]) / ny;
        result[2] = (vu[2] * pu[0] - vu[0] * pu[2]) / ny;
        result[0] = 1 - result[1] - result[2];
      }
      break;
    case 2:
      if (1 + az !== 1) {
        result[1] = (pu[0] * wu[1] - pu[1] * wu[0]) / nz;
        result[2] = (vu[0] * pu[1] - vu[1] * pu[0]) / nz;
        result[0] = 1 - result[1] - result[2];
      }
      break;
  }
  return result;
}

// --- point/triangle distance ---

export type ClosestResult = { distance: number; nearest: Point };

export function distPointLineSegment(p: Point, v0: Point, v1: Point): ClosestResult {
  let d1 = sub(p, v0);
  const d2 = sub(v1, v0);
  let minV = v0;
  let t = dot(d2, d2);
  if (t > 1e-20) {
    t = dot(d1, d2) / t;
    if (t > 1) {
      minV = v1;
      d1 = sub(p, v1);
    } else if (t > 0) {
      minV = add(v0, scale(d2, t));
      d1 = sub(p, minV);
    }
  }
  return { distance: norm(d1), nearest: minV };
}

export function distPointTriangle(
  p: Point,
  v0: Point,
  v1: Point,
  v2: Point,
): ClosestResult {
  const v0v1 = sub(v1, v0);
  const v0v2 = sub(v2, v0);
  const n = cross(v0v1, v0v2);
  const d = sqrnorm(n);

  // degenerate triangle: fall back to the three edges
  if (Math.abs(d) < 1e-20) {
    let best = distPointLineSegment(p, v0, v1);
    const e1 = distPointLineSegment(p, v1, v2);
    if (e1.distance < best.distance) best = e1;
    const e2 = distPointLineSegment(p, v2, v0);
    if (e2.distance < best.distance) best = e2;
    return best;
  }

  const invD = 1 / d;
  const v1v2 = sub(v2, v1);
  const v0p = sub(p, v0);
  const t = cross(v0p, n);
  const a = -dot(t, v0v2) * invD;
  const b = dot(t, v0v1) * invD;
  let nearest: Point;

  const onV0V1 = (s: number): Point =>
    s <= 0 ? v0 : s >= 1 ? v1 : add(v0, scale(v0v1, s));
  const onV0V2 = (s: number): Point =>
    s <= 0 ? v0 : s >= 1 ? v2 : add(v0, scale(v0v2, s));
  const onV1V2 = (s: number): Point =>
    s <= 0 ? v1 : s >= 1 ? v2 : add(v1, scale(v1v2, s));

  if (a < 0) {
    const s02 = dot(v0v2, v0p) / sqrnorm(v0v2);
    if (s02 < 0) {
      const s01 = dot(v0v1, v0p) / sqrnorm(v0v1);
      nearest = onV0V1(s01);
    } else if (s02 > 1) {
      const s12 = dot(v1v2, sub(p, v1)) / sqrnorm(v1v2);
      nearest = onV1V2(s12);
    } else {
      nearest = add(v0, scale(v0v2, s02));
    }
  } else if (b < 0) {
    const s01 = dot(v0v1, v0p) / sqrnorm(v0v1);
    if (s01 < 0) {
      const s02 = dot(v0v2, v0p) / sqrnorm(v0v2);
      nearest = onV0V2(s02);
    } else if (s01 > 1) {
      const s12 = dot(v1v2, sub(p, v1)) / sqrnorm(v1v2);
      nearest = onV1V2(s12);
    } else {
      nearest = add(v0, scale(v0v1, s01));
    }
  } else if (a + b > 1) {
    const s12 = dot(v1v2, sub(p, v1)) / sqrnorm(v1v2);
    if (s12 >= 1) {
      const s02 = dot(v0v2, v0p) / sqrnorm(v0v2);
      nearest = onV0V2(s02);
    } else if (s12 <= 0) {
      const s01 = dot(v0v1, v0p) / sqrnorm(v0v1);
      nearest = onV0V1(s01);
    } else {
      nearest = add(v1, scale(v1v2, s12));
    }
  } else {
    // interior: project p onto the plane
    nearest = sub(p, scale(n, dot(n, v0p) * invD));
  }

  return { distance: norm(sub(p, nearest)), nearest };
}

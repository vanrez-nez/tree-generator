// Per-vertex principal curvatures via Cohen-Steiner / Alliez tensor analysis, ported from
// pmp::algorithms/curvature.cpp (analyze_tensor, one-ring). Adaptive remeshing only needs the
// max-abs curvature, which is the largest-magnitude eigenvalue of the curvature tensor — so we need
// eigenvalues only (analytic symmetric-3×3 / Smith), not eigenvectors.

import type { HalfedgeMesh, Point } from "./halfedge-mesh";
import { sub, cross, dot, norm } from "./geometry";
import { faceNormal } from "./normals";
import { voronoiAreaMixed } from "./laplace";

// Eigenvalues of a symmetric 3×3 matrix [t00,t01,t02,t11,t12,t22], returned in decreasing order.
function eigenvaluesSym3(t: number[]): [number, number, number] {
  const m00 = t[0], m01 = t[1], m02 = t[2], m11 = t[3], m12 = t[4], m22 = t[5];
  const p1 = m01 * m01 + m02 * m02 + m12 * m12;
  if (p1 === 0) {
    const arr = [m00, m11, m22].sort((a, b) => b - a);
    return [arr[0], arr[1], arr[2]];
  }
  const q = (m00 + m11 + m22) / 3;
  const p2 = (m00 - q) ** 2 + (m11 - q) ** 2 + (m22 - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const b00 = (m00 - q) / p, b11 = (m11 - q) / p, b22 = (m22 - q) / p;
  const b01 = m01 / p, b02 = m02 / p, b12 = m12 / p;
  const detB =
    b00 * (b11 * b22 - b12 * b12) -
    b01 * (b01 * b22 - b12 * b02) +
    b02 * (b01 * b12 - b11 * b02);
  let r = detB / 2;
  r = r < -1 ? -1 : r > 1 ? 1 : r;
  const phi = Math.acos(r) / 3;
  const e1 = q + 2 * p * Math.cos(phi);
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const e2 = 3 * q - e1 - e3;
  return [e1, e2, e3];
}

// kmin/kmax from the tensor: the eigenvalue with smallest |·| is the surface normal; the other two
// are the principal curvatures.
function principalFromTensor(t: number[]): { kmin: number; kmax: number } {
  const e = eigenvaluesSym3(t);
  const a = [Math.abs(e[0]), Math.abs(e[1]), Math.abs(e[2])];
  let normalIdx = 0;
  if (a[1] < a[normalIdx]) normalIdx = 1;
  if (a[2] < a[normalIdx]) normalIdx = 2;
  const rest = [0, 1, 2].filter((i) => i !== normalIdx).map((i) => e[i]);
  return { kmin: Math.min(rest[0], rest[1]), kmax: Math.max(rest[0], rest[1]) };
}

export type Curvatures = { min: number[]; max: number[] };

// Principal curvatures per vertex (one-ring tensor). Boundary vertices interpolate from interior
// neighbours (pmp set_boundary_curvatures). No post-smoothing (remeshing smooths separately).
export function principalCurvatures(mesh: HalfedgeMesh): Curvatures {
  const n = mesh.verticesSize();
  const minc = new Array<number>(n).fill(0);
  const maxc = new Array<number>(n).fill(0);

  // per-vertex mixed Voronoi area
  const area = new Array<number>(n);
  for (let v = 0; v < n; v += 1) area[v] = mesh.isDeletedVertex(v) ? 0 : voronoiAreaMixed(mesh, v);

  // per-face normals
  const ne = mesh.edgesSize();
  const fnormal = new Map<number, Point>();
  for (const f of mesh.faces()) fnormal.set(f, faceNormal(mesh, f));

  // per-edge dihedral angle and weighted edge vector (interior edges only)
  const evec: Point[] = new Array(ne);
  const eangle = new Array<number>(ne).fill(0);
  for (let e = 0; e < ne; e += 1) evec[e] = [0, 0, 0];
  for (const e of mesh.edges()) {
    const h0 = mesh.edgeHalfedge(e, 0);
    const h1 = mesh.edgeHalfedge(e, 1);
    const f0 = mesh.face(h0);
    const f1 = mesh.face(h1);
    if (f0 < 0 || f1 < 0) continue;
    const n0 = fnormal.get(f0)!;
    const n1 = fnormal.get(f1)!;
    let ev = sub(mesh.position(mesh.toVertex(h0)), mesh.position(mesh.toVertex(h1)));
    let l = norm(ev);
    if (l < 1e-20) continue;
    ev = [ev[0] / l, ev[1] / l, ev[2] / l];
    l *= 0.5;
    eangle[e] = Math.atan2(dot(cross(n0, n1), ev), dot(n0, n1));
    const s = Math.sqrt(l);
    evec[e] = [ev[0] * s, ev[1] * s, ev[2] * s];
  }

  // per-vertex curvature tensor (one-ring)
  for (let v = 0; v < n; v += 1) {
    if (mesh.isDeletedVertex(v) || mesh.isIsolated(v) || mesh.isBoundaryVertex(v)) continue;
    const t = [0, 0, 0, 0, 0, 0];
    for (const h of mesh.halfedgesAroundVertex(v)) {
      const e = mesh.edge(h);
      const ev = evec[e];
      const beta = eangle[e];
      t[0] += beta * ev[0] * ev[0];
      t[1] += beta * ev[0] * ev[1];
      t[2] += beta * ev[0] * ev[2];
      t[3] += beta * ev[1] * ev[1];
      t[4] += beta * ev[1] * ev[2];
      t[5] += beta * ev[2] * ev[2];
    }
    const A = area[v];
    if (A <= 1e-20) continue;
    for (let i = 0; i < 6; i += 1) t[i] /= A;
    const { kmin, kmax } = principalFromTensor(t);
    minc[v] = kmin;
    maxc[v] = kmax;
  }

  // boundary vertices: average interior neighbours
  for (let v = 0; v < n; v += 1) {
    if (mesh.isDeletedVertex(v) || !mesh.isBoundaryVertex(v)) continue;
    let kmin = 0;
    let kmax = 0;
    let sum = 0;
    for (const vv of mesh.verticesAroundVertex(v)) {
      if (!mesh.isBoundaryVertex(vv)) {
        sum += 1;
        kmin += minc[vv];
        kmax += maxc[vv];
      }
    }
    if (sum) {
      minc[v] = kmin / sum;
      maxc[v] = kmax / sum;
    }
  }

  return { min: minc, max: maxc };
}

// Max absolute principal curvature per vertex (pmp Curvature::MaxAbs).
export function maxAbsCurvatures(mesh: HalfedgeMesh): number[] {
  const { min, max } = principalCurvatures(mesh);
  const out = new Array<number>(min.length);
  for (let v = 0; v < min.length; v += 1) out[v] = Math.max(Math.abs(min[v]), Math.abs(max[v]));
  return out;
}

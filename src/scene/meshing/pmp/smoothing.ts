// Explicit Laplacian smoothing, ported from pmp::algorithms/smoothing.cpp (explicit_smoothing).
//
// PMP's matrix form  X += (S^T S)(0.5 · D^{-1} L) X  reduces, per inner vertex, to one Jacobi step
//   x_i += 0.5 · ( (Σ_j w_ij x_j) / (Σ_j w_ij) − x_i )
// with boundary vertices frozen, negative cotan weights clamped to zero, and all updates computed
// from the previous iteration's positions (double buffered).

import type { HalfedgeMesh, Point, VertexId } from "./halfedge-mesh";
import { cotanWeight, voronoiAreaMixed } from "./laplace";
import { centroid, surfaceArea } from "./geometry";

export type LaplaceKind = "uniform" | "cotan";

export type ExplicitSmoothingOptions = {
  iterations?: number;
  laplace?: LaplaceKind;
};

export function explicitSmoothing(
  mesh: HalfedgeMesh,
  { iterations = 10, laplace = "cotan" }: ExplicitSmoothingOptions = {},
): void {
  if (mesh.nVertices() === 0) return;
  const points = mesh.vertexProperty<Point>("v:point", () => [0, 0, 0]);
  const next: Point[] = new Array(mesh.verticesSize());

  for (let it = 0; it < iterations; it += 1) {
    for (const v of mesh.vertices()) {
      const p = points[v];
      if (mesh.isBoundaryVertex(v)) {
        next[v] = [p[0], p[1], p[2]];
        continue;
      }
      let sw = 0;
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const h of mesh.halfedgesAroundVertex(v)) {
        const w = laplace === "uniform" ? 1 : Math.max(0, cotanWeight(mesh, mesh.edge(h)));
        if (w === 0) continue;
        const q = points[mesh.toVertex(h)];
        sw += w;
        ax += w * q[0];
        ay += w * q[1];
        az += w * q[2];
      }
      if (sw > 1e-20) {
        next[v] = [
          p[0] + 0.5 * (ax / sw - p[0]),
          p[1] + 0.5 * (ay / sw - p[1]),
          p[2] + 0.5 * (az / sw - p[2]),
        ];
      } else {
        next[v] = [p[0], p[1], p[2]];
      }
    }

    for (const v of mesh.vertices()) {
      const n = next[v];
      points[v][0] = n[0];
      points[v][1] = n[1];
      points[v][2] = n[2];
    }
  }
}

// --- Implicit (backward-Euler) Laplacian smoothing ---
//
// Ported from pmp::algorithms/smoothing.cpp::implicit_smoothing. Each step solves the SPD system
//   (M − timestep·L) X = M X
// with boundary vertices held fixed (Dirichlet). L is the cotan (or uniform) Laplace matrix built
// once from the initial mesh; the lumped mass M is rebuilt each iteration. We solve with a
// projected conjugate gradient — no external sparse solver. Triangle meshes only.

export type ImplicitSmoothingOptions = {
  timestep?: number;
  iterations?: number;
  laplace?: LaplaceKind;
  rescale?: boolean;
};

type SparseSym = {
  // symmetric Laplace matrix: per row, neighbour columns → weight; plus the diagonal.
  rows: Map<VertexId, number>[];
  diag: number[];
};

function buildLaplace(mesh: HalfedgeMesh, n: number, laplace: LaplaceKind): SparseSym {
  const rows: Map<VertexId, number>[] = Array.from({ length: n }, () => new Map());
  const diag = new Array<number>(n).fill(0);
  for (const e of mesh.edges()) {
    const a = mesh.edgeVertex(e, 0);
    const b = mesh.edgeVertex(e, 1);
    const w = laplace === "uniform" ? 1 : cotanWeight(mesh, e);
    rows[a].set(b, (rows[a].get(b) ?? 0) + w);
    rows[b].set(a, (rows[b].get(a) ?? 0) + w);
    diag[a] -= w;
    diag[b] -= w;
  }
  return { rows, diag };
}

function massVector(mesh: HalfedgeMesh, n: number, laplace: LaplaceKind): number[] {
  const m = new Array<number>(n);
  for (let v = 0; v < n; v += 1) {
    m[v] = laplace === "uniform" ? mesh.valenceVertex(v) : voronoiAreaMixed(mesh, v);
    if (m[v] < 1e-12) m[v] = 1e-12;
  }
  return m;
}

// Projected conjugate gradient for A x = b with constrained dofs frozen at their x0 value.
// A is given as diag[i] on the diagonal and off[i] (col→value) off-diagonal; SPD over free dofs.
function solveConstrained(
  off: Map<VertexId, number>[],
  diag: number[],
  b: number[],
  constrained: boolean[],
  x0: number[],
): number[] {
  const n = diag.length;
  const matvec = (v: number[]): number[] => {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i += 1) {
      let s = diag[i] * v[i];
      for (const [j, w] of off[i]) s += w * v[j];
      out[i] = s;
    }
    return out;
  };

  const x = x0.slice();
  const r = b.slice();
  const Ax = matvec(x);
  for (let i = 0; i < n; i += 1) r[i] = constrained[i] ? 0 : b[i] - Ax[i];
  const p = r.slice();
  let rsold = 0;
  for (let i = 0; i < n; i += 1) rsold += r[i] * r[i];

  const maxIter = Math.min(2 * n + 50, 5000);
  for (let it = 0; it < maxIter; it += 1) {
    if (Math.sqrt(rsold) < 1e-7) break;
    const Ap = matvec(p);
    let pAp = 0;
    for (let i = 0; i < n; i += 1) {
      if (constrained[i]) Ap[i] = 0;
      pAp += p[i] * Ap[i];
    }
    if (Math.abs(pAp) < 1e-30) break;
    const alpha = rsold / pAp;
    let rsnew = 0;
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * Ap[i];
      rsnew += r[i] * r[i];
    }
    const beta = rsnew / rsold;
    for (let i = 0; i < n; i += 1) p[i] = r[i] + beta * p[i];
    rsold = rsnew;
  }
  return x;
}

export function implicitSmoothing(
  mesh: HalfedgeMesh,
  { timestep = 0.001, iterations = 1, laplace = "cotan", rescale = true }: ImplicitSmoothingOptions = {},
): void {
  if (mesh.nVertices() === 0) return;
  if (!mesh.isTriangleMesh()) throw new Error("implicitSmoothing: not a triangle mesh");

  // compact so vertex ids are contiguous [0, n)
  mesh.garbageCollection();
  const n = mesh.verticesSize();
  const points = mesh.vertexProperty<Point>("v:point", () => [0, 0, 0]);

  const constrained = new Array<boolean>(n);
  for (let v = 0; v < n; v += 1) constrained[v] = mesh.isBoundaryVertex(v);

  const L = buildLaplace(mesh, n, laplace);

  let centerBefore: Point = [0, 0, 0];
  let areaBefore = 0;
  if (rescale) {
    centerBefore = centroid(mesh);
    areaBefore = surfaceArea(mesh);
  }

  for (let iter = 0; iter < iterations; iter += 1) {
    const M = massVector(mesh, n, laplace);

    // A = M − timestep·L  (diagonal and off-diagonals)
    const aDiag = new Array<number>(n);
    const aOff: Map<VertexId, number>[] = Array.from({ length: n }, () => new Map());
    for (let i = 0; i < n; i += 1) {
      aDiag[i] = M[i] - timestep * L.diag[i];
      for (const [j, w] of L.rows[i]) aOff[i].set(j, -timestep * w);
    }

    // solve each coordinate; RHS B = M·X
    for (let c = 0; c < 3; c += 1) {
      const b = new Array<number>(n);
      const x0 = new Array<number>(n);
      for (let v = 0; v < n; v += 1) {
        b[v] = M[v] * points[v][c];
        x0[v] = points[v][c];
      }
      const x = solveConstrained(aOff, aDiag, b, constrained, x0);
      for (let v = 0; v < n; v += 1) points[v][c] = x[v];
    }

    if (rescale) {
      const areaAfter = surfaceArea(mesh);
      const scale = areaAfter > 1e-20 ? Math.sqrt(areaBefore / areaAfter) : 1;
      for (let v = 0; v < n; v += 1) {
        points[v][0] *= scale;
        points[v][1] *= scale;
        points[v][2] *= scale;
      }
      const centerAfter = centroid(mesh);
      const tx = centerBefore[0] - centerAfter[0];
      const ty = centerBefore[1] - centerAfter[1];
      const tz = centerBefore[2] - centerAfter[2];
      for (let v = 0; v < n; v += 1) {
        points[v][0] += tx;
        points[v][1] += ty;
        points[v][2] += tz;
      }
    }
  }
}

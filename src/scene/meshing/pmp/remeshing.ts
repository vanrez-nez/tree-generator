// Uniform incremental remeshing (split / collapse / flip / tangential relaxation), ported from
// pmp::algorithms/remeshing.cpp. Triangle meshes only.
//
// Adaptive remeshing is deferred: it needs the curvature algorithm to drive its sizing field. The
// uniform path uses a constant target edge length, so no curvature is required. Back-projection onto
// the input surface uses a TriangleKdTree (spatial.ts).

import type { HalfedgeMesh, VertexId, EdgeId, Point } from "./halfedge-mesh";
import { sub, add, dot, cross, norm, normalize, barycentricCoordinates } from "./geometry";
import { vertexNormal, computeVertexNormals } from "./normals";
import { cotanWeight } from "./laplace";
import { maxAbsCurvatures } from "./curvature";
import { TriangleKdTree, type Triangle } from "./spatial";

export type UniformRemeshingOptions = {
  edgeLength: number;
  iterations?: number;
  useProjection?: boolean;
};

export type AdaptiveRemeshingOptions = {
  minEdgeLength: number;
  maxEdgeLength: number;
  approxError: number;
  iterations?: number;
  useProjection?: boolean;
};

function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// Solve the symmetric 3×3 system A x = b. Returns null if A is (near) singular.
function solve3(A: number[], b: Point): Point | null {
  const a = A[0], b1 = A[1], c = A[2], d = A[3], e = A[4], f = A[5], g = A[6], h = A[7], i = A[8];
  const c00 = e * i - f * h;
  const c01 = -(d * i - f * g);
  const c02 = d * h - e * g;
  const det = a * c00 + b1 * c01 + c * c02;
  if (Math.abs(det) < 1e-20) return null;
  const inv = 1 / det;
  const m00 = c00 * inv;
  const m01 = (c * h - b1 * i) * inv;
  const m02 = (b1 * f - c * e) * inv;
  const m10 = c01 * inv;
  const m11 = (a * i - c * g) * inv;
  const m12 = (c * d - a * f) * inv;
  const m20 = c02 * inv;
  const m21 = (b1 * g - a * h) * inv;
  const m22 = (a * e - b1 * d) * inv;
  return [
    m00 * b[0] + m01 * b[1] + m02 * b[2],
    m10 * b[0] + m11 * b[1] + m12 * b[2],
    m20 * b[0] + m21 * b[1] + m22 * b[2],
  ];
}

type Reference = {
  tree: TriangleKdTree;
  triPoints: Triangle[];
  triNormals: [Point, Point, Point][];
  triSizing: [number, number, number][];
};

class Remeshing {
  private points: Point[];
  private vnormal: Point[];
  private vfeature: boolean[];
  private efeature: boolean[];
  private vlocked: boolean[];
  private elocked: boolean[];
  private vsizing: number[];

  private uniform = true;
  private targetEdgeLength = 0;
  private minEdgeLength = 0;
  private maxEdgeLength = 0;
  private approxError = 0;
  private useProjection = true;
  private reference: Reference | null = null;
  private readonly hadFeatureVertices: boolean;
  private readonly hadFeatureEdges: boolean;

  constructor(private readonly mesh: HalfedgeMesh) {
    if (!mesh.isTriangleMesh()) throw new Error("remeshing: input is not a triangle mesh");
    this.points = mesh.vertexProperty<Point>("v:point", () => [0, 0, 0]);
    this.vnormal = computeVertexNormals(mesh);
    this.hadFeatureVertices = mesh.getVertexProperty<boolean>("v:feature") !== undefined;
    this.hadFeatureEdges = mesh.getEdgeProperty<boolean>("e:feature") !== undefined;
    this.vfeature = mesh.vertexProperty<boolean>("v:feature", () => false);
    this.efeature = mesh.edgeProperty<boolean>("e:feature", () => false);
    this.vlocked = [];
    this.elocked = [];
    this.vsizing = [];
  }

  uniformRemeshing(edgeLength: number, iterations: number, useProjection: boolean): void {
    this.uniform = true;
    this.targetEdgeLength = edgeLength;
    this.useProjection = useProjection;
    this.run(iterations);
  }

  adaptiveRemeshing(
    minEdgeLength: number,
    maxEdgeLength: number,
    approxError: number,
    iterations: number,
    useProjection: boolean,
  ): void {
    this.uniform = false;
    this.minEdgeLength = minEdgeLength;
    this.maxEdgeLength = maxEdgeLength;
    this.approxError = approxError;
    this.useProjection = useProjection;
    this.run(iterations);
  }

  private run(iterations: number): void {
    this.preprocessing();
    for (let i = 0; i < iterations; i += 1) {
      this.splitLongEdges();
      computeVertexNormals(this.mesh);
      this.collapseShortEdges();
      this.flipEdges();
      this.tangentialSmoothing(5);
    }
    this.removeCaps();
    this.postprocessing();
  }

  private isTooLong(v0: VertexId, v1: VertexId): boolean {
    return distance(this.points[v0], this.points[v1]) >
      (4 / 3) * Math.min(this.vsizing[v0], this.vsizing[v1]);
  }
  private isTooShort(v0: VertexId, v1: VertexId): boolean {
    return distance(this.points[v0], this.points[v1]) <
      (4 / 5) * Math.min(this.vsizing[v0], this.vsizing[v1]);
  }

  private preprocessing(): void {
    const mesh = this.mesh;
    this.vlocked = mesh.vertexProperty<boolean>("v:locked", () => false);
    this.elocked = mesh.edgeProperty<boolean>("e:locked", () => false);
    this.vsizing = mesh.vertexProperty<number>("v:sizing", () => 0);

    // selection locking
    const vselected = mesh.getVertexProperty<boolean>("v:selected");
    if (vselected) {
      let hasSelection = false;
      for (const v of mesh.vertices()) if (vselected[v]) { hasSelection = true; break; }
      if (hasSelection) {
        for (const v of mesh.vertices()) this.vlocked[v] = !vselected[v];
        for (const e of mesh.edges()) {
          this.elocked[e] = this.vlocked[mesh.edgeVertex(e, 0)] || this.vlocked[mesh.edgeVertex(e, 1)];
        }
      }
    }

    // lock feature corners (vertices not exactly on a 2-edge feature line)
    for (const v of mesh.vertices()) {
      if (this.vfeature[v]) {
        let c = 0;
        for (const h of mesh.halfedgesAroundVertex(v)) if (this.efeature[mesh.edge(h)]) c += 1;
        if (c !== 2) this.vlocked[v] = true;
      }
    }

    // sizing field
    if (this.uniform) {
      for (const v of mesh.vertices()) this.vsizing[v] = this.targetEdgeLength;
    } else {
      this.computeAdaptiveSizing();
    }

    if (this.useProjection) this.buildReference();
  }

  // Curvature-driven sizing (Dunyach et al. 2013), ported from the adaptive branch of pmp
  // Remeshing::preprocessing. Edge length ≈ sqrt(6·error·radius − 3·error²), clamped to [min, max].
  private computeAdaptiveSizing(): void {
    const mesh = this.mesh;
    const curv = maxAbsCurvatures(mesh);

    // feature-aware smoothing of curvatures (skip feature vertices/neighbours)
    for (const v of mesh.vertices()) {
      if (this.vfeature[v]) continue;
      let c = 0;
      let sumw = 0;
      for (const h of mesh.halfedgesAroundVertex(v)) {
        const vv = mesh.toVertex(h);
        if (this.vfeature[vv]) continue;
        const w = Math.max(0, cotanWeight(mesh, mesh.edge(h)));
        sumw += w;
        c += w * curv[vv];
      }
      if (sumw) curv[v] = c / sumw;
    }

    // boundary/feature curvatures are meaningless → mark negative, then propagate inward
    for (const v of mesh.vertices()) {
      this.vsizing[v] = mesh.isBoundaryVertex(v) || this.vfeature[v] ? -1 : curv[v];
    }
    for (let iters = 0; iters < 2; iters += 1) {
      for (const v of mesh.vertices()) {
        let ww = 0;
        let cc = 0;
        for (const h of mesh.halfedgesAroundVertex(v)) {
          const c = this.vsizing[mesh.toVertex(h)];
          if (c > 0) {
            const w = Math.max(0, cotanWeight(mesh, mesh.edge(h)));
            ww += w;
            cc += w * c;
          }
        }
        if (ww) cc /= ww;
        this.vsizing[v] = cc;
      }
    }

    // convert curvature → target edge length
    for (const v of mesh.vertices()) {
      const c = this.vsizing[v];
      const r = 1 / c;
      const e = this.approxError;
      let h: number;
      if (e < r) h = Math.sqrt(6 * e * r - 3 * e * e);
      else h = e * Math.sqrt(3);
      if (h < this.minEdgeLength) h = this.minEdgeLength;
      else if (h > this.maxEdgeLength) h = this.maxEdgeLength;
      this.vsizing[v] = h;
    }
  }

  private buildReference(): void {
    const mesh = this.mesh;
    computeVertexNormals(mesh);
    const triPoints: Triangle[] = [];
    const triNormals: [Point, Point, Point][] = [];
    const triSizing: [number, number, number][] = [];
    for (const f of mesh.faces()) {
      const verts = [...mesh.verticesAroundFace(f)];
      const [a, b, c] = verts;
      triPoints.push([
        [...this.points[a]] as Point,
        [...this.points[b]] as Point,
        [...this.points[c]] as Point,
      ]);
      triNormals.push([
        [...this.vnormal[a]] as Point,
        [...this.vnormal[b]] as Point,
        [...this.vnormal[c]] as Point,
      ]);
      triSizing.push([this.vsizing[a], this.vsizing[b], this.vsizing[c]]);
    }
    this.reference = { tree: new TriangleKdTree(triPoints, 0), triPoints, triNormals, triSizing };
  }

  private postprocessing(): void {
    const mesh = this.mesh;
    mesh.removeVertexProperty("v:locked");
    mesh.removeEdgeProperty("e:locked");
    mesh.removeVertexProperty("v:sizing");
    if (!this.hadFeatureVertices) mesh.removeVertexProperty("v:feature");
    if (!this.hadFeatureEdges) mesh.removeEdgeProperty("e:feature");
  }

  private projectToReference(v: VertexId): void {
    if (!this.useProjection || !this.reference) return;
    const ref = this.reference;
    const nn = ref.tree.nearest(this.points[v]);
    if (nn.face < 0) return;
    const p = nn.nearest;
    const tri = ref.triPoints[nn.face];
    const ns = ref.triNormals[nn.face];
    const ss = ref.triSizing[nn.face];
    const bc = barycentricCoordinates(p, tri[0], tri[1], tri[2]);
    const n = normalize([
      ns[0][0] * bc[0] + ns[1][0] * bc[1] + ns[2][0] * bc[2],
      ns[0][1] * bc[0] + ns[1][1] * bc[1] + ns[2][1] * bc[2],
      ns[0][2] * bc[0] + ns[1][2] * bc[1] + ns[2][2] * bc[2],
    ]);
    const s = ss[0] * bc[0] + ss[1] * bc[1] + ss[2] * bc[2];
    this.points[v] = [p[0], p[1], p[2]];
    this.vnormal[v] = n;
    this.vsizing[v] = s;
  }

  private splitLongEdges(): void {
    const mesh = this.mesh;
    let ok = false;
    for (let i = 0; !ok && i < 10; i += 1) {
      ok = true;
      for (const e of mesh.edges()) {
        const v0 = mesh.edgeVertex(e, 0);
        const v1 = mesh.edgeVertex(e, 1);
        if (!this.elocked[e] && this.isTooLong(v0, v1)) {
          const p0 = this.points[v0];
          const p1 = this.points[v1];
          const isFeature = this.efeature[e];
          const isBoundary = mesh.isBoundaryEdge(e);
          const vnew = mesh.addVertex(
            0.5 * (p0[0] + p1[0]),
            0.5 * (p0[1] + p1[1]),
            0.5 * (p0[2] + p1[2]),
          );
          mesh.splitEdge(e, vnew);
          this.vnormal[vnew] = vertexNormal(mesh, vnew);
          this.vsizing[vnew] = 0.5 * (this.vsizing[v0] + this.vsizing[v1]);
          if (isFeature) {
            const enew = isBoundary ? mesh.nEdges() - 2 : mesh.nEdges() - 3;
            this.efeature[enew] = true;
            this.vfeature[vnew] = true;
          } else {
            this.projectToReference(vnew);
          }
          ok = false;
        }
      }
    }
  }

  private collapseShortEdges(): void {
    const mesh = this.mesh;
    let ok = false;
    for (let i = 0; !ok && i < 10; i += 1) {
      ok = true;
      for (const e of mesh.edges()) {
        if (mesh.isDeletedEdge(e) || this.elocked[e]) continue;
        const h10 = mesh.edgeHalfedge(e, 0);
        const h01 = mesh.edgeHalfedge(e, 1);
        const v0 = mesh.toVertex(h10);
        const v1 = mesh.toVertex(h01);
        if (!this.isTooShort(v0, v1)) continue;

        const b0 = mesh.isBoundaryVertex(v0);
        const b1 = mesh.isBoundaryVertex(v1);
        const l0 = this.vlocked[v0];
        const l1 = this.vlocked[v1];
        const f0 = this.vfeature[v0];
        const f1 = this.vfeature[v1];
        let hcol01 = true;
        let hcol10 = true;

        // boundary rules
        if (b0 && b1) {
          if (!mesh.isBoundaryEdge(e)) continue;
        } else if (b0) hcol01 = false;
        else if (b1) hcol10 = false;

        // locked rules
        if (l0 && l1) continue;
        else if (l0) hcol01 = false;
        else if (l1) hcol10 = false;

        // feature rules
        if (f0 && f1) {
          if (!this.efeature[e]) continue;
          let h0 = mesh.prevHalfedge(h01);
          let h1 = mesh.nextHalfedge(h10);
          if (this.efeature[mesh.edge(h0)] || this.efeature[mesh.edge(h1)]) hcol01 = false;
          h0 = mesh.prevHalfedge(h10);
          h1 = mesh.nextHalfedge(h01);
          if (this.efeature[mesh.edge(h0)] || this.efeature[mesh.edge(h1)]) hcol10 = false;
        } else if (f0) hcol01 = false;
        else if (f1) hcol10 = false;

        // PMP uses is_collapse_ok(h01) for both directions.
        const collapseOk = mesh.isCollapseOk(h01);
        if (hcol01) hcol01 = collapseOk;
        if (hcol10) hcol10 = collapseOk;

        // both possible: collapse into the higher-valence vertex
        if (hcol01 && hcol10) {
          if (mesh.valenceVertex(v0) < mesh.valenceVertex(v1)) hcol10 = false;
          else hcol01 = false;
        }

        if (hcol10) {
          for (const vv of mesh.verticesAroundVertex(v1)) {
            if (this.isTooLong(v0, vv)) {
              hcol10 = false;
              break;
            }
          }
          if (hcol10) {
            mesh.collapse(h10);
            ok = false;
          }
        } else if (hcol01) {
          for (const vv of mesh.verticesAroundVertex(v0)) {
            if (this.isTooLong(v1, vv)) {
              hcol01 = false;
              break;
            }
          }
          if (hcol01) {
            mesh.collapse(h01);
            ok = false;
          }
        }
      }
    }
    mesh.garbageCollection();
  }

  private flipEdges(): void {
    const mesh = this.mesh;
    const valence = mesh.vertexProperty<number>("v:valence-tmp", () => 0);
    for (const v of mesh.vertices()) valence[v] = mesh.valenceVertex(v);

    let ok = false;
    for (let i = 0; !ok && i < 10; i += 1) {
      ok = true;
      for (const e of mesh.edges()) {
        if (this.elocked[e] || this.efeature[e]) continue;
        let h = mesh.edgeHalfedge(e, 0);
        const v0 = mesh.toVertex(h);
        const v2 = mesh.toVertex(mesh.nextHalfedge(h));
        h = mesh.edgeHalfedge(e, 1);
        const v1 = mesh.toVertex(h);
        const v3 = mesh.toVertex(mesh.nextHalfedge(h));
        if (this.vlocked[v0] || this.vlocked[v1] || this.vlocked[v2] || this.vlocked[v3]) continue;

        const opt = (v: VertexId) => (mesh.isBoundaryVertex(v) ? 4 : 6);
        let val0 = valence[v0];
        let val1 = valence[v1];
        let val2 = valence[v2];
        let val3 = valence[v3];
        const o0 = opt(v0);
        const o1 = opt(v1);
        const o2 = opt(v2);
        const o3 = opt(v3);
        const sq = (x: number) => x * x;
        const veBefore = sq(val0 - o0) + sq(val1 - o1) + sq(val2 - o2) + sq(val3 - o3);
        val0 -= 1; val1 -= 1; val2 += 1; val3 += 1;
        const veAfter = sq(val0 - o0) + sq(val1 - o1) + sq(val2 - o2) + sq(val3 - o3);

        if (veBefore > veAfter && mesh.isFlipOk(e)) {
          mesh.flip(e);
          valence[v0] -= 1;
          valence[v1] -= 1;
          valence[v2] += 1;
          valence[v3] += 1;
          ok = false;
        }
      }
    }
    mesh.removeVertexProperty("v:valence-tmp");
  }

  private tangentialSmoothing(iterations: number): void {
    const mesh = this.mesh;
    const update = mesh.vertexProperty<Point>("v:update-tmp", () => [0, 0, 0]);

    if (this.useProjection) {
      for (const v of mesh.vertices()) {
        if (!mesh.isBoundaryVertex(v) && !this.vlocked[v]) this.projectToReference(v);
      }
    }

    for (let iter = 0; iter < iterations; iter += 1) {
      for (const v of mesh.vertices()) {
        if (mesh.isBoundaryVertex(v) || this.vlocked[v]) continue;
        let u: Point;
        if (this.vfeature[v]) {
          let uu: Point = [0, 0, 0];
          let t: Point = [0, 0, 0];
          let ww = 0;
          let c = 0;
          for (const h of mesh.halfedgesAroundVertex(v)) {
            if (!this.efeature[mesh.edge(h)]) continue;
            const vv = mesh.toVertex(h);
            const bcenter: Point = [
              0.5 * (this.points[v][0] + this.points[vv][0]),
              0.5 * (this.points[v][1] + this.points[vv][1]),
              0.5 * (this.points[v][2] + this.points[vv][2]),
            ];
            const w = distance(this.points[v], this.points[vv]) /
              (0.5 * (this.vsizing[v] + this.vsizing[vv]));
            ww += w;
            uu = add(uu, [bcenter[0] * w, bcenter[1] * w, bcenter[2] * w]);
            const dir = normalize(sub(this.points[vv], this.points[v]));
            if (c === 0) {
              t = add(t, dir);
              c += 1;
            } else {
              t = sub(t, dir);
              c += 1;
            }
          }
          if (ww === 0 || c !== 2) {
            update[v] = [0, 0, 0];
            continue;
          }
          uu = [uu[0] / ww, uu[1] / ww, uu[2] / ww];
          uu = sub(uu, this.points[v]);
          t = normalize(t);
          const proj = dot(uu, t);
          u = [t[0] * proj, t[1] * proj, t[2] * proj];
        } else {
          const p = this.minimizeSquaredAreas(v) ?? this.weightedCentroid(v);
          u = sub(p, mesh.position(v));
          const n = this.vnormal[v];
          const d = dot(u, n);
          u = [u[0] - n[0] * d, u[1] - n[1] * d, u[2] - n[2] * d];
        }
        update[v] = u;
      }

      for (const v of mesh.vertices()) {
        if (mesh.isBoundaryVertex(v) || this.vlocked[v]) continue;
        const u = update[v];
        const p = this.points[v];
        this.points[v] = [p[0] + u[0], p[1] + u[1], p[2] + u[2]];
      }

      computeVertexNormals(mesh);
    }

    if (this.useProjection) {
      for (const v of mesh.vertices()) {
        if (!mesh.isBoundaryVertex(v) && !this.vlocked[v]) this.projectToReference(v);
      }
    }
    mesh.removeVertexProperty("v:update-tmp");
  }

  private removeCaps(): void {
    const mesh = this.mesh;
    const aa = Math.cos((170 * Math.PI) / 180);
    for (const e of mesh.edges()) {
      if (this.elocked[e] || !mesh.isFlipOk(e)) continue;
      let h = mesh.edgeHalfedge(e, 0);
      const a = this.points[mesh.toVertex(h)];
      h = mesh.nextHalfedge(h);
      const vb = mesh.toVertex(h);
      const b = this.points[vb];
      h = mesh.edgeHalfedge(e, 1);
      const c = this.points[mesh.toVertex(h)];
      h = mesh.nextHalfedge(h);
      const vd = mesh.toVertex(h);
      const d = this.points[vd];

      const a0 = dot(normalize(sub(a, b)), normalize(sub(c, b)));
      const a1 = dot(normalize(sub(a, d)), normalize(sub(c, d)));
      let amin: number;
      let v: VertexId;
      if (a0 < a1) {
        amin = a0;
        v = vb;
      } else {
        amin = a1;
        v = vd;
      }

      if (amin < aa) {
        if (this.efeature[e] && this.vfeature[v]) continue;
        if (this.efeature[e]) this.points[v] = [0.5 * (a[0] + c[0]), 0.5 * (a[1] + c[1]), 0.5 * (a[2] + c[2])];
        mesh.flip(e);
      }
    }
  }

  private minimizeSquaredAreas(v: VertexId): Point | null {
    const mesh = this.mesh;
    const A = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const b: Point = [0, 0, 0];
    for (const h of mesh.halfedgesAroundVertex(v)) {
      if (mesh.isBoundaryHalfedge(h)) return null;
      const v0 = mesh.toVertex(h);
      const v1 = mesh.toVertex(mesh.nextHalfedge(h));
      const p = this.points[v0];
      const q = this.points[v1];
      const d = sub(q, p);
      const len = norm(d);
      if (len < 1e-20) continue;
      const w = 1 / len;
      const d00 = d[1] * d[1] + d[2] * d[2];
      const d11 = d[0] * d[0] + d[2] * d[2];
      const d22 = d[0] * d[0] + d[1] * d[1];
      const d01 = -d[0] * d[1];
      const d02 = -d[0] * d[2];
      const d12 = -d[1] * d[2];
      A[0] += w * d00; A[1] += w * d01; A[2] += w * d02;
      A[3] += w * d01; A[4] += w * d11; A[5] += w * d12;
      A[6] += w * d02; A[7] += w * d12; A[8] += w * d22;
      // b += w * (D * p)
      const dpx = d00 * p[0] + d01 * p[1] + d02 * p[2];
      const dpy = d01 * p[0] + d11 * p[1] + d12 * p[2];
      const dpz = d02 * p[0] + d12 * p[1] + d22 * p[2];
      b[0] += w * dpx;
      b[1] += w * dpy;
      b[2] += w * dpz;
    }
    return solve3(A, b);
  }

  private weightedCentroid(v: VertexId): Point {
    const mesh = this.mesh;
    let p: Point = [0, 0, 0];
    let ww = 0;
    for (const h of mesh.halfedgesAroundVertex(v)) {
      const v2 = mesh.toVertex(h);
      const v3 = mesh.toVertex(mesh.nextHalfedge(h));
      const bcenter: Point = [
        (this.points[v][0] + this.points[v2][0] + this.points[v3][0]) / 3,
        (this.points[v][1] + this.points[v2][1] + this.points[v3][1]) / 3,
        (this.points[v][2] + this.points[v2][2] + this.points[v3][2]) / 3,
      ];
      let area = norm(cross(sub(this.points[v2], this.points[v]), sub(this.points[v3], this.points[v])));
      if (area === 0) area = 1;
      const s = (this.vsizing[v] + this.vsizing[v2] + this.vsizing[v3]) / 3;
      const w = area / (s * s);
      p = add(p, [bcenter[0] * w, bcenter[1] * w, bcenter[2] * w]);
      ww += w;
    }
    return ww > 0 ? [p[0] / ww, p[1] / ww, p[2] / ww] : [...mesh.position(v)] as Point;
  }
}

// Uniformly remesh `mesh` in place to the target edge length.
export function uniformRemeshing(mesh: HalfedgeMesh, options: UniformRemeshingOptions): void {
  const { edgeLength, iterations = 10, useProjection = true } = options;
  new Remeshing(mesh).uniformRemeshing(edgeLength, iterations, useProjection);
}

// Adaptively remesh `mesh` in place: edge length follows local curvature within [min, max].
export function adaptiveRemeshing(mesh: HalfedgeMesh, options: AdaptiveRemeshingOptions): void {
  const { minEdgeLength, maxEdgeLength, approxError, iterations = 10, useProjection = true } = options;
  new Remeshing(mesh).adaptiveRemeshing(minEdgeLength, maxEdgeLength, approxError, iterations, useProjection);
}

export type { EdgeId };

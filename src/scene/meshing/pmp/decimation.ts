// Incremental greedy mesh decimation via halfedge collapses (QEM + fairness constraints), ported
// from pmp::algorithms/decimation.cpp. Triangle meshes only.
//
// Constraints (all optional): aspect ratio, min edge length, max valence, normal deviation (via a
// per-face normal cone), Hausdorff error (per-face sample tracking), feature vertices/edges, vertex
// selection, and texture seams (h:tex / e:seam). Boundaries are preserved by isCollapseOk.

import type { HalfedgeMesh, VertexId, HalfedgeId, FaceId, EdgeId, Point } from "./halfedge-mesh";
import { sub, dot, norm, triangleAspectRatio, distPointTriangle } from "./geometry";
import { faceNormal, computeFaceNormals } from "./normals";

export type DecimateOptions = {
  targetVertices: number;
  aspectRatio?: number;
  edgeLength?: number;
  maxValence?: number;
  normalDeviation?: number; // degrees
  hausdorffError?: number;
  seamThreshold?: number;
  seamAngleDeviation?: number;
};

// --- Quadric: symmetric 4×4 stored as 10 upper-triangle coefficients ---

class Quadric {
  a = 0; b = 0; c = 0; d = 0;
  e = 0; f = 0; g = 0;
  h = 0; i = 0;
  j = 0;

  clear(): void {
    this.a = this.b = this.c = this.d = 0;
    this.e = this.f = this.g = 0;
    this.h = this.i = 0;
    this.j = 0;
  }

  // Build from a plane through point p with unit normal n: (n, -n·p).
  setPlane(n: Point, p: Point): void {
    const a = n[0];
    const b = n[1];
    const c = n[2];
    const d = -dot(n, p);
    this.a = a * a; this.b = a * b; this.c = a * c; this.d = a * d;
    this.e = b * b; this.f = b * c; this.g = b * d;
    this.h = c * c; this.i = c * d;
    this.j = d * d;
  }

  addInto(q: Quadric): void {
    this.a += q.a; this.b += q.b; this.c += q.c; this.d += q.d;
    this.e += q.e; this.f += q.f; this.g += q.g;
    this.h += q.h; this.i += q.i;
    this.j += q.j;
  }

  // Evaluate pᵀ Q p.
  eval(p: Point): number {
    const x = p[0];
    const y = p[1];
    const z = p[2];
    return (
      this.a * x * x + 2 * this.b * x * y + 2 * this.c * x * z + 2 * this.d * x +
      this.e * y * y + 2 * this.f * y * z + 2 * this.g * y +
      this.h * z * z + 2 * this.i * z +
      this.j
    );
  }
}

// --- NormalCone: a cone of directions, used to bound normal deviation ---

class NormalCone {
  centerNormal: Point;
  angle: number;

  constructor(normalDir: Point = [0, 0, 1], angle = 0) {
    this.centerNormal = [normalDir[0], normalDir[1], normalDir[2]];
    this.angle = angle;
  }

  clone(): NormalCone {
    return new NormalCone(this.centerNormal, this.angle);
  }

  mergeNormal(n: Point): void {
    this.mergeCone(new NormalCone(n));
  }

  mergeCone(nc: NormalCone): void {
    const dp = dot(this.centerNormal, nc.centerNormal);
    if (dp > 0.99999) {
      this.angle = Math.max(this.angle, nc.angle);
    } else if (dp < -0.99999) {
      this.angle = 2 * Math.PI;
    } else {
      const centerAngle = Math.acos(dp);
      const minAngle = Math.min(-this.angle, centerAngle - nc.angle);
      const maxAngle = Math.max(this.angle, centerAngle + nc.angle);
      this.angle = 0.5 * (maxAngle - minAngle);
      const axisAngle = 0.5 * (minAngle + maxAngle);
      const s = Math.sin(centerAngle);
      const w0 = Math.sin(centerAngle - axisAngle) / s;
      const w1 = Math.sin(axisAngle) / s;
      this.centerNormal = [
        this.centerNormal[0] * w0 + nc.centerNormal[0] * w1,
        this.centerNormal[1] * w0 + nc.centerNormal[1] * w1,
        this.centerNormal[2] * w0 + nc.centerNormal[2] * w1,
      ];
    }
  }
}

// --- Binary min-heap of vertices keyed by a priority array, with position tracking ---

class VertexHeap {
  private readonly data: VertexId[] = [];
  constructor(
    private readonly prio: number[],
    private readonly pos: number[],
  ) {}

  empty(): boolean {
    return this.data.length === 0;
  }
  resetPosition(v: VertexId): void {
    this.pos[v] = -1;
  }
  isStored(v: VertexId): boolean {
    return this.pos[v] !== -1;
  }
  private less(a: VertexId, b: VertexId): boolean {
    return this.prio[a] < this.prio[b];
  }
  private setEntry(idx: number, v: VertexId): void {
    this.data[idx] = v;
    this.pos[v] = idx;
  }
  private upheap(idx: number): void {
    const h = this.data[idx];
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!this.less(h, this.data[parent])) break;
      this.setEntry(idx, this.data[parent]);
      idx = parent;
    }
    this.setEntry(idx, h);
  }
  private downheap(idx: number): void {
    const h = this.data[idx];
    const s = this.data.length;
    for (;;) {
      let child = (idx << 1) + 1;
      if (child >= s) break;
      if (child + 1 < s && this.less(this.data[child + 1], this.data[child])) child += 1;
      if (this.less(h, this.data[child])) break;
      this.setEntry(idx, this.data[child]);
      idx = child;
    }
    this.setEntry(idx, h);
  }
  insert(v: VertexId): void {
    this.data.push(v);
    this.pos[v] = this.data.length - 1;
    this.upheap(this.data.length - 1);
  }
  front(): VertexId {
    return this.data[0];
  }
  popFront(): void {
    this.pos[this.data[0]] = -1;
    if (this.data.length > 1) {
      this.setEntry(0, this.data[this.data.length - 1]);
      this.data.pop();
      this.downheap(0);
    } else {
      this.data.pop();
    }
  }
  remove(v: VertexId): void {
    const p = this.pos[v];
    this.pos[v] = -1;
    if (p === this.data.length - 1) {
      this.data.pop();
      return;
    }
    this.setEntry(p, this.data[this.data.length - 1]);
    this.data.pop();
    this.downheap(p);
    this.upheap(p);
  }
  update(v: VertexId): void {
    const p = this.pos[v];
    this.downheap(p);
    this.upheap(p);
  }
}

type Vec2 = [number, number];
function v2sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}
function v2norm(a: Vec2): number {
  return Math.hypot(a[0], a[1]);
}
function v2normalize(a: Vec2): Vec2 {
  const n = v2norm(a);
  return n > 1e-20 ? [a[0] / n, a[1] / n] : [0, 0];
}

// Topology snapshot for a candidate collapse v0 → v1.
type CollapseData = {
  v0v1: HalfedgeId;
  v1v0: HalfedgeId;
  v0: VertexId;
  v1: VertexId;
  fl: FaceId;
  fr: FaceId;
  vl: VertexId;
  vr: VertexId;
  v1vl: HalfedgeId;
  vlv0: HalfedgeId;
  v0vr: HalfedgeId;
  vrv1: HalfedgeId;
};

class Decimation {
  private vquadric: Quadric[];
  private fnormal: Point[];
  private normalCone: NormalCone[] | undefined;
  private facePoints: Point[][] | undefined;
  private textureSeams: boolean[];
  private texcoords: Vec2[] | undefined;

  private vselected: boolean[] | undefined;
  private vfeature: boolean[] | undefined;
  private efeature: boolean[] | undefined;
  private hasSelection = false;
  private hasFeatures = false;

  private aspectRatio = 0;
  private edgeLength = 0;
  private maxValence = 0;
  private normalDeviation = 0; // radians
  private hausdorffError = 0;
  private seamThreshold = 1e-2;
  private seamAngleDeviation = 0.99;

  // priority-queue scratch arrays
  private vpriority: number[] = [];
  private heapPos: number[] = [];
  private vtarget: HalfedgeId[] = [];

  constructor(private readonly mesh: HalfedgeMesh) {
    if (!mesh.isTriangleMesh()) throw new Error("decimate: input is not a triangle mesh");
    this.vquadric = mesh.vertexProperty<Quadric>("v:quadric", () => new Quadric());
    this.textureSeams = mesh.edgeProperty<boolean>("e:seam", () => false);
    this.fnormal = computeFaceNormals(mesh);
    this.texcoords = mesh.getHalfedgeProperty<Vec2>("h:tex");
  }

  initialize(opts: Omit<DecimateOptions, "targetVertices">): void {
    const mesh = this.mesh;
    this.aspectRatio = opts.aspectRatio ?? 0;
    this.maxValence = opts.maxValence ?? 0;
    this.edgeLength = opts.edgeLength ?? 0;
    this.normalDeviation = ((opts.normalDeviation ?? 0) / 180) * Math.PI;
    this.hausdorffError = opts.hausdorffError ?? 0;
    this.seamThreshold = opts.seamThreshold ?? 1e-2;
    this.seamAngleDeviation = (180 - (opts.seamAngleDeviation ?? 1)) / 180;

    this.normalCone = this.normalDeviation > 0
      ? mesh.faceProperty<NormalCone>("f:normalCone", () => new NormalCone())
      : undefined;
    this.facePoints = this.hausdorffError > 0
      ? mesh.faceProperty<Point[]>("f:points", () => [])
      : undefined;

    this.vselected = mesh.getVertexProperty<boolean>("v:selected");
    this.hasSelection = false;
    if (this.vselected) {
      for (const v of mesh.vertices()) if (this.vselected[v]) { this.hasSelection = true; break; }
    }

    this.vfeature = mesh.getVertexProperty<boolean>("v:feature");
    this.efeature = mesh.getEdgeProperty<boolean>("e:feature");
    this.hasFeatures = false;
    if (this.vfeature && this.efeature) {
      for (const v of mesh.vertices()) if (this.vfeature[v]) { this.hasFeatures = true; break; }
    }

    // initialize quadrics
    const tmp = new Quadric();
    for (const v of mesh.vertices()) {
      this.vquadric[v].clear();
      if (!mesh.isIsolated(v)) {
        for (const f of mesh.facesAroundVertex(v)) {
          tmp.setPlane(this.fnormal[f], mesh.position(v));
          this.vquadric[v].addInto(tmp);
        }
      }
    }

    if (this.normalCone) {
      for (const f of mesh.faces()) this.normalCone[f] = new NormalCone(this.fnormal[f]);
    }
    if (this.facePoints) {
      for (const f of mesh.faces()) this.facePoints[f] = [];
    }

    // detect texture seams
    if (this.texcoords) {
      const tc = this.texcoords;
      for (const e of mesh.edges()) {
        const h0 = mesh.edgeHalfedge(e, 0);
        const h1 = mesh.edgeHalfedge(e, 1);
        const h0p = mesh.prevHalfedge(h0);
        const h1p = mesh.prevHalfedge(h1);
        this.textureSeams[e] =
          v2norm(v2sub(tc[h1], tc[h0p])) > this.seamThreshold ||
          v2norm(v2sub(tc[h0], tc[h1p])) > this.seamThreshold;
      }
    }
  }

  decimate(nTarget: number): void {
    const mesh = this.mesh;
    this.vpriority = mesh.vertexProperty<number>("v:prio", () => 0);
    this.heapPos = mesh.vertexProperty<number>("v:heap", () => -1);
    this.vtarget = mesh.vertexProperty<HalfedgeId>("v:target", () => -1);

    const queue = new VertexHeap(this.vpriority, this.heapPos);
    for (const v of mesh.vertices()) {
      queue.resetPosition(v);
      this.enqueueVertex(queue, v);
    }

    let nv = mesh.nVertices();
    while (nv > nTarget && !queue.empty()) {
      const v = queue.front();
      queue.popFront();
      const h = this.vtarget[v];
      if (h < 0) continue;
      const cd = this.collapseData(h);

      if (!mesh.isCollapseOk(h)) continue;
      if (!this.texcoordCheck(cd.v0v1)) continue;

      const oneRing: VertexId[] = [...mesh.verticesAroundVertex(cd.v0)];

      this.preprocessCollapse(cd);
      mesh.collapse(h);
      nv -= 1;
      this.postprocessCollapse(cd);

      for (const vv of oneRing) this.enqueueVertex(queue, vv);
    }

    mesh.garbageCollection();
    mesh.removeVertexProperty("v:prio");
    mesh.removeVertexProperty("v:heap");
    mesh.removeVertexProperty("v:target");
    mesh.removeVertexProperty("v:quadric");
    mesh.removeFaceProperty("f:normalCone");
    mesh.removeFaceProperty("f:points");
  }

  private collapseData(h: HalfedgeId): CollapseData {
    const mesh = this.mesh;
    const v0v1 = h;
    const v1v0 = mesh.opposite(v0v1);
    const cd: CollapseData = {
      v0v1,
      v1v0,
      v0: mesh.toVertex(v1v0),
      v1: mesh.toVertex(v0v1),
      fl: mesh.face(v0v1),
      fr: mesh.face(v1v0),
      vl: -1,
      vr: -1,
      v1vl: -1,
      vlv0: -1,
      v0vr: -1,
      vrv1: -1,
    };
    if (cd.fl >= 0) {
      cd.v1vl = mesh.nextHalfedge(v0v1);
      cd.vlv0 = mesh.nextHalfedge(cd.v1vl);
      cd.vl = mesh.toVertex(cd.v1vl);
    }
    if (cd.fr >= 0) {
      cd.v0vr = mesh.nextHalfedge(v1v0);
      cd.vrv1 = mesh.prevHalfedge(cd.v0vr);
      cd.vr = mesh.fromVertex(cd.vrv1);
    }
    return cd;
  }

  private enqueueVertex(queue: VertexHeap, v: VertexId): void {
    const mesh = this.mesh;
    let minPrio = Infinity;
    let minH = -1;
    for (const h of mesh.halfedgesAroundVertex(v)) {
      const cd = this.collapseData(h);
      if (this.isCollapseLegal(cd)) {
        const prio = this.priority(cd);
        if (prio !== -1 && prio < minPrio) {
          minPrio = prio;
          minH = h;
        }
      }
    }
    if (minH >= 0) {
      this.vpriority[v] = minPrio;
      this.vtarget[v] = minH;
      if (queue.isStored(v)) queue.update(v);
      else queue.insert(v);
    } else {
      if (queue.isStored(v)) queue.remove(v);
      this.vpriority[v] = -1;
      this.vtarget[v] = -1;
    }
  }

  private priority(cd: CollapseData): number {
    const q = new Quadric();
    q.addInto(this.vquadric[cd.v0]);
    q.addInto(this.vquadric[cd.v1]);
    return q.eval(this.mesh.position(cd.v1));
  }

  private isCollapseLegal(cd: CollapseData): boolean {
    const mesh = this.mesh;

    if (this.hasSelection && this.vselected && !this.vselected[cd.v0]) return false;

    if (this.hasFeatures && this.vfeature && this.efeature) {
      if (this.vfeature[cd.v0] && !this.efeature[mesh.edge(cd.v0v1)]) return false;
      if (cd.vl >= 0 && this.efeature[mesh.edge(cd.vlv0)]) return false;
      if (cd.vr >= 0 && this.efeature[mesh.edge(cd.v0vr)]) return false;
    }

    if (mesh.isBoundaryVertex(cd.v0) && !mesh.isBoundaryVertex(cd.v1)) return false;

    // at least 2 incident faces at v0
    if (mesh.cwRotatedHalfedge(mesh.cwRotatedHalfedge(cd.v0v1)) === cd.v0v1) return false;

    if (!mesh.isCollapseOk(cd.v0v1)) return false;
    if (!this.texcoordCheck(cd.v0v1)) return false;

    if (this.maxValence > 0) {
      const val0 = mesh.valenceVertex(cd.v0);
      const val1 = mesh.valenceVertex(cd.v1);
      let val = val0 + val1 - 1;
      if (cd.fl >= 0) val -= 1;
      if (cd.fr >= 0) val -= 1;
      if (val > this.maxValence && !(val < Math.max(val0, val1))) return false;
    }

    const p0: Point = [...mesh.position(cd.v0)];
    const p1: Point = [...mesh.position(cd.v1)];

    if (this.edgeLength) {
      for (const v of mesh.verticesAroundVertex(cd.v0)) {
        if (v !== cd.v1 && v !== cd.vl && v !== cd.vr) {
          if (norm(sub(mesh.position(v), p1)) > this.edgeLength) return false;
        }
      }
    }

    // normal flip / normal cone check (temporarily move v0 to p1)
    if (this.normalDeviation === 0) {
      mesh.setPosition(cd.v0, p1[0], p1[1], p1[2]);
      for (const f of mesh.facesAroundVertex(cd.v0)) {
        if (f !== cd.fl && f !== cd.fr) {
          const n0 = this.fnormal[f];
          const n1 = faceNormal(mesh, f);
          if (dot(n0, n1) < 0) {
            mesh.setPosition(cd.v0, p0[0], p0[1], p0[2]);
            return false;
          }
        }
      }
      mesh.setPosition(cd.v0, p0[0], p0[1], p0[2]);
    } else if (this.normalCone) {
      mesh.setPosition(cd.v0, p1[0], p1[1], p1[2]);
      let fll = -1;
      let frr = -1;
      if (cd.vl >= 0) fll = mesh.face(mesh.opposite(mesh.prevHalfedge(cd.v0v1)));
      if (cd.vr >= 0) frr = mesh.face(mesh.opposite(mesh.nextHalfedge(cd.v1v0)));
      for (const f of mesh.facesAroundVertex(cd.v0)) {
        if (f !== cd.fl && f !== cd.fr) {
          const nc = this.normalCone[f].clone();
          nc.mergeNormal(faceNormal(mesh, f));
          if (f === fll) nc.mergeCone(this.normalCone[cd.fl]);
          if (f === frr) nc.mergeCone(this.normalCone[cd.fr]);
          if (nc.angle > 0.5 * this.normalDeviation) {
            mesh.setPosition(cd.v0, p0[0], p0[1], p0[2]);
            return false;
          }
        }
      }
      mesh.setPosition(cd.v0, p0[0], p0[1], p0[2]);
    }

    if (this.aspectRatio) {
      let ar0 = 0;
      let ar1 = 0;
      for (const f of mesh.facesAroundVertex(cd.v0)) {
        if (f !== cd.fl && f !== cd.fr) {
          mesh.setPosition(cd.v0, p1[0], p1[1], p1[2]);
          ar1 = Math.max(ar1, triangleAspectRatio(mesh, f));
          mesh.setPosition(cd.v0, p0[0], p0[1], p0[2]);
          ar0 = Math.max(ar0, triangleAspectRatio(mesh, f));
        }
      }
      if (ar1 > this.aspectRatio && ar1 > ar0) return false;
    }

    if (this.hausdorffError && this.facePoints) {
      const points: Point[] = [];
      for (const f of mesh.facesAroundVertex(cd.v0)) points.push(...this.facePoints[f]);
      points.push([...mesh.position(cd.v0)]);

      mesh.setPosition(cd.v0, p1[0], p1[1], p1[2]);
      for (const point of points) {
        let ok = false;
        for (const f of mesh.facesAroundVertex(cd.v0)) {
          if (f !== cd.fl && f !== cd.fr) {
            if (this.faceDistance(f, point) < this.hausdorffError) {
              ok = true;
              break;
            }
          }
        }
        if (!ok) {
          mesh.setPosition(cd.v0, p0[0], p0[1], p0[2]);
          return false;
        }
      }
      mesh.setPosition(cd.v0, p0[0], p0[1], p0[2]);
    }

    return true;
  }

  private texcoordCheck(h: HalfedgeId): boolean {
    const mesh = this.mesh;
    const tc = this.texcoords;
    if (!tc) return true;
    const seams = this.textureSeams;

    const o = mesh.opposite(h);
    const v0 = mesh.toVertex(o);

    if (!seams[mesh.edge(h)]) {
      // v0v1 is not a seam: v0 must not sit on a seam
      for (const he of mesh.halfedgesAroundVertex(v0)) {
        if (he === h) continue;
        if (seams[mesh.edge(he)]) return false;
      }
      return true;
    }

    let nrSeam = 0;
    for (const he of mesh.halfedgesAroundVertex(v0)) if (seams[mesh.edge(he)]) nrSeam += 1;
    if (nrSeam > 2) return false;

    const seam1 = h;
    let seam2 = mesh.prevHalfedge(h);
    while (seam2 !== o) {
      if (seams[mesh.edge(seam2)]) {
        const s1 = v2normalize(v2sub(tc[seam1], tc[mesh.prevHalfedge(seam1)]));
        const s2 = v2normalize(v2sub(tc[seam2], tc[mesh.prevHalfedge(seam2)]));
        const oSeam1 = mesh.opposite(seam1);
        const oSeam2 = mesh.opposite(seam2);
        const o1 = v2normalize(v2sub(tc[oSeam1], tc[mesh.prevHalfedge(oSeam1)]));
        const o2 = v2normalize(v2sub(tc[oSeam2], tc[mesh.prevHalfedge(oSeam2)]));
        if (
          s1[0] * s2[0] + s1[1] * s2[1] < this.seamAngleDeviation ||
          o1[0] * o2[0] + o1[1] * o2[1] < this.seamAngleDeviation
        ) {
          return false;
        }
      }
      seam2 = mesh.prevHalfedge(mesh.opposite(seam2));
    }
    return true;
  }

  private preprocessCollapse(cd: CollapseData): void {
    const mesh = this.mesh;
    const tc = this.texcoords;
    if (!tc) return;
    const seams = this.textureSeams;

    const h = cd.v0v1;
    const o = mesh.opposite(h);
    let hit = h;
    let isFirstSide = true;
    const count = mesh.valenceVertex(mesh.toVertex(o)) - 1;
    for (let i = 0; i < count; i += 1) {
      hit = mesh.prevHalfedge(hit);
      if (isFirstSide) tc[hit] = tc[h];
      else tc[hit] = tc[mesh.prevHalfedge(o)];
      if (seams[mesh.edge(hit)]) {
        isFirstSide = false;
        if (mesh.toVertex(mesh.nextHalfedge(h)) === mesh.fromVertex(hit)) {
          const v1v2 = mesh.nextHalfedge(h);
          tc[mesh.opposite(v1v2)] = tc[hit];
          tc[v1v2] = tc[mesh.opposite(hit)];
          seams[mesh.edge(v1v2)] = true;
        }
        if (mesh.toVertex(mesh.nextHalfedge(o)) === mesh.fromVertex(hit)) {
          const v2v1 = mesh.prevHalfedge(o);
          const v0v2 = mesh.opposite(hit);
          tc[mesh.opposite(v2v1)] = tc[v0v2];
          tc[v2v1] = tc[hit];
          seams[mesh.edge(v2v1)] = true;
        }
      }
      hit = mesh.opposite(hit);
    }
  }

  private postprocessCollapse(cd: CollapseData): void {
    const mesh = this.mesh;
    this.vquadric[cd.v1].addInto(this.vquadric[cd.v0]);

    if (this.normalDeviation && this.normalCone) {
      for (const f of mesh.facesAroundVertex(cd.v1)) {
        this.normalCone[f].mergeNormal(faceNormal(mesh, f));
      }
      if (cd.vl >= 0) {
        const f = mesh.face(cd.v1vl);
        if (f >= 0) this.normalCone[f].mergeCone(this.normalCone[cd.fl]);
      }
      if (cd.vr >= 0) {
        const f = mesh.face(cd.vrv1);
        if (f >= 0) this.normalCone[f].mergeCone(this.normalCone[cd.fr]);
      }
    }

    if (this.hausdorffError && this.facePoints) {
      const fp = this.facePoints;
      const points: Point[] = [];
      for (const f of mesh.facesAroundVertex(cd.v1)) {
        points.push(...fp[f]);
        fp[f] = [];
      }
      if (cd.fl >= 0) {
        points.push(...fp[cd.fl]);
        fp[cd.fl] = [];
      }
      if (cd.fr >= 0) {
        points.push(...fp[cd.fr]);
        fp[cd.fr] = [];
      }
      points.push([...mesh.position(cd.v0)]);

      for (const point of points) {
        let dd = Infinity;
        let ff = -1;
        for (const f of mesh.facesAroundVertex(cd.v1)) {
          const d = this.faceDistance(f, point);
          if (d < dd) {
            dd = d;
            ff = f;
          }
        }
        if (ff >= 0) fp[ff].push(point);
      }
    }
  }

  private faceDistance(f: FaceId, p: Point): number {
    const mesh = this.mesh;
    const verts = [...mesh.verticesAroundFace(f)];
    return distPointTriangle(
      p,
      mesh.position(verts[0]),
      mesh.position(verts[1]),
      mesh.position(verts[2]),
    ).distance;
  }
}

// Decimate `mesh` in place down to `targetVertices`, honoring the optional constraints.
export function decimate(mesh: HalfedgeMesh, options: DecimateOptions): void {
  const decimator = new Decimation(mesh);
  decimator.initialize(options);
  decimator.decimate(options.targetVertices);
}

// re-exported for tests / external sizing helpers
export type { EdgeId };

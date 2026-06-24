// A half-edge surface mesh, ported from the PMP Library's pmp::SurfaceMesh
// (external/pmp-library/src/pmp/surface_mesh.{h,cpp}). Supports 2-manifold polygon meshes with
// boundary. Topology lives in numeric-handle property arrays; algorithms (subdivision, smoothing,
// decimation, remeshing) build on the operators here. Three.js geometry is only an import/export
// boundary (see geometry-adapter.ts).
//
// Handle convention: handles are plain indices; INVALID (-1) is the null handle. Edge e owns
// halfedges 2e and 2e+1, so opposite(h) = h ^ 1 and edge(h) = h >> 1.

export type VertexId = number;
export type HalfedgeId = number;
export type EdgeId = number;
export type FaceId = number;

export const INVALID = -1;

export type Point = [number, number, number];

type DefaultFactory = () => unknown;

// A column store over one entity type: every registered property is a parallel array kept the same
// length as the entity count. Mirrors pmp::PropertyContainer — push_back/swap/resize touch every
// column at once, which is what garbage collection relies on.
class PropertyContainer {
  size = 0;
  private readonly arrays = new Map<string, unknown[]>();
  private readonly defaults = new Map<string, DefaultFactory>();

  has(name: string): boolean {
    return this.arrays.has(name);
  }

  add<T>(name: string, def: () => T): T[] {
    const existing = this.arrays.get(name);
    if (existing) return existing as T[];
    const arr: T[] = new Array(this.size);
    for (let i = 0; i < this.size; i += 1) arr[i] = def();
    this.arrays.set(name, arr as unknown[]);
    this.defaults.set(name, def as DefaultFactory);
    return arr;
  }

  get<T>(name: string): T[] | undefined {
    return this.arrays.get(name) as T[] | undefined;
  }

  remove(name: string): void {
    this.arrays.delete(name);
    this.defaults.delete(name);
  }

  names(): string[] {
    return [...this.arrays.keys()];
  }

  pushBack(): number {
    for (const [name, arr] of this.arrays) arr.push(this.defaults.get(name)!());
    return this.size++;
  }

  swap(i0: number, i1: number): void {
    if (i0 === i1) return;
    for (const arr of this.arrays.values()) {
      const tmp = arr[i0];
      arr[i0] = arr[i1];
      arr[i1] = tmp;
    }
  }

  resize(n: number): void {
    for (const arr of this.arrays.values()) arr.length = n;
    this.size = n;
  }

  clear(): void {
    this.arrays.clear();
    this.defaults.clear();
    this.size = 0;
  }
}

export class TopologyError extends Error {}

export class HalfedgeMesh {
  private readonly vprops = new PropertyContainer();
  private readonly hprops = new PropertyContainer();
  private readonly eprops = new PropertyContainer();
  private readonly fprops = new PropertyContainer();

  // Cached core connectivity columns. The arrays are mutated in place (push/length/swap), so these
  // references stay valid for the mesh's lifetime.
  private vpoint: Point[];
  private vh: HalfedgeId[]; // outgoing halfedge per vertex (boundary halfedge for boundary vertices)
  private vdeleted: boolean[];
  private hvertex: VertexId[]; // vertex the halfedge points to
  private hface: FaceId[];
  private hnext: HalfedgeId[];
  private hprev: HalfedgeId[];
  private edeleted: boolean[];
  private fh: HalfedgeId[]; // a halfedge of the face
  private fdeleted: boolean[];

  private deletedVertices = 0;
  private deletedEdges = 0;
  private deletedFaces = 0;
  private garbage = false;

  constructor() {
    this.vpoint = this.vprops.add<Point>("v:point", () => [0, 0, 0]);
    this.vh = this.vprops.add<HalfedgeId>("v:halfedge", () => INVALID);
    this.vdeleted = this.vprops.add<boolean>("v:deleted", () => false);
    this.hvertex = this.hprops.add<VertexId>("h:vertex", () => INVALID);
    this.hface = this.hprops.add<FaceId>("h:face", () => INVALID);
    this.hnext = this.hprops.add<HalfedgeId>("h:next", () => INVALID);
    this.hprev = this.hprops.add<HalfedgeId>("h:prev", () => INVALID);
    this.edeleted = this.eprops.add<boolean>("e:deleted", () => false);
    this.fh = this.fprops.add<HalfedgeId>("f:halfedge", () => INVALID);
    this.fdeleted = this.fprops.add<boolean>("f:deleted", () => false);
  }

  // --- Custom property stores (v:normal, v:feature, e:feature, h:tex, e:seam, f:normal, …) ---

  vertexProperty<T>(name: string, def: () => T): T[] {
    return this.vprops.add(name, def);
  }
  halfedgeProperty<T>(name: string, def: () => T): T[] {
    return this.hprops.add(name, def);
  }
  edgeProperty<T>(name: string, def: () => T): T[] {
    return this.eprops.add(name, def);
  }
  faceProperty<T>(name: string, def: () => T): T[] {
    return this.fprops.add(name, def);
  }
  getVertexProperty<T>(name: string): T[] | undefined {
    return this.vprops.get<T>(name);
  }
  getHalfedgeProperty<T>(name: string): T[] | undefined {
    return this.hprops.get<T>(name);
  }
  getEdgeProperty<T>(name: string): T[] | undefined {
    return this.eprops.get<T>(name);
  }
  getFaceProperty<T>(name: string): T[] | undefined {
    return this.fprops.get<T>(name);
  }
  removeVertexProperty(name: string): void {
    this.vprops.remove(name);
  }
  removeHalfedgeProperty(name: string): void {
    this.hprops.remove(name);
  }
  removeEdgeProperty(name: string): void {
    this.eprops.remove(name);
  }
  removeFaceProperty(name: string): void {
    this.fprops.remove(name);
  }

  // --- Sizes ---

  verticesSize(): number {
    return this.vprops.size;
  }
  halfedgesSize(): number {
    return this.hprops.size;
  }
  edgesSize(): number {
    return this.eprops.size;
  }
  facesSize(): number {
    return this.fprops.size;
  }
  nVertices(): number {
    return this.vprops.size - this.deletedVertices;
  }
  nHalfedges(): number {
    return this.hprops.size - 2 * this.deletedEdges;
  }
  nEdges(): number {
    return this.eprops.size - this.deletedEdges;
  }
  nFaces(): number {
    return this.fprops.size - this.deletedFaces;
  }
  isEmpty(): boolean {
    return this.nVertices() === 0;
  }
  hasGarbage(): boolean {
    return this.garbage;
  }

  // --- Handle arithmetic ---

  opposite(h: HalfedgeId): HalfedgeId {
    return h ^ 1;
  }
  edge(h: HalfedgeId): EdgeId {
    return h >> 1;
  }
  edgeHalfedge(e: EdgeId, i: 0 | 1): HalfedgeId {
    return (e << 1) + i;
  }
  ccwRotatedHalfedge(h: HalfedgeId): HalfedgeId {
    return this.opposite(this.hprev[h]);
  }
  cwRotatedHalfedge(h: HalfedgeId): HalfedgeId {
    return this.hnext[this.opposite(h)];
  }

  // --- Connectivity accessors ---

  toVertex(h: HalfedgeId): VertexId {
    return this.hvertex[h];
  }
  fromVertex(h: HalfedgeId): VertexId {
    return this.hvertex[this.opposite(h)];
  }
  setVertex(h: HalfedgeId, v: VertexId): void {
    this.hvertex[h] = v;
  }
  halfedgeOfVertex(v: VertexId): HalfedgeId {
    return this.vh[v];
  }
  setHalfedgeOfVertex(v: VertexId, h: HalfedgeId): void {
    this.vh[v] = h;
  }
  face(h: HalfedgeId): FaceId {
    return this.hface[h];
  }
  setFace(h: HalfedgeId, f: FaceId): void {
    this.hface[h] = f;
  }
  nextHalfedge(h: HalfedgeId): HalfedgeId {
    return this.hnext[h];
  }
  prevHalfedge(h: HalfedgeId): HalfedgeId {
    return this.hprev[h];
  }
  setNextHalfedge(h: HalfedgeId, nh: HalfedgeId): void {
    this.hnext[h] = nh;
    this.hprev[nh] = h;
  }
  setPrevHalfedge(h: HalfedgeId, ph: HalfedgeId): void {
    this.hprev[h] = ph;
    this.hnext[ph] = h;
  }
  halfedgeOfFace(f: FaceId): HalfedgeId {
    return this.fh[f];
  }
  setHalfedgeOfFace(f: FaceId, h: HalfedgeId): void {
    this.fh[f] = h;
  }
  edgeVertex(e: EdgeId, i: 0 | 1): VertexId {
    return this.toVertex(this.edgeHalfedge(e, i));
  }

  // --- Boundary / validity ---

  isValidVertex(v: VertexId): boolean {
    return v >= 0 && v < this.vprops.size;
  }
  isValidHalfedge(h: HalfedgeId): boolean {
    return h >= 0 && h < this.hprops.size;
  }
  isValidEdge(e: EdgeId): boolean {
    return e >= 0 && e < this.eprops.size;
  }
  isValidFace(f: FaceId): boolean {
    return f >= 0 && f < this.fprops.size;
  }
  isBoundaryHalfedge(h: HalfedgeId): boolean {
    return this.hface[h] < 0;
  }
  isBoundaryVertex(v: VertexId): boolean {
    const h = this.vh[v];
    return !(h >= 0 && this.hface[h] >= 0);
  }
  isBoundaryEdge(e: EdgeId): boolean {
    return (
      this.isBoundaryHalfedge(this.edgeHalfedge(e, 0)) ||
      this.isBoundaryHalfedge(this.edgeHalfedge(e, 1))
    );
  }
  isBoundaryFace(f: FaceId): boolean {
    const hh = this.fh[f];
    let h = hh;
    do {
      if (this.isBoundaryHalfedge(this.opposite(h))) return true;
      h = this.hnext[h];
    } while (h !== hh);
    return false;
  }
  isIsolated(v: VertexId): boolean {
    return this.vh[v] < 0;
  }
  isDeletedVertex(v: VertexId): boolean {
    return this.vdeleted[v];
  }
  isDeletedEdge(e: EdgeId): boolean {
    return this.edeleted[e];
  }
  isDeletedFace(f: FaceId): boolean {
    return this.fdeleted[f];
  }

  isManifoldVertex(v: VertexId): boolean {
    let n = 0;
    for (const h of this.halfedgesAroundVertex(v)) {
      if (this.isBoundaryHalfedge(h)) n += 1;
    }
    return n < 2;
  }

  // --- Geometry ---

  position(v: VertexId): Point {
    return this.vpoint[v];
  }
  setPosition(v: VertexId, x: number, y: number, z: number): void {
    const p = this.vpoint[v];
    p[0] = x;
    p[1] = y;
    p[2] = z;
  }

  // --- Allocation ---

  private newVertex(): VertexId {
    return this.vprops.pushBack();
  }

  private newEdge(start?: VertexId, end?: VertexId): HalfedgeId {
    this.eprops.pushBack();
    const h0 = this.hprops.pushBack();
    const h1 = this.hprops.pushBack();
    if (start !== undefined && end !== undefined) {
      this.hvertex[h0] = end;
      this.hvertex[h1] = start;
    }
    return h0;
  }

  private newFace(): FaceId {
    return this.fprops.pushBack();
  }

  addVertex(x: number, y: number, z: number): VertexId {
    const v = this.newVertex();
    this.setPosition(v, x, y, z);
    return v;
  }

  // --- Iteration ---

  *vertices(): Iterable<VertexId> {
    const n = this.vprops.size;
    for (let v = 0; v < n; v += 1) if (!this.vdeleted[v]) yield v;
  }
  *halfedges(): Iterable<HalfedgeId> {
    const n = this.hprops.size;
    for (let h = 0; h < n; h += 1) if (!this.edeleted[this.edge(h)]) yield h;
  }
  *edges(): Iterable<EdgeId> {
    const n = this.eprops.size;
    for (let e = 0; e < n; e += 1) if (!this.edeleted[e]) yield e;
  }
  *faces(): Iterable<FaceId> {
    const n = this.fprops.size;
    for (let f = 0; f < n; f += 1) if (!this.fdeleted[f]) yield f;
  }

  *halfedgesAroundVertex(v: VertexId): Iterable<HalfedgeId> {
    const start = this.vh[v];
    if (start < 0) return;
    let h = start;
    do {
      yield h;
      h = this.ccwRotatedHalfedge(h);
    } while (h !== start);
  }
  *verticesAroundVertex(v: VertexId): Iterable<VertexId> {
    for (const h of this.halfedgesAroundVertex(v)) yield this.hvertex[h];
  }
  *facesAroundVertex(v: VertexId): Iterable<FaceId> {
    for (const h of this.halfedgesAroundVertex(v)) {
      if (!this.isBoundaryHalfedge(h)) yield this.hface[h];
    }
  }
  *halfedgesAroundFace(f: FaceId): Iterable<HalfedgeId> {
    const start = this.fh[f];
    let h = start;
    do {
      yield h;
      h = this.hnext[h];
    } while (h !== start);
  }
  *verticesAroundFace(f: FaceId): Iterable<VertexId> {
    for (const h of this.halfedgesAroundFace(f)) yield this.hvertex[h];
  }

  valenceVertex(v: VertexId): number {
    let n = 0;
    for (const _ of this.verticesAroundVertex(v)) n += 1;
    return n;
  }
  valenceFace(f: FaceId): number {
    let n = 0;
    for (const _ of this.verticesAroundFace(f)) n += 1;
    return n;
  }

  findHalfedge(start: VertexId, end: VertexId): HalfedgeId {
    let h = this.vh[start];
    if (h < 0) return INVALID;
    const hh = h;
    do {
      if (this.hvertex[h] === end) return h;
      h = this.cwRotatedHalfedge(h);
    } while (h !== hh);
    return INVALID;
  }
  findEdge(a: VertexId, b: VertexId): EdgeId {
    const h = this.findHalfedge(a, b);
    return h >= 0 ? this.edge(h) : INVALID;
  }

  isTriangleMesh(): boolean {
    for (const f of this.faces()) if (this.valenceFace(f) !== 3) return false;
    return true;
  }
  isQuadMesh(): boolean {
    for (const f of this.faces()) if (this.valenceFace(f) !== 4) return false;
    return true;
  }

  private adjustOutgoingHalfedge(v: VertexId): void {
    let h = this.vh[v];
    const hh = h;
    if (h < 0) return;
    do {
      if (this.isBoundaryHalfedge(h)) {
        this.vh[v] = h;
        return;
      }
      h = this.cwRotatedHalfedge(h);
    } while (h !== hh);
  }

  // --- add_face (the connectivity workhorse) ---

  addFace(vertices: VertexId[]): FaceId {
    const n = vertices.length;
    if (n < 3) throw new TopologyError("addFace: need at least 3 vertices");

    const halfedges: HalfedgeId[] = new Array(n).fill(INVALID);
    const isNew: boolean[] = new Array(n).fill(false);
    const needsAdjust: boolean[] = new Array(n).fill(false);
    const nextCache: Array<[HalfedgeId, HalfedgeId]> = [];

    // test for topological errors
    for (let i = 0, ii = 1; i < n; i += 1, ii = (i + 1) % n) {
      if (!this.isBoundaryVertex(vertices[i])) {
        throw new TopologyError("addFace: complex vertex");
      }
      halfedges[i] = this.findHalfedge(vertices[i], vertices[ii]);
      isNew[i] = halfedges[i] < 0;
      if (!isNew[i] && !this.isBoundaryHalfedge(halfedges[i])) {
        throw new TopologyError("addFace: complex edge");
      }
    }

    // re-link patches if necessary
    for (let i = 0, ii = 1; i < n; i += 1, ii = (i + 1) % n) {
      if (!isNew[i] && !isNew[ii]) {
        const innerPrev = halfedges[i];
        const innerNext = halfedges[ii];
        if (this.hnext[innerPrev] !== innerNext) {
          // relink a whole patch: search a free gap between boundaryPrev and boundaryNext
          const outerPrev = this.opposite(innerNext);
          const outerNext = this.opposite(innerPrev);
          void outerPrev;
          void outerNext;
          let boundaryPrev = this.opposite(innerNext);
          do {
            boundaryPrev = this.opposite(this.hnext[boundaryPrev]);
          } while (!this.isBoundaryHalfedge(boundaryPrev) || boundaryPrev === innerPrev);
          const boundaryNext = this.hnext[boundaryPrev];

          if (boundaryNext === innerNext) {
            throw new TopologyError("addFace: patch re-linking failed");
          }

          const patchStart = this.hnext[innerPrev];
          const patchEnd = this.hprev[innerNext];
          nextCache.push([boundaryPrev, patchStart]);
          nextCache.push([patchEnd, boundaryNext]);
          nextCache.push([innerPrev, innerNext]);
        }
      }
    }

    // create missing edges
    for (let i = 0, ii = 1; i < n; i += 1, ii = (i + 1) % n) {
      if (isNew[i]) halfedges[i] = this.newEdge(vertices[i], vertices[ii]);
    }

    // create the face
    const f = this.newFace();
    this.fh[f] = halfedges[n - 1];

    // setup halfedges
    for (let i = 0, ii = 1; i < n; i += 1, ii = (i + 1) % n) {
      const v = vertices[ii];
      const innerPrev = halfedges[i];
      const innerNext = halfedges[ii];

      let id = 0;
      if (isNew[i]) id |= 1;
      if (isNew[ii]) id |= 2;

      if (id) {
        const outerPrev = this.opposite(innerNext);
        const outerNext = this.opposite(innerPrev);

        switch (id) {
          case 1: {
            // prev is new, next is old
            const boundaryPrev = this.hprev[innerNext];
            nextCache.push([boundaryPrev, outerNext]);
            this.vh[v] = outerNext;
            break;
          }
          case 2: {
            // next is new, prev is old
            const boundaryNext = this.hnext[innerPrev];
            nextCache.push([outerPrev, boundaryNext]);
            this.vh[v] = boundaryNext;
            break;
          }
          case 3: {
            // both are new
            if (this.vh[v] < 0) {
              this.vh[v] = outerNext;
              nextCache.push([outerPrev, outerNext]);
            } else {
              const boundaryNext = this.vh[v];
              const boundaryPrev = this.hprev[boundaryNext];
              nextCache.push([boundaryPrev, outerNext]);
              nextCache.push([outerPrev, boundaryNext]);
            }
            break;
          }
        }
        nextCache.push([innerPrev, innerNext]);
      } else {
        needsAdjust[ii] = this.vh[v] === innerNext;
      }

      this.hface[halfedges[i]] = f;
    }

    // process next halfedge cache
    for (const [first, second] of nextCache) this.setNextHalfedge(first, second);

    // adjust vertices' halfedge handle
    for (let i = 0; i < n; i += 1) {
      if (needsAdjust[i]) this.adjustOutgoingHalfedge(vertices[i]);
    }

    return f;
  }

  addTriangle(v0: VertexId, v1: VertexId, v2: VertexId): FaceId {
    return this.addFace([v0, v1, v2]);
  }
  addQuad(v0: VertexId, v1: VertexId, v2: VertexId, v3: VertexId): FaceId {
    return this.addFace([v0, v1, v2, v3]);
  }

  // --- Higher-level topology ---

  // Split edge e by inserting v at p, without adding any other edges/faces. Returns the halfedge
  // pointing from the original target to v.
  insertVertexOnEdge(e: EdgeId, v: VertexId): HalfedgeId {
    return this.insertVertexOnHalfedge(this.edgeHalfedge(e, 0), v);
  }

  insertVertexOnHalfedge(h0: HalfedgeId, v: VertexId): HalfedgeId {
    const h2 = this.hnext[h0];
    const o0 = this.opposite(h0);
    const o2 = this.hprev[o0];
    const v2 = this.hvertex[h0];
    const fh = this.hface[h0];
    const fo = this.hface[o0];

    const h1 = this.newEdge(v, v2);
    const o1 = this.opposite(h1);

    this.setNextHalfedge(h1, h2);
    this.setNextHalfedge(h0, h1);
    this.hvertex[h0] = v;
    this.hvertex[h1] = v2;
    this.hface[h1] = fh;

    this.setNextHalfedge(o1, o0);
    this.setNextHalfedge(o2, o1);
    this.hvertex[o1] = v;
    this.hface[o1] = fo;

    this.vh[v2] = o1;
    this.adjustOutgoingHalfedge(v2);
    this.vh[v] = h1;
    this.adjustOutgoingHalfedge(v);

    if (fh >= 0) this.fh[fh] = h0;
    if (fo >= 0) this.fh[fo] = o1;

    return o1;
  }

  // Insert an edge between the to-vertices of h0 and h1 (must share a face). Returns new halfedge.
  insertEdge(h0: HalfedgeId, h1: HalfedgeId): HalfedgeId {
    const v0 = this.hvertex[h0];
    const v1 = this.hvertex[h1];
    const h2 = this.hnext[h0];
    const h3 = this.hnext[h1];

    const h4 = this.newEdge(v0, v1);
    const h5 = this.opposite(h4);

    const f0 = this.hface[h0];
    const f1 = this.newFace();

    this.fh[f0] = h0;
    this.fh[f1] = h1;

    this.setNextHalfedge(h0, h4);
    this.setNextHalfedge(h4, h3);
    this.hface[h4] = f0;

    this.setNextHalfedge(h1, h5);
    this.setNextHalfedge(h5, h2);
    let h = h2;
    do {
      this.hface[h] = f1;
      h = this.hnext[h];
    } while (h !== h2);

    return h4;
  }

  // Split face f into a triangle fan around v (1→k split). f stays valid as one triangle.
  splitFace(f: FaceId, v: VertexId): void {
    const hend = this.fh[f];
    let h = this.hnext[hend];

    let hold = this.newEdge(this.hvertex[hend], v);
    this.setNextHalfedge(hend, hold);
    this.hface[hold] = f;
    hold = this.opposite(hold);

    while (h !== hend) {
      const hnext = this.hnext[h];

      const fnew = this.newFace();
      this.fh[fnew] = h;

      const hnew = this.newEdge(this.hvertex[h], v);
      this.setNextHalfedge(hnew, hold);
      this.setNextHalfedge(hold, h);
      this.setNextHalfedge(h, hnew);

      this.hface[hnew] = fnew;
      this.hface[hold] = fnew;
      this.hface[h] = fnew;

      hold = this.opposite(hnew);
      h = hnext;
    }

    this.setNextHalfedge(hold, hend);
    this.setNextHalfedge(this.hnext[hend], hold);
    this.hface[hold] = f;
    this.vh[v] = hold;
  }

  splitFaceAt(f: FaceId, x: number, y: number, z: number): VertexId {
    const v = this.addVertex(x, y, z);
    this.splitFace(f, v);
    return v;
  }

  // Split edge e with vertex v, connecting v to the opposite vertices of the incident triangles.
  // Triangle meshes only. Returns the halfedge pointing to v created from e.
  splitEdge(e: EdgeId, v: VertexId): HalfedgeId {
    const h0 = this.edgeHalfedge(e, 0);
    const o0 = this.edgeHalfedge(e, 1);
    const v2 = this.hvertex[o0];

    const e1 = this.newEdge(v, v2);
    const t1 = this.opposite(e1);

    const f0 = this.hface[h0];
    const f3 = this.hface[o0];

    this.vh[v] = h0;
    this.hvertex[o0] = v;

    if (!this.isBoundaryHalfedge(h0)) {
      const h1 = this.hnext[h0];
      const h2 = this.hnext[h1];
      const v1 = this.hvertex[h1];

      const e0 = this.newEdge(v, v1);
      const t0 = this.opposite(e0);

      const f1 = this.newFace();
      this.fh[f0] = h0;
      this.fh[f1] = h2;

      this.hface[h1] = f0;
      this.hface[t0] = f0;
      this.hface[h0] = f0;

      this.hface[h2] = f1;
      this.hface[t1] = f1;
      this.hface[e0] = f1;

      this.setNextHalfedge(h0, h1);
      this.setNextHalfedge(h1, t0);
      this.setNextHalfedge(t0, h0);

      this.setNextHalfedge(e0, h2);
      this.setNextHalfedge(h2, t1);
      this.setNextHalfedge(t1, e0);
    } else {
      this.setNextHalfedge(this.hprev[h0], t1);
      this.setNextHalfedge(t1, h0);
    }

    if (!this.isBoundaryHalfedge(o0)) {
      const o1 = this.hnext[o0];
      const o2 = this.hnext[o1];
      const v3 = this.hvertex[o1];

      const e2 = this.newEdge(v, v3);
      const t2 = this.opposite(e2);

      const f2 = this.newFace();
      this.fh[f2] = o1;
      this.fh[f3] = o0;

      this.hface[o1] = f2;
      this.hface[t2] = f2;
      this.hface[e1] = f2;

      this.hface[o2] = f3;
      this.hface[o0] = f3;
      this.hface[e2] = f3;

      this.setNextHalfedge(e1, o1);
      this.setNextHalfedge(o1, t2);
      this.setNextHalfedge(t2, e1);

      this.setNextHalfedge(o0, e2);
      this.setNextHalfedge(e2, o2);
      this.setNextHalfedge(o2, o0);
    } else {
      this.setNextHalfedge(e1, this.hnext[o0]);
      this.setNextHalfedge(o0, e1);
      this.vh[v] = e1;
    }

    if (this.vh[v2] === h0) this.vh[v2] = t1;

    return t1;
  }

  splitEdgeAt(e: EdgeId, x: number, y: number, z: number): HalfedgeId {
    return this.splitEdge(e, this.addVertex(x, y, z));
  }

  isFlipOk(e: EdgeId): boolean {
    if (this.isBoundaryEdge(e)) return false;
    const h0 = this.edgeHalfedge(e, 0);
    const h1 = this.edgeHalfedge(e, 1);
    const v0 = this.hvertex[this.hnext[h0]];
    const v1 = this.hvertex[this.hnext[h1]];
    if (v0 === v1) return false;
    if (this.findHalfedge(v0, v1) >= 0) return false;
    return true;
  }

  flip(e: EdgeId): void {
    const a0 = this.edgeHalfedge(e, 0);
    const b0 = this.edgeHalfedge(e, 1);

    const a1 = this.hnext[a0];
    const a2 = this.hnext[a1];
    const b1 = this.hnext[b0];
    const b2 = this.hnext[b1];

    const va0 = this.hvertex[a0];
    const va1 = this.hvertex[a1];
    const vb0 = this.hvertex[b0];
    const vb1 = this.hvertex[b1];

    const fa = this.hface[a0];
    const fb = this.hface[b0];

    this.hvertex[a0] = va1;
    this.hvertex[b0] = vb1;

    this.setNextHalfedge(a0, a2);
    this.setNextHalfedge(a2, b1);
    this.setNextHalfedge(b1, a0);

    this.setNextHalfedge(b0, b2);
    this.setNextHalfedge(b2, a1);
    this.setNextHalfedge(a1, b0);

    this.hface[a1] = fb;
    this.hface[b1] = fa;

    this.fh[fa] = a0;
    this.fh[fb] = b0;

    if (this.vh[va0] === b0) this.vh[va0] = a1;
    if (this.vh[vb0] === a0) this.vh[vb0] = b1;
  }

  isCollapseOk(v0v1: HalfedgeId): boolean {
    const v1v0 = this.opposite(v0v1);
    const v0 = this.hvertex[v1v0];
    const v1 = this.hvertex[v0v1];
    let vl = INVALID;
    let vr = INVALID;
    let h1: HalfedgeId;
    let h2: HalfedgeId;

    if (!this.isBoundaryHalfedge(v0v1)) {
      vl = this.hvertex[this.hnext[v0v1]];
      h1 = this.hnext[v0v1];
      h2 = this.hnext[h1];
      if (
        this.isBoundaryHalfedge(this.opposite(h1)) &&
        this.isBoundaryHalfedge(this.opposite(h2))
      ) {
        return false;
      }
    }

    if (!this.isBoundaryHalfedge(v1v0)) {
      vr = this.hvertex[this.hnext[v1v0]];
      h1 = this.hnext[v1v0];
      h2 = this.hnext[h1];
      if (
        this.isBoundaryHalfedge(this.opposite(h1)) &&
        this.isBoundaryHalfedge(this.opposite(h2))
      ) {
        return false;
      }
    }

    if (vl === vr) return false;

    if (
      this.isBoundaryVertex(v0) &&
      this.isBoundaryVertex(v1) &&
      !this.isBoundaryHalfedge(v0v1) &&
      !this.isBoundaryHalfedge(v1v0)
    ) {
      return false;
    }

    for (const vv of this.verticesAroundVertex(v0)) {
      if (vv !== v1 && vv !== vl && vv !== vr) {
        if (this.findHalfedge(vv, v1) >= 0) return false;
      }
    }

    return true;
  }

  collapse(h: HalfedgeId): void {
    const h0 = h;
    const h1 = this.hprev[h0];
    const o0 = this.opposite(h0);
    const o1 = this.hnext[o0];

    this.removeEdgeHelper(h0);

    if (this.hnext[this.hnext[h1]] === h1) this.removeLoopHelper(h1);
    if (this.hnext[this.hnext[o1]] === o1) this.removeLoopHelper(o1);
  }

  private removeEdgeHelper(h: HalfedgeId): void {
    const hn = this.hnext[h];
    const hp = this.hprev[h];
    const o = this.opposite(h);
    const on = this.hnext[o];
    const op = this.hprev[o];
    const fh = this.hface[h];
    const fo = this.hface[o];
    const vh = this.hvertex[h];
    const vo = this.hvertex[o];

    // move all halfedges pointing to vo over to vh
    for (const hc of this.halfedgesAroundVertex(vo)) {
      this.hvertex[this.opposite(hc)] = vh;
    }

    this.setNextHalfedge(hp, hn);
    this.setNextHalfedge(op, on);

    if (fh >= 0) this.fh[fh] = hn;
    if (fo >= 0) this.fh[fo] = on;

    if (this.vh[vh] === o) this.vh[vh] = hn;
    this.adjustOutgoingHalfedge(vh);
    this.vh[vo] = INVALID;

    this.vdeleted[vo] = true;
    this.deletedVertices += 1;
    this.edeleted[this.edge(h)] = true;
    this.deletedEdges += 1;
    this.garbage = true;
  }

  private removeLoopHelper(h: HalfedgeId): void {
    const h0 = h;
    const h1 = this.hnext[h0];
    const o0 = this.opposite(h0);
    const o1 = this.opposite(h1);
    const v0 = this.hvertex[h0];
    const v1 = this.hvertex[h1];
    const fh = this.hface[h0];
    const fo = this.hface[o0];

    this.setNextHalfedge(h1, this.hnext[o0]);
    this.setNextHalfedge(this.hprev[o0], h1);

    this.hface[h1] = fo;

    this.vh[v0] = h1;
    this.adjustOutgoingHalfedge(v0);
    this.vh[v1] = o1;
    this.adjustOutgoingHalfedge(v1);

    if (fo >= 0 && this.fh[fo] === o0) this.fh[fo] = h1;

    if (fh >= 0) {
      this.fdeleted[fh] = true;
      this.deletedFaces += 1;
    }
    this.edeleted[this.edge(h)] = true;
    this.deletedEdges += 1;
    this.garbage = true;
  }

  isRemovalOk(e: EdgeId): boolean {
    const h0 = this.edgeHalfedge(e, 0);
    const h1 = this.edgeHalfedge(e, 1);
    const v0 = this.hvertex[h0];
    const v1 = this.hvertex[h1];
    const f0 = this.hface[h0];
    const f1 = this.hface[h1];
    if (f0 < 0 || f1 < 0) return false;
    if (f0 === f1) return false;
    for (const v of this.verticesAroundFace(f0)) {
      if (v !== v0 && v !== v1) {
        for (const f of this.facesAroundVertex(v)) if (f === f1) return false;
      }
    }
    return true;
  }

  removeEdge(e: EdgeId): boolean {
    if (!this.isRemovalOk(e)) return false;

    const h0 = this.edgeHalfedge(e, 0);
    const h1 = this.edgeHalfedge(e, 1);
    const v0 = this.hvertex[h0];
    const v1 = this.hvertex[h1];
    const f0 = this.hface[h0];
    const f1 = this.hface[h1];

    const h0Prev = this.hprev[h0];
    const h0Next = this.hnext[h0];
    const h1Prev = this.hprev[h1];
    const h1Next = this.hnext[h1];

    if (this.vh[v0] === h1) this.vh[v0] = h0Next;
    if (this.vh[v1] === h0) this.vh[v1] = h1Next;

    for (const h of this.halfedgesAroundFace(f0)) this.hface[h] = f1;

    this.setNextHalfedge(h1Prev, h0Next);
    this.setNextHalfedge(h0Prev, h1Next);

    if (this.fh[f1] === h1) this.fh[f1] = h1Next;

    this.fdeleted[f0] = true;
    this.deletedFaces += 1;
    this.edeleted[e] = true;
    this.deletedEdges += 1;
    this.garbage = true;
    return true;
  }

  deleteFace(f: FaceId): void {
    if (this.fdeleted[f]) return;

    this.fdeleted[f] = true;
    this.deletedFaces += 1;

    const faceHalfedges: HalfedgeId[] = [];
    for (const hc of this.halfedgesAroundFace(f)) faceHalfedges.push(hc);

    const deletedEdges: EdgeId[] = [];
    const verts: VertexId[] = [];

    for (const hc of faceHalfedges) {
      this.hface[hc] = INVALID;
      if (this.isBoundaryHalfedge(this.opposite(hc))) deletedEdges.push(this.edge(hc));
      verts.push(this.hvertex[hc]);
    }

    if (deletedEdges.length > 0) {
      for (const e of deletedEdges) {
        const h0 = this.edgeHalfedge(e, 0);
        const v0 = this.hvertex[h0];
        const next0 = this.hnext[h0];
        const prev0 = this.hprev[h0];

        const h1 = this.edgeHalfedge(e, 1);
        const v1 = this.hvertex[h1];
        const next1 = this.hnext[h1];
        const prev1 = this.hprev[h1];

        this.setNextHalfedge(prev0, next1);
        this.setNextHalfedge(prev1, next0);

        if (!this.edeleted[e]) {
          this.edeleted[e] = true;
          this.deletedEdges += 1;
        }

        if (this.vh[v0] === h1) {
          if (next0 === h1) {
            if (!this.vdeleted[v0]) {
              this.vdeleted[v0] = true;
              this.deletedVertices += 1;
            }
          } else {
            this.vh[v0] = next0;
          }
        }

        if (this.vh[v1] === h0) {
          if (next1 === h0) {
            if (!this.vdeleted[v1]) {
              this.vdeleted[v1] = true;
              this.deletedVertices += 1;
            }
          } else {
            this.vh[v1] = next1;
          }
        }
      }
    }

    for (const v of verts) this.adjustOutgoingHalfedge(v);

    this.garbage = true;
  }

  deleteEdge(e: EdgeId): void {
    if (this.edeleted[e]) return;
    const f0 = this.hface[this.edgeHalfedge(e, 0)];
    const f1 = this.hface[this.edgeHalfedge(e, 1)];
    if (f0 >= 0) this.deleteFace(f0);
    if (f1 >= 0) this.deleteFace(f1);
  }

  deleteVertex(v: VertexId): void {
    if (this.vdeleted[v]) return;
    const incident: FaceId[] = [];
    for (const f of this.facesAroundVertex(v)) incident.push(f);
    for (const f of incident) this.deleteFace(f);
    if (!this.vdeleted[v]) {
      this.vdeleted[v] = true;
      this.deletedVertices += 1;
      this.garbage = true;
    }
  }

  // --- Garbage collection (faithful port of pmp::SurfaceMesh::garbage_collection) ---

  garbageCollection(): void {
    if (!this.garbage) return;

    let nv = this.vprops.size;
    let ne = this.eprops.size;
    let nh = this.hprops.size;
    let nf = this.fprops.size;

    const vmap = this.vprops.add<number>("v:gc", () => 0);
    const hmap = this.hprops.add<number>("h:gc", () => 0);
    const fmap = this.fprops.add<number>("f:gc", () => 0);
    for (let i = 0; i < nv; i += 1) vmap[i] = i;
    for (let i = 0; i < nh; i += 1) hmap[i] = i;
    for (let i = 0; i < nf; i += 1) fmap[i] = i;

    // remove deleted vertices
    if (nv > 0) {
      let i0 = 0;
      let i1 = nv - 1;
      for (;;) {
        while (!this.vdeleted[i0] && i0 < i1) i0 += 1;
        while (this.vdeleted[i1] && i0 < i1) i1 -= 1;
        if (i0 >= i1) break;
        this.vprops.swap(i0, i1);
      }
      nv = this.vdeleted[i0] ? i0 : i0 + 1;
    }

    // remove deleted edges
    if (ne > 0) {
      let i0 = 0;
      let i1 = ne - 1;
      for (;;) {
        while (!this.edeleted[i0] && i0 < i1) i0 += 1;
        while (this.edeleted[i1] && i0 < i1) i1 -= 1;
        if (i0 >= i1) break;
        this.eprops.swap(i0, i1);
        this.hprops.swap(2 * i0, 2 * i1);
        this.hprops.swap(2 * i0 + 1, 2 * i1 + 1);
      }
      ne = this.edeleted[i0] ? i0 : i0 + 1;
      nh = 2 * ne;
    }

    // remove deleted faces
    if (nf > 0) {
      let i0 = 0;
      let i1 = nf - 1;
      for (;;) {
        while (!this.fdeleted[i0] && i0 < i1) i0 += 1;
        while (this.fdeleted[i1] && i0 < i1) i1 -= 1;
        if (i0 >= i1) break;
        this.fprops.swap(i0, i1);
      }
      nf = this.fdeleted[i0] ? i0 : i0 + 1;
    }

    // update vertex connectivity
    for (let i = 0; i < nv; i += 1) {
      if (!this.isIsolated(i)) this.vh[i] = hmap[this.vh[i]];
    }

    // update halfedge connectivity
    for (let i = 0; i < nh; i += 1) {
      this.hvertex[i] = vmap[this.hvertex[i]];
      this.setNextHalfedge(i, hmap[this.hnext[i]]);
      if (!this.isBoundaryHalfedge(i)) this.hface[i] = fmap[this.hface[i]];
    }

    // update face connectivity
    for (let i = 0; i < nf; i += 1) this.fh[i] = hmap[this.fh[i]];

    this.vprops.remove("v:gc");
    this.hprops.remove("h:gc");
    this.fprops.remove("f:gc");

    this.vprops.resize(nv);
    this.hprops.resize(nh);
    this.eprops.resize(ne);
    this.fprops.resize(nf);

    this.deletedVertices = 0;
    this.deletedEdges = 0;
    this.deletedFaces = 0;
    this.garbage = false;
  }
}

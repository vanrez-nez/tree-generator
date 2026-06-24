// Subdivision schemes ported from pmp::algorithms/subdivision.cpp:
//   linearSubdivision, loopSubdivision, catmullClarkSubdivision, quadTriSubdivision.
// Feature vertices/edges (v:feature, e:feature) and boundary handling follow PMP exactly.

import type { HalfedgeMesh, EdgeId, Point } from "./halfedge-mesh";
import { faceCentroid } from "./geometry";

export type BoundaryHandling = "interpolate" | "preserve";

function addP(a: Point, b: Point): Point {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function mulP(a: Point, s: number): Point {
  return [a[0] * s, a[1] * s, a[2] * s];
}

// Insert a new vertex at point p splitting edge e in two (no new faces). Returns the inserted
// halfedge (pmp insert_vertex semantics).
function insertEdgePoint(mesh: HalfedgeMesh, e: EdgeId, p: Point): number {
  const v = mesh.addVertex(p[0], p[1], p[2]);
  return mesh.insertVertexOnEdge(e, v);
}

// Quadrangulate / triangulate a face after its edges have been split — shared by linear/quad-tri.
function splitFaceFan(mesh: HalfedgeMesh, f: number, centerPoint: Point | null): void {
  const fval = mesh.valenceFace(f) / 2;
  if (fval === 3 && centerPoint === null) {
    let h0 = mesh.halfedgeOfFace(f);
    let h1 = mesh.nextHalfedge(mesh.nextHalfedge(h0));
    mesh.insertEdge(h0, h1);
    h0 = mesh.nextHalfedge(h0);
    h1 = mesh.nextHalfedge(mesh.nextHalfedge(h0));
    mesh.insertEdge(h0, h1);
    h0 = mesh.nextHalfedge(h0);
    h1 = mesh.nextHalfedge(mesh.nextHalfedge(h0));
    mesh.insertEdge(h0, h1);
  } else {
    const h0 = mesh.halfedgeOfFace(f);
    const h1start = mesh.nextHalfedge(mesh.nextHalfedge(h0));
    const cen = centerPoint ?? faceCentroid(mesh, f);
    const h1 = mesh.insertEdge(h0, h1start);
    insertEdgePoint(mesh, mesh.edge(h1), cen);
    let h = mesh.nextHalfedge(mesh.nextHalfedge(mesh.nextHalfedge(h1)));
    while (h !== h0) {
      mesh.insertEdge(h1, h);
      h = mesh.nextHalfedge(mesh.nextHalfedge(mesh.nextHalfedge(h1)));
    }
  }
}

export function linearSubdivision(mesh: HalfedgeMesh): void {
  for (const e of mesh.edges()) {
    const p = mulP(addP(mesh.position(mesh.edgeVertex(e, 0)), mesh.position(mesh.edgeVertex(e, 1))), 0.5);
    insertEdgePoint(mesh, e, p);
  }
  for (const f of mesh.faces()) {
    const fval = mesh.valenceFace(f) / 2;
    splitFaceFan(mesh, f, fval === 3 ? null : faceCentroid(mesh, f));
  }
}

export function loopSubdivision(
  mesh: HalfedgeMesh,
  boundaryHandling: BoundaryHandling = "interpolate",
): void {
  if (!mesh.isTriangleMesh()) {
    throw new Error("loopSubdivision: not a triangle mesh");
  }
  const points = mesh.vertexProperty<Point>("v:point", () => [0, 0, 0]);
  const vfeature = mesh.getVertexProperty<boolean>("v:feature");
  const efeature = mesh.getEdgeProperty<boolean>("e:feature");

  const vpoint = mesh.vertexProperty<Point>("loop:vpoint", () => [0, 0, 0]);
  const epoint = mesh.edgeProperty<Point>("loop:epoint", () => [0, 0, 0]);

  for (const v of mesh.vertices()) {
    if (mesh.isIsolated(v)) {
      vpoint[v] = points[v];
    } else if (mesh.isBoundaryVertex(v)) {
      if (boundaryHandling === "preserve") {
        vpoint[v] = points[v];
      } else {
        const h1 = mesh.halfedgeOfVertex(v);
        const h0 = mesh.prevHalfedge(h1);
        let p = mulP(points[v], 6);
        p = addP(p, points[mesh.toVertex(h1)]);
        p = addP(p, points[mesh.fromVertex(h0)]);
        vpoint[v] = mulP(p, 0.125);
      }
    } else if (vfeature && vfeature[v]) {
      let p = mulP(points[v], 6);
      let count = 0;
      for (const h of mesh.halfedgesAroundVertex(v)) {
        if (efeature && efeature[mesh.edge(h)]) {
          p = addP(p, points[mesh.toVertex(h)]);
          count += 1;
        }
      }
      vpoint[v] = count === 2 ? mulP(p, 0.125) : points[v];
    } else {
      let p: Point = [0, 0, 0];
      let k = 0;
      for (const vv of mesh.verticesAroundVertex(v)) {
        p = addP(p, points[vv]);
        k += 1;
      }
      p = mulP(p, 1 / k);
      const beta = 0.625 - Math.pow(0.375 + 0.25 * Math.cos((2 * Math.PI) / k), 2);
      vpoint[v] = addP(mulP(points[v], 1 - beta), mulP(p, beta));
    }
  }

  for (const e of mesh.edges()) {
    if (mesh.isBoundaryEdge(e) || (efeature && efeature[e])) {
      epoint[e] = mulP(addP(mesh.position(mesh.edgeVertex(e, 0)), mesh.position(mesh.edgeVertex(e, 1))), 0.5);
    } else {
      const h0 = mesh.edgeHalfedge(e, 0);
      const h1 = mesh.edgeHalfedge(e, 1);
      let p = addP(points[mesh.toVertex(h0)], points[mesh.toVertex(h1)]);
      p = mulP(p, 3);
      p = addP(p, points[mesh.toVertex(mesh.nextHalfedge(h0))]);
      p = addP(p, points[mesh.toVertex(mesh.nextHalfedge(h1))]);
      epoint[e] = mulP(p, 0.125);
    }
  }

  for (const v of mesh.vertices()) points[v] = vpoint[v];

  for (const e of mesh.edges()) {
    if (efeature && efeature[e]) {
      const h = insertEdgePoint(mesh, e, epoint[e]);
      const v = mesh.toVertex(h);
      const e0 = mesh.edge(h);
      const e1 = mesh.edge(mesh.nextHalfedge(h));
      const vf = mesh.vertexProperty<boolean>("v:feature", () => false);
      vf[v] = true;
      efeature[e0] = true;
      efeature[e1] = true;
    } else {
      insertEdgePoint(mesh, e, epoint[e]);
    }
  }

  for (const f of mesh.faces()) {
    let h = mesh.halfedgeOfFace(f);
    mesh.insertEdge(h, mesh.nextHalfedge(mesh.nextHalfedge(h)));
    h = mesh.nextHalfedge(h);
    mesh.insertEdge(h, mesh.nextHalfedge(mesh.nextHalfedge(h)));
    h = mesh.nextHalfedge(h);
    mesh.insertEdge(h, mesh.nextHalfedge(mesh.nextHalfedge(h)));
  }

  mesh.removeVertexProperty("loop:vpoint");
  mesh.removeEdgeProperty("loop:epoint");
}

export function catmullClarkSubdivision(
  mesh: HalfedgeMesh,
  boundaryHandling: BoundaryHandling = "interpolate",
): void {
  const points = mesh.vertexProperty<Point>("v:point", () => [0, 0, 0]);
  const vfeature = mesh.getVertexProperty<boolean>("v:feature");
  const efeature = mesh.getEdgeProperty<boolean>("e:feature");

  const vpoint = mesh.vertexProperty<Point>("catmull:vpoint", () => [0, 0, 0]);
  const epoint = mesh.edgeProperty<Point>("catmull:epoint", () => [0, 0, 0]);
  const fpoint = mesh.faceProperty<Point>("catmull:fpoint", () => [0, 0, 0]);

  for (const f of mesh.faces()) fpoint[f] = faceCentroid(mesh, f);

  for (const e of mesh.edges()) {
    if (mesh.isBoundaryEdge(e) || (efeature && efeature[e])) {
      epoint[e] = mulP(addP(mesh.position(mesh.edgeVertex(e, 0)), mesh.position(mesh.edgeVertex(e, 1))), 0.5);
    } else {
      let p = addP(points[mesh.edgeVertex(e, 0)], points[mesh.edgeVertex(e, 1)]);
      p = addP(p, fpoint[mesh.face(mesh.edgeHalfedge(e, 0))]);
      p = addP(p, fpoint[mesh.face(mesh.edgeHalfedge(e, 1))]);
      epoint[e] = mulP(p, 0.25);
    }
  }

  for (const v of mesh.vertices()) {
    if (mesh.isIsolated(v)) {
      vpoint[v] = points[v];
    } else if (mesh.isBoundaryVertex(v)) {
      if (boundaryHandling === "preserve") {
        vpoint[v] = points[v];
      } else {
        const h1 = mesh.halfedgeOfVertex(v);
        const h0 = mesh.prevHalfedge(h1);
        let p = mulP(points[v], 6);
        p = addP(p, points[mesh.toVertex(h1)]);
        p = addP(p, points[mesh.fromVertex(h0)]);
        vpoint[v] = mulP(p, 0.125);
      }
    } else if (vfeature && vfeature[v]) {
      let p = mulP(points[v], 6);
      let count = 0;
      for (const h of mesh.halfedgesAroundVertex(v)) {
        if (efeature && efeature[mesh.edge(h)]) {
          p = addP(p, points[mesh.toVertex(h)]);
          count += 1;
        }
      }
      vpoint[v] = count === 2 ? mulP(p, 0.125) : points[v];
    } else {
      const k = mesh.valenceVertex(v);
      let p: Point = [0, 0, 0];
      for (const vv of mesh.verticesAroundVertex(v)) p = addP(p, points[vv]);
      for (const f of mesh.facesAroundVertex(v)) p = addP(p, fpoint[f]);
      p = mulP(p, 1 / (k * k));
      p = addP(p, mulP(points[v], (k - 2) / k));
      vpoint[v] = p;
    }
  }

  for (const v of mesh.vertices()) points[v] = vpoint[v];

  for (const e of mesh.edges()) {
    if (efeature && efeature[e]) {
      const h = insertEdgePoint(mesh, e, epoint[e]);
      const v = mesh.toVertex(h);
      const e0 = mesh.edge(h);
      const e1 = mesh.edge(mesh.nextHalfedge(h));
      const vf = mesh.vertexProperty<boolean>("v:feature", () => false);
      vf[v] = true;
      efeature[e0] = true;
      efeature[e1] = true;
    } else {
      insertEdgePoint(mesh, e, epoint[e]);
    }
  }

  for (const f of mesh.faces()) {
    const h0 = mesh.halfedgeOfFace(f);
    mesh.insertEdge(h0, mesh.nextHalfedge(mesh.nextHalfedge(h0)));
    const h1 = mesh.nextHalfedge(h0);
    insertEdgePoint(mesh, mesh.edge(h1), fpoint[f]);
    let h = mesh.nextHalfedge(mesh.nextHalfedge(mesh.nextHalfedge(h1)));
    while (h !== h0) {
      mesh.insertEdge(h1, h);
      h = mesh.nextHalfedge(mesh.nextHalfedge(mesh.nextHalfedge(h1)));
    }
  }

  mesh.removeVertexProperty("catmull:vpoint");
  mesh.removeEdgeProperty("catmull:epoint");
  mesh.removeFaceProperty("catmull:fpoint");
}

export function quadTriSubdivision(
  mesh: HalfedgeMesh,
  boundaryHandling: BoundaryHandling = "interpolate",
): void {
  const points = mesh.vertexProperty<Point>("v:point", () => [0, 0, 0]);

  for (const e of mesh.edges()) {
    const p = mulP(addP(mesh.position(mesh.edgeVertex(e, 0)), mesh.position(mesh.edgeVertex(e, 1))), 0.5);
    insertEdgePoint(mesh, e, p);
  }

  for (const f of mesh.faces()) {
    const fval = mesh.valenceFace(f) / 2;
    splitFaceFan(mesh, f, fval === 3 ? null : faceCentroid(mesh, f));
  }

  const newPos = mesh.vertexProperty<Point>("quad_tri:new_position", () => [0, 0, 0]);

  for (const v of mesh.vertices()) {
    if (mesh.isBoundaryVertex(v)) {
      if (boundaryHandling === "preserve") {
        newPos[v] = points[v];
      } else {
        let p = mulP(points[v], 0.5);
        for (const vv of mesh.verticesAroundVertex(v)) {
          if (mesh.isBoundaryVertex(vv)) p = addP(p, mulP(points[vv], 0.25));
        }
        newPos[v] = p;
      }
    } else {
      let nFaces = 0;
      let nQuads = 0;
      for (const f of mesh.facesAroundVertex(v)) {
        nFaces += 1;
        if (mesh.valenceFace(f) === 4) nQuads += 1;
      }

      if (nQuads === 0) {
        const a = 2 * Math.pow(3 / 8 + (Math.cos((2 * Math.PI) / nFaces) - 1) / 4, 2);
        const b = (1 - a) / nFaces;
        let p = mulP(points[v], a);
        for (const vv of mesh.verticesAroundVertex(v)) p = addP(p, mulP(points[vv], b));
        newPos[v] = p;
      } else if (nQuads === nFaces) {
        const c = (nFaces - 3) / nFaces;
        const d = 2 / (nFaces * nFaces);
        const e2 = 1 / (nFaces * nFaces);
        let p = mulP(points[v], c);
        for (const h of mesh.halfedgesAroundVertex(v)) {
          p = addP(p, mulP(points[mesh.toVertex(h)], d));
          p = addP(p, mulP(points[mesh.toVertex(mesh.nextHalfedge(h))], e2));
        }
        newPos[v] = p;
      } else {
        const alpha = 1 / (1 + 0.5 * nFaces + 0.25 * nQuads);
        const beta = 0.5 * alpha;
        const gamma = 0.25 * alpha;
        let p = mulP(points[v], alpha);
        for (const h of mesh.halfedgesAroundVertex(v)) {
          p = addP(p, mulP(points[mesh.toVertex(h)], beta));
          if (mesh.valenceFace(mesh.face(h)) === 4) {
            p = addP(p, mulP(points[mesh.toVertex(mesh.nextHalfedge(h))], gamma));
          }
        }
        newPos[v] = p;
      }
    }
  }

  for (const v of mesh.vertices()) points[v] = newPos[v];
  mesh.removeVertexProperty("quad_tri:new_position");
}

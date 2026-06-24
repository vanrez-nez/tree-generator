// Triangle Kd-tree for nearest-surface queries, ported from the TriangleKdTree in
// pmp::algorithms/remeshing.cpp. Used by remeshing's back-projection onto a reference surface.

import type { Point } from "./halfedge-mesh";
import { distPointTriangle } from "./geometry";

export type Triangle = [Point, Point, Point];

export type NearestTriangle = {
  dist: number;
  face: number; // index into the triangle array
  nearest: Point;
};

type Node = {
  axis: number;
  split: number;
  faces: number[] | null; // leaf face indices; null for internal nodes
  left: Node | null;
  right: Node | null;
};

export class TriangleKdTree {
  private readonly root: Node;
  private readonly facePoints: Triangle[];

  constructor(triangles: Triangle[], maxFaces = 10, maxDepth = 30) {
    this.facePoints = triangles;
    this.root = { axis: 0, split: 0, faces: triangles.map((_, i) => i), left: null, right: null };
    this.buildRecurse(this.root, maxFaces, maxDepth);
  }

  private buildRecurse(node: Node, maxFaces: number, depth: number): void {
    const faces = node.faces!;
    if (depth === 0 || faces.length <= maxFaces) return;

    // bounding box of the node's faces
    const min: Point = [Infinity, Infinity, Infinity];
    const max: Point = [-Infinity, -Infinity, -Infinity];
    for (const f of faces) {
      const tri = this.facePoints[f];
      for (let k = 0; k < 3; k += 1) {
        const p = tri[k];
        for (let a = 0; a < 3; a += 1) {
          if (p[a] < min[a]) min[a] = p[a];
          if (p[a] > max[a]) max[a] = p[a];
        }
      }
    }

    // split the longest axis at the box center
    let axis = 0;
    let length = max[0] - min[0];
    if (max[1] - min[1] > length) length = max[(axis = 1)] - min[1];
    if (max[2] - min[2] > length) length = max[(axis = 2)] - min[2];
    const split = 0.5 * (min[axis] + max[axis]);

    const left: number[] = [];
    const right: number[] = [];
    for (const f of faces) {
      const tri = this.facePoints[f];
      let l = false;
      let r = false;
      for (let k = 0; k < 3; k += 1) {
        if (tri[k][axis] <= split) l = true;
        else r = true;
      }
      if (l) left.push(f);
      if (r) right.push(f);
    }

    // partition made no progress: stop here
    if (left.length === faces.length || right.length === faces.length) return;

    node.faces = null;
    node.axis = axis;
    node.split = split;
    node.left = { axis: 0, split: 0, faces: left, left: null, right: null };
    node.right = { axis: 0, split: 0, faces: right, left: null, right: null };
    this.buildRecurse(node.left, maxFaces, depth - 1);
    this.buildRecurse(node.right, maxFaces, depth - 1);
  }

  nearest(p: Point): NearestTriangle {
    const data: NearestTriangle = { dist: Infinity, face: -1, nearest: [0, 0, 0] };
    this.nearestRecurse(this.root, p, data);
    return data;
  }

  private nearestRecurse(node: Node, point: Point, data: NearestTriangle): void {
    if (!node.left) {
      for (const f of node.faces!) {
        const tri = this.facePoints[f];
        const r = distPointTriangle(point, tri[0], tri[1], tri[2]);
        if (r.distance < data.dist) {
          data.dist = r.distance;
          data.face = f;
          data.nearest = r.nearest;
        }
      }
      return;
    }

    const dist = point[node.axis] - node.split;
    if (dist <= 0) {
      this.nearestRecurse(node.left, point, data);
      if (Math.abs(dist) < data.dist) this.nearestRecurse(node.right!, point, data);
    } else {
      this.nearestRecurse(node.right!, point, data);
      if (Math.abs(dist) < data.dist) this.nearestRecurse(node.left, point, data);
    }
  }
}

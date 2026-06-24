import { Vector2, Vector3 } from "three";

export type Quad = [number, number, number, number];

// Intermediate mesh the welding mesher writes into before conversion to a THREE.BufferGeometry.
// A face is a quad of vertex indices; UVs are stored separately and referenced per-face by
// `uvLoops` (Blender's loop model). Per-vertex attributes:
//   smoothAmount — smoothing weight driving the radius-weighted Laplacian pass
//   radius       — local branch radius (exposed for shading)
//   directionA   — local growth direction (exposed for shading)
export class WeldMesh {
  vertices: Vector3[] = [];
  uvs: Vector2[] = [];
  polygons: Quad[] = [];
  uvLoops: Quad[] = [];

  smoothAmount: number[] = [];
  radius: number[] = [];
  directionA: Vector3[] = [];

  /** Append a vertex (and a slot in every per-vertex attribute); returns its index. */
  addVertex(position: Vector3): number {
    this.vertices.push(position.clone());
    this.smoothAmount.push(0);
    this.radius.push(0);
    this.directionA.push(new Vector3());
    return this.vertices.length - 1;
  }

  /** Append empty polygon + uv-loop slots; returns the polygon index. */
  addPolygon(): number {
    this.polygons.push([0, 0, 0, 0]);
    this.uvLoops.push([0, 0, 0, 0]);
    return this.polygons.length - 1;
  }
}

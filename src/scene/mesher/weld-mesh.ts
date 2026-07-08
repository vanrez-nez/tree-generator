import { Vector2, Vector3 } from "three";

export type Quad = [number, number, number, number];

// Intermediate mesh the welding mesher writes into before conversion to a THREE.BufferGeometry.
// A face is a quad of vertex indices; UVs are stored separately and referenced per-face by
// `uvLoops`. Per-vertex attributes:
//   smoothAmount — smoothing weight driving the radius-weighted Laplacian pass
//   radius       — local branch radius (exposed for shading)
//   directionA   — local growth direction (exposed for shading)
// Per-UV-index attributes (parallel to `uvs`, appended together via addUv):
//   uvs2  — the OTHER chart's uv at this corner. Identical to `uvs` everywhere except the junction
//           skirt band, where it carries the PARENT chart so the surface can cross-fade the two.
//   blend — cross-fade weight into `uvs2` (0 = pure own chart; 1 at the skirt's parent rim).
export class WeldMesh {
  vertices: Vector3[] = [];
  uvs: Vector2[] = [];
  uvs2: Vector2[] = [];
  blend: number[] = [];
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

  /**
   * Append a UV together with its cross-chart partner and blend weight (defaults = own chart,
   * no fade), keeping the three arrays in lockstep; returns the uv index.
   */
  addUv(uv: Vector2, uv2: Vector2 = uv, blend = 0): number {
    this.uvs.push(uv);
    this.uvs2.push(uv2);
    this.blend.push(blend);
    return this.uvs.length - 1;
  }

  /** Append empty polygon + uv-loop slots; returns the polygon index. */
  addPolygon(): number {
    this.polygons.push([0, 0, 0, 0]);
    this.uvLoops.push([0, 0, 0, 0]);
    return this.polygons.length - 1;
  }
}

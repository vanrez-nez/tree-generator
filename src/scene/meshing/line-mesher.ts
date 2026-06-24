import * as THREE from "three";
import type { Graph } from "../graph/graph";
import type { GraphLine } from "../graph/line";
import { rotationMinimizingFrames } from "../graph/modifiers/utils";

// Per-line tube mesher. Every line (trunk, branches, roots) already carries a tube and therefore a
// system of discs (cross-section rings). We loft each line's discs into its own closed surface mesh
// — 1 line = 1 mesh — and let the tubes simply overlap where limbs meet (no trimming/boolean).
//
// For each line:
//   - sample its discs (density along the drawn spine + taper + one RMF, matching LineTube),
//   - ring vertices around each disc (n-gon),
//   - SIDE faces: connect matching vertices of consecutive discs (RMF-aligned, no twist),
//   - END CAPS: triangle-fan the first and last rings so the tube is closed.

const MAX_DISKS = 256;

type Disk = {
  center: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3;
  radius: number;
};

export class LineMesher {
  readonly object = new THREE.Group();

  // One mesh per line id; reused across rebuilds.
  private readonly meshes = new Map<string, THREE.Mesh>();
  private wireframe = false;

  setVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  setSurfaceVisible(visible: boolean): void {
    this.object.visible = visible;
  }

  setSurfaceWireframe(wireframe: boolean): void {
    this.wireframe = wireframe;
    for (const mesh of this.meshes.values()) {
      (mesh.material as THREE.MeshStandardMaterial).wireframe = wireframe;
    }
  }

  build(graph: Graph): void {
    const seen = new Set<string>();

    for (const { id, line } of graph.getLineEntries()) {
      const tube = line.tube;
      if (!tube) continue;

      const disks = lineDisks(line);
      if (disks.length < 2) continue;
      const n = Math.max(3, Math.floor(tube.segments));

      const geometry = buildTubeGeometry(disks, n);
      const mesh = this.meshFor(id, tube.color);
      mesh.geometry.dispose();
      mesh.geometry = geometry;
      seen.add(id);
    }

    // Drop meshes for lines that no longer exist (e.g. fewer roots after a rebuild).
    for (const [id, mesh] of this.meshes) {
      if (seen.has(id)) continue;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.object.remove(mesh);
      this.meshes.delete(id);
    }
  }

  private meshFor(id: string, color: number): THREE.Mesh {
    const existing = this.meshes.get(id);
    if (existing) {
      (existing.material as THREE.MeshStandardMaterial).color.setHex(color);
      return existing;
    }
    const material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
      wireframe: this.wireframe,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.frustumCulled = false;
    this.object.add(mesh);
    this.meshes.set(id, mesh);
    return mesh;
  }
}

// Lofts a closed tube surface from a line's discs: n ring vertices per disc, quad strips between
// consecutive discs, and a triangle-fan cap on each end.
function buildTubeGeometry(disks: Disk[], n: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const faces: number[] = [];

  const diskStarts: number[] = [];
  for (const disk of disks) {
    const start = positions.length / 3;
    diskStarts.push(start);
    for (let k = 0; k < n; k += 1) {
      const angle = (k / n) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(
        disk.center.x + (disk.normal.x * cos + disk.binormal.x * sin) * disk.radius,
        disk.center.y + (disk.normal.y * cos + disk.binormal.y * sin) * disk.radius,
        disk.center.z + (disk.normal.z * cos + disk.binormal.z * sin) * disk.radius,
      );
    }
  }

  // Side faces: connect matching vertices of consecutive discs (RMF-aligned, no twist).
  for (let d = 0; d < diskStarts.length - 1; d += 1) {
    const a = diskStarts[d];
    const b = diskStarts[d + 1];
    for (let k = 0; k < n; k += 1) {
      const k1 = (k + 1) % n;
      faces.push(a + k, b + k, b + k1);
      faces.push(a + k, b + k1, a + k1);
    }
  }

  // End caps: fan over the first ring (facing down) and the last ring (facing up).
  const firstCenter = addCenter(positions, disks[0].center);
  for (let k = 0; k < n; k += 1) {
    faces.push(firstCenter, (k + 1) % n, k);
  }
  const lastStart = diskStarts[diskStarts.length - 1];
  const lastCenter = addCenter(positions, disks[disks.length - 1].center);
  for (let k = 0; k < n; k += 1) {
    faces.push(lastCenter, lastStart + k, lastStart + ((k + 1) % n));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(faces);
  geometry.computeVertexNormals();
  return geometry;
}

function addCenter(positions: number[], center: THREE.Vector3): number {
  const index = positions.length / 3;
  positions.push(center.x, center.y, center.z);
  return index;
}

// Replicates LineTube's disc sampling (density along the drawn spine + taper + one RMF) so the
// mesher uses the very same discs the tube renders.
function lineDisks(line: GraphLine): Disk[] {
  const tube = line.tube;
  const points = line.virtual.getDrawPoints();
  if (!tube || points.length < 2) return [];

  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + points[i - 1].distanceTo(points[i]);
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 1e-6) return [];

  const count = THREE.MathUtils.clamp(Math.round(tube.density * total), 2, MAX_DISKS);
  const centers: THREE.Vector3[] = [];
  const tangents: THREE.Vector3[] = [];
  const radii: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / (count - 1);
    const sample = sampleAt(points, cumulative, total * t);
    centers.push(sample.position);
    tangents.push(sample.tangent);
    radii.push(tube.radiusAt(t));
  }

  const frames = rotationMinimizingFrames(centers, tangents);
  return centers.map((center, i) => ({
    center,
    normal: frames[i].normal,
    binormal: frames[i].binormal,
    radius: radii[i],
  }));
}

function sampleAt(
  points: THREE.Vector3[],
  cumulative: number[],
  distance: number,
): { position: THREE.Vector3; tangent: THREE.Vector3 } {
  const last = points.length - 1;
  let i = 0;
  while (i < last - 1 && cumulative[i + 1] < distance) i += 1;
  const segLen = Math.max(1e-9, cumulative[i + 1] - cumulative[i]);
  const local = THREE.MathUtils.clamp((distance - cumulative[i]) / segLen, 0, 1);
  const position = points[i].clone().lerp(points[i + 1], local);
  const tangent = points[i + 1].clone().sub(points[i]);
  return {
    position,
    tangent: tangent.lengthSq() <= 1e-12 ? new THREE.Vector3(0, 1, 0) : tangent.normalize(),
  };
}

import * as THREE from "three";
import { cubicBezierEasing, type CubicBezierCurve } from "./curve";

// A per-line "tube": a stack of filled, semitransparent discs placed at each drawn point and
// oriented perpendicular to the local tangent. The radius starts at `radius` (the line's max,
// set by its branching level) and tapers toward the tip by `tipScale`, eased along the line by
// a cubic-Bézier `curve`. Rendered as a single InstancedMesh (one draw call per line).

export type LineTubeOptions = {
  radius: number;
  density?: number;
  tipScale?: number;
  color?: THREE.ColorRepresentation;
  opacity?: number;
  segments?: number;
  curve?: CubicBezierCurve;
  visible?: boolean;
};

const LINEAR_CURVE: CubicBezierCurve = [0.33, 0.33, 0.66, 0.66];
const FORWARD = new THREE.Vector3(0, 0, 1);
const MAX_DISCS = 256;

export class LineTube {
  radius: number;
  density: number;
  tipScale: number;
  opacity: number;
  segments: number;
  curve: CubicBezierCurve;
  visible: boolean;

  readonly object = new THREE.Group();

  private readonly material: THREE.MeshBasicMaterial;
  private geometry: THREE.CircleGeometry;
  private mesh: THREE.InstancedMesh;

  constructor({
    radius,
    density = 8,
    tipScale = 0.12,
    color = 0xffffff,
    opacity = 0.35,
    segments = 16,
    curve = LINEAR_CURVE,
    visible = true,
  }: LineTubeOptions) {
    this.radius = radius;
    this.density = density;
    this.tipScale = tipScale;
    this.opacity = opacity;
    this.segments = Math.max(3, Math.floor(segments));
    this.curve = curve;
    this.visible = visible;

    this.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.geometry = new THREE.CircleGeometry(1, this.segments);
    this.mesh = this.createMesh(1);
    this.object.add(this.mesh);
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.material.color.set(color);
  }

  update(points: THREE.Vector3[]): void {
    this.material.opacity = this.opacity;
    this.object.visible = this.visible;

    const cumulative = cumulativeLengths(points);
    const total = cumulative[cumulative.length - 1] ?? 0;

    if (!this.visible || points.length < 2 || total <= 1e-6) {
      this.mesh.count = 0;
      return;
    }

    // Disc count from density (discs per unit length), at least 2 (start + tip).
    const count = THREE.MathUtils.clamp(Math.round(this.density * total), 2, MAX_DISCS);

    if (this.mesh.instanceMatrix.count !== count) {
      this.rebuildMesh(count);
    }

    for (let index = 0; index < count; index += 1) {
      const t = index / (count - 1);
      const sample = sampleAtDistance(points, cumulative, total * t);
      _quaternion.setFromUnitVectors(FORWARD, sample.tangent);

      const eased = cubicBezierEasing(t, this.curve);
      const radius = THREE.MathUtils.lerp(this.radius, this.radius * this.tipScale, eased);
      _scale.set(radius, radius, 1);

      _matrix.compose(sample.position, _quaternion, _scale);
      this.mesh.setMatrixAt(index, _matrix);
    }

    this.mesh.count = count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.object.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }

  private rebuildMesh(count: number): void {
    this.object.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = this.createMesh(count);
    this.object.add(this.mesh);
  }

  private createMesh(count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, Math.max(1, count));
    mesh.frustumCulled = false;
    return mesh;
  }
}

function cumulativeLengths(points: THREE.Vector3[]): number[] {
  const distances = [0];

  for (let index = 1; index < points.length; index += 1) {
    distances[index] = distances[index - 1] + points[index - 1].distanceTo(points[index]);
  }

  return distances;
}

// Position + unit tangent at `distance` arc-length units along the polyline.
function sampleAtDistance(
  points: THREE.Vector3[],
  cumulative: number[],
  distance: number,
): { position: THREE.Vector3; tangent: THREE.Vector3 } {
  const last = points.length - 1;
  let index = 0;

  while (index < last - 1 && cumulative[index + 1] < distance) {
    index += 1;
  }

  const segmentLength = Math.max(1e-9, cumulative[index + 1] - cumulative[index]);
  const local = THREE.MathUtils.clamp((distance - cumulative[index]) / segmentLength, 0, 1);
  const position = points[index].clone().lerp(points[index + 1], local);
  const tangent = points[index + 1].clone().sub(points[index]);

  return {
    position,
    tangent: tangent.lengthSq() <= 1e-12 ? FORWARD.clone() : tangent.normalize(),
  };
}

const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

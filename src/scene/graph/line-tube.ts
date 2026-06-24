import * as THREE from "three";
import { cubicBezierEasing, type CubicBezierCurve } from "./curve";
import {
  signedDistance,
  surfaceCrossing,
  type ParentSurface,
} from "./collar";

// A per-line "tube": filled, semitransparent discs sampled along the line (density = discs per
// unit length), each perpendicular to the local tangent, tapering from `radius` to
// `radius*tipScale` along a cubic-Bézier `curve`.
//
// When `parentClip` is set, each disc is booleaned against the parent tube volume: discs fully
// outside stay whole (fast InstancedMesh path), fully inside are dropped, and straddling discs
// are CUT along the parent surface (built into a small BufferGeometry) so the cut edge lands on
// the parent surface — the shared boundary future welds need.

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
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);
const MAX_DISCS = 256;

export class LineTube {
  radius: number;
  density: number;
  tipScale: number;
  opacity: number;
  segments: number;
  curve: CubicBezierCurve;
  visible: boolean;
  parentClip: ParentSurface | null = null;

  readonly object = new THREE.Group();

  private readonly material: THREE.MeshBasicMaterial;
  private discGeometry: THREE.CircleGeometry;
  private mesh: THREE.InstancedMesh;
  private readonly clipGeometry = new THREE.BufferGeometry();
  private readonly clipMesh: THREE.Mesh;

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
    this.discGeometry = new THREE.CircleGeometry(1, this.segments);
    this.mesh = this.createMesh(1);
    this.clipMesh = new THREE.Mesh(this.clipGeometry, this.material);
    this.clipMesh.frustumCulled = false;

    this.object.add(this.mesh);
    this.object.add(this.clipMesh);
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.material.color.set(color);
  }

  // Tube radius at arc fraction `t` (the taper). Exposed so a child's collar/clip can sample its
  // parent's surface profile.
  radiusAt(t: number): number {
    const eased = cubicBezierEasing(THREE.MathUtils.clamp(t, 0, 1), this.curve);
    return THREE.MathUtils.lerp(this.radius, this.radius * this.tipScale, eased);
  }

  update(points: THREE.Vector3[]): void {
    this.material.opacity = this.opacity;
    this.object.visible = this.visible;

    const cumulative = cumulativeLengths(points);
    const total = cumulative[cumulative.length - 1] ?? 0;

    if (!this.visible || points.length < 2 || total <= 1e-6) {
      this.mesh.count = 0;
      this.setClipPositions(EMPTY);
      return;
    }

    const count = THREE.MathUtils.clamp(Math.round(this.density * total), 2, MAX_DISCS);

    if (this.mesh.instanceMatrix.count !== count) {
      this.rebuildMesh(count);
    }

    const surface = this.parentClip;
    const clip: number[] = [];
    let full = 0;

    for (let index = 0; index < count; index += 1) {
      const t = index / (count - 1);
      const { position, tangent } = sampleAtDistance(points, cumulative, total * t);
      const radius = this.radiusAt(t);

      if (!surface) {
        this.setInstance(full, position, tangent, radius);
        full += 1;
        continue;
      }

      const sd = signedDistance(surface, position);

      if (sd >= radius) {
        // Fully outside the parent: whole disc.
        this.setInstance(full, position, tangent, radius);
        full += 1;
      } else if (sd <= -radius) {
        // Fully inside the parent: dropped.
        continue;
      } else {
        // Straddling: cut against the parent surface into the built geometry.
        appendCutDisc(clip, position, tangent, radius, this.segments, surface);
      }
    }

    this.mesh.count = full;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.setClipPositions(clip.length > 0 ? new Float32Array(clip) : EMPTY);
  }

  dispose(): void {
    this.object.remove(this.mesh);
    this.object.remove(this.clipMesh);
    this.discGeometry.dispose();
    this.clipGeometry.dispose();
    this.material.dispose();
  }

  private setInstance(
    index: number,
    position: THREE.Vector3,
    tangent: THREE.Vector3,
    radius: number,
  ): void {
    _quaternion.setFromUnitVectors(FORWARD, tangent);
    _scale.set(radius, radius, 1);
    _matrix.compose(position, _quaternion, _scale);
    this.mesh.setMatrixAt(index, _matrix);
  }

  private setClipPositions(positions: Float32Array): void {
    this.clipMesh.visible = this.visible && positions.length > 0;
    this.clipGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.clipGeometry.setDrawRange(0, positions.length / 3);
  }

  private rebuildMesh(count: number): void {
    this.object.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = this.createMesh(count);
    this.object.add(this.mesh);
  }

  private createMesh(count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.discGeometry, this.material, Math.max(1, count));
    mesh.frustumCulled = false;
    return mesh;
  }
}

// Build a disc as a triangle fan (center + rim), clip each triangle to the part outside the
// parent surface, and append the kept triangles (world positions) to `out`.
function appendCutDisc(
  out: number[],
  center: THREE.Vector3,
  tangent: THREE.Vector3,
  radius: number,
  segments: number,
  surface: ParentSurface,
): void {
  const reference = Math.abs(tangent.dot(WORLD_UP)) > 0.95 ? WORLD_X : WORLD_UP;
  const u = reference.clone().cross(tangent).normalize();
  const v = tangent.clone().cross(u).normalize();

  const rim: THREE.Vector3[] = [];
  for (let k = 0; k < segments; k += 1) {
    const angle = (k / segments) * Math.PI * 2;
    rim.push(
      center
        .clone()
        .addScaledVector(u, Math.cos(angle) * radius)
        .addScaledVector(v, Math.sin(angle) * radius),
    );
  }

  for (let k = 0; k < segments; k += 1) {
    clipTriangleOutside(center, rim[k], rim[(k + 1) % segments], surface, out);
  }
}

// Sutherland–Hodgman clip of one triangle against the "outside the parent" region, with edge
// crossings placed on the parent surface (bisection). Kept polygon is fan-triangulated into `out`.
function clipTriangleOutside(
  a: THREE.Vector3,
  b: THREE.Vector3,
  c: THREE.Vector3,
  surface: ParentSurface,
  out: number[],
): void {
  const input = [a, b, c];
  const poly: THREE.Vector3[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const cur = input[i];
    const next = input[(i + 1) % input.length];
    const curOutside = signedDistance(surface, cur) >= 0;
    const nextOutside = signedDistance(surface, next) >= 0;

    if (curOutside) {
      poly.push(cur);
    }
    if (curOutside !== nextOutside) {
      poly.push(surfaceCrossing(cur, next, surface));
    }
  }

  for (let k = 1; k + 1 < poly.length; k += 1) {
    pushVec(out, poly[0]);
    pushVec(out, poly[k]);
    pushVec(out, poly[k + 1]);
  }
}

function pushVec(out: number[], v: THREE.Vector3): void {
  out.push(v.x, v.y, v.z);
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

const EMPTY = new Float32Array(0);
const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();
const _scale = new THREE.Vector3();

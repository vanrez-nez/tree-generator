import * as THREE from "three";
import type { GraphLine } from "./line";
import { computeCollar, makeParentSurface } from "./collar";

const TANGENT_EPSILON = 1e-3;
const DIRECTION_EPSILON = 1e-6;
const ANGLE_EPSILON = 1e-4;

export type JointOptions = {
  id: string;
  parentLine: GraphLine;
  parentT: number;
  childLine: GraphLine;
  childPointIndex: number;
  maxLeanAngle?: number;
  directionPoints?: number;
};

export class Joint {
  readonly id: string;
  readonly parentLine: GraphLine;
  readonly childLine: GraphLine;
  readonly childPointIndex: number;
  parentT: number;
  maxLeanAngle: number;
  directionPoints: number;

  // The collar: where the child centerline exits the parent tube surface — the structural
  // junction where the limb emerges. Recomputed each frame by `resolveJunction`.
  collarT = 0;
  readonly collarPoint = new THREE.Vector3();

  constructor({
    id,
    parentLine,
    parentT,
    childLine,
    childPointIndex,
    maxLeanAngle = 60,
    directionPoints = 1,
  }: JointOptions) {
    this.id = id;
    this.parentLine = parentLine;
    this.parentT = parentT;
    this.childLine = childLine;
    this.childPointIndex = childPointIndex;
    this.maxLeanAngle = maxLeanAngle;
    this.directionPoints = directionPoints;

    // Declarative connection: the child's world points are assembled relative to this anchor every
    // frame (pull-based), so the child is structurally pinned to the parent — never mutated/drifted.
    // `parentT`/`maxLeanAngle` are read live, so editing them reshapes the fork without re-snapshot.
    if (this.parentLine !== this.childLine) {
      this.childLine.attachment = {
        pivot: this.childPointIndex,
        anchor: () => this.anchorPoint(),
        orient: () => this.orient(),
      };
    }
  }

  // Where the child's pivot connects on the parent (the parent's centerline at `parentT`).
  anchorPoint(): THREE.Vector3 {
    return this.parentLine.getPointAt(THREE.MathUtils.clamp(this.parentT, 0, 1));
  }

  // Rotation applied to the child's local shape (about its pivot) so its heading stays within
  // `maxLeanAngle` of perpendicular-to-the-parent. Identity when unconstrained or already in range.
  // This is the former `clampRestPoints`, returning the rotation instead of mutating points.
  orient(): THREE.Quaternion {
    if (this.maxLeanAngle >= 90) {
      return new THREE.Quaternion();
    }

    const parentDirection = this.getParentDirection();
    if (!parentDirection) {
      return new THREE.Quaternion();
    }

    const childDirection = this.getChildDirection(this.childLine.points);
    if (!childDirection) {
      return new THREE.Quaternion();
    }

    const angle = Math.acos(THREE.MathUtils.clamp(parentDirection.dot(childDirection), -1, 1));
    const lean = THREE.MathUtils.degToRad(this.maxLeanAngle);
    const targetAngle = THREE.MathUtils.clamp(
      angle,
      Math.PI / 2 - lean,
      Math.PI / 2 + lean,
    );

    if (Math.abs(targetAngle - angle) <= ANGLE_EPSILON) {
      return new THREE.Quaternion();
    }

    // In-plane direction perpendicular to the parent, on the child's side.
    const planar = childDirection
      .clone()
      .addScaledVector(parentDirection, -childDirection.dot(parentDirection));
    const inPlane =
      planar.lengthSq() > DIRECTION_EPSILON * DIRECTION_EPSILON
        ? planar.normalize()
        : anyPerpendicular(parentDirection);

    const targetDirection = parentDirection
      .clone()
      .multiplyScalar(Math.cos(targetAngle))
      .addScaledVector(inPlane, Math.sin(targetAngle));

    return new THREE.Quaternion().setFromUnitVectors(childDirection, targetDirection);
  }

  // Compute the collar (child centerline crossing the parent tube surface) and hand the child
  // tube a parent-surface clip so its discs are booleaned against the parent. Run after all
  // joints have resolved, so it sees final geometry.
  resolveJunction(): void {
    const childTube = this.childLine.tube;

    if (!childTube) {
      return;
    }

    const parentTube = this.parentLine.tube;

    if (this.parentLine === this.childLine || !parentTube) {
      childTube.parentClip = null;
      this.collarT = 0;
      this.collarPoint.copy(this.childLine.getDrawnPointForIndex(this.childPointIndex));
      return;
    }

    const surface = makeParentSurface(
      this.parentLine.virtual.getDrawPoints(),
      (t) => parentTube.radiusAt(t),
    );
    childTube.parentClip = surface;

    const collar = computeCollar(this.childLine.virtual.getDrawPoints(), surface);
    this.collarT = collar.t;
    this.collarPoint.copy(collar.point);
  }

  // Direction the child leaves the joint, averaged over the first N base points
  // away from the joint vertex (N = `directionPoints`). N = 1 uses just the first
  // segment; larger N averages more points toward the overall branch direction.
  private getChildDirection(basePoints: THREE.Vector3[]): THREE.Vector3 | undefined {
    const pivotIndex = this.childPointIndex;
    const pivot = basePoints[pivotIndex];
    const step = pivotIndex === 0 ? 1 : -1;
    const available = step === 1 ? basePoints.length - 1 - pivotIndex : pivotIndex;

    if (available <= 0) {
      return undefined;
    }

    const count = Math.max(1, Math.min(Math.round(this.directionPoints), available));
    const centroid = new THREE.Vector3();

    for (let offset = 1; offset <= count; offset += 1) {
      centroid.add(basePoints[pivotIndex + step * offset]);
    }

    const direction = centroid.divideScalar(count).sub(pivot);

    if (direction.lengthSq() <= DIRECTION_EPSILON * DIRECTION_EPSILON) {
      return undefined;
    }

    return direction.normalize();
  }

  private getParentDirection(): THREE.Vector3 | undefined {
    const t = THREE.MathUtils.clamp(this.parentT, 0, 1);
    // Use the parent's structural (pre-modifier) direction so the fork angle is
    // measured against the trunk's actual heading, not twist/gnarl/coil wiggle.
    const before = this.parentLine.getBasePointAt(Math.max(0, t - TANGENT_EPSILON));
    const after = this.parentLine.getBasePointAt(Math.min(1, t + TANGENT_EPSILON));
    const direction = after.sub(before);

    if (direction.lengthSq() <= DIRECTION_EPSILON * DIRECTION_EPSILON) {
      return undefined;
    }

    return direction.normalize();
  }
}

function anyPerpendicular(axis: THREE.Vector3): THREE.Vector3 {
  const reference =
    Math.abs(axis.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);

  return reference.cross(axis).normalize();
}

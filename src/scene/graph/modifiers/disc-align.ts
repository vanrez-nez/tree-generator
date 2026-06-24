import * as THREE from "three";
import {
  createDefaultEnvelope,
  type LineModifier,
  type ModifierEnvelope,
} from "./modifier";
import { makePerpendicularBasis, sampleByArcLength } from "./utils";

export type DiscAlignModifierParams = {
  clearance: number; // the tube radius the discs must clear (injected per line by the tree)
  safety: number; // K: keep radius of curvature >= safety * clearance
  spacing: number; // target uniform arc-length spacing between points (0 = keep current count)
};

export type DiscAlignModifierOptions = Partial<DiscAlignModifierParams> & {
  enabled?: boolean;
  envelope?: ModifierEnvelope;
};

/**
 * Makes a line mesh-ready (`smooth_pipes.md`): the pipe of radius `clearance` is singularity-free
 * only while `clearance < reach`, whose local term is the radius of curvature. So we resample the
 * line to a uniform spacing and hard-clamp the turn per step to
 * `θmax = 2·asin(min(1, s / (2·K·clearance)))`, guaranteeing the discrete radius of curvature
 * `s / (2·sin(θ/2)) >= K·clearance` — i.e. the perpendicular discs can never cross on a bend. This
 * is a mathematical limit, not a relax pass.
 */
export class DiscAlignModifier implements LineModifier<DiscAlignModifierParams> {
  readonly name = "discAlign";
  enabled: boolean;
  envelope: ModifierEnvelope;
  params: DiscAlignModifierParams;

  constructor({
    clearance = 0,
    enabled = true,
    envelope = createDefaultEnvelope(),
    safety = 1.1,
    spacing = 0,
  }: DiscAlignModifierOptions = {}) {
    this.enabled = enabled;
    this.envelope = envelope;
    this.params = {
      clearance,
      safety,
      spacing,
    };
  }

  apply(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 2) {
      return points.map((point) => point.clone());
    }

    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      total += points[index - 1].distanceTo(points[index]);
    }

    if (total <= 1e-6) {
      return points.map((point) => point.clone());
    }

    // Uniform resample so the curvature test has a constant step.
    const segments =
      this.params.spacing > 1e-4
        ? THREE.MathUtils.clamp(Math.round(total / this.params.spacing), 4, 512)
        : Math.max(points.length - 1, 8);
    const resampled = sampleByArcLength(points, segments);
    const step = total / segments;

    const clearance = this.params.clearance;
    if (clearance <= 0) {
      return resampled;
    }

    // Hard limit on the turn per step from the local-reach condition.
    const safety = Math.max(this.params.safety, 1e-3);
    const sinHalf = THREE.MathUtils.clamp(step / (2 * safety * clearance), 0, 1);
    const maxTurn = 2 * Math.asin(sinHalf);

    const result: THREE.Vector3[] = [resampled[0].clone()];
    let heading = resampled[1].clone().sub(resampled[0]).normalize();
    result.push(resampled[0].clone().addScaledVector(heading, step));

    for (let index = 1; index < segments; index += 1) {
      const desired = resampled[index + 1].clone().sub(resampled[index]);

      if (desired.lengthSq() > 1e-12) {
        desired.normalize();
        const angle = Math.acos(THREE.MathUtils.clamp(heading.dot(desired), -1, 1));

        if (angle > maxTurn + 1e-9) {
          let axis = heading.clone().cross(desired);
          if (axis.lengthSq() < 1e-12) {
            axis = makePerpendicularBasis(heading)[0];
          }
          axis.normalize();
          heading = heading.clone().applyAxisAngle(axis, maxTurn);
        } else {
          heading = desired;
        }
      }

      result.push(result[index].clone().addScaledVector(heading, step));
    }

    return result;
  }
}

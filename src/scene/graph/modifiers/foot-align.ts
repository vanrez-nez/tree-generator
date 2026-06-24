import * as THREE from "three";
import {
  createDefaultEnvelope,
  type LineModifier,
  type ModifierEnvelope,
} from "./modifier";
import { smoothstep } from "./utils";

export type FootAlignModifierParams = {
  height: number;
  amount: number;
};

export type FootAlignModifierOptions = Partial<FootAlignModifierParams> & {
  enabled?: boolean;
  envelope?: ModifierEnvelope;
};

const FLOOR_NORMAL = new THREE.Vector3(0, 1, 0);

/**
 * Stands a line's foot up vertically: over the first `height` fraction of the line it rotates
 * each segment's heading toward the floor normal (+Y), easing back to the natural heading above
 * the foot. Placed last on a line, it guarantees the base tangent is vertical no matter what the
 * earlier modifiers (lean, gnarl, twist) did. The base point is preserved, so the line stays
 * anchored where it was.
 */
export class FootAlignModifier implements LineModifier<FootAlignModifierParams> {
  readonly name = "footAlign";
  enabled: boolean;
  envelope: ModifierEnvelope;
  params: FootAlignModifierParams;

  constructor({
    amount = 1,
    enabled = true,
    envelope = createDefaultEnvelope(),
    height = 0.15,
  }: FootAlignModifierOptions = {}) {
    this.enabled = enabled;
    this.envelope = envelope;
    this.params = {
      amount,
      height,
    };
  }

  apply(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 2 || this.params.amount <= 0) {
      return points.map((point) => point.clone());
    }

    const cumulative = [0];
    for (let index = 1; index < points.length; index += 1) {
      cumulative[index] = cumulative[index - 1] + points[index - 1].distanceTo(points[index]);
    }
    const total = cumulative[cumulative.length - 1];

    if (total <= 1e-6) {
      return points.map((point) => point.clone());
    }

    const amount = THREE.MathUtils.clamp(this.params.amount, 0, 1);
    const height = Math.max(this.params.height, 1e-3);

    const result: THREE.Vector3[] = [points[0].clone()];

    for (let index = 0; index < points.length - 1; index += 1) {
      const segment = points[index + 1].clone().sub(points[index]);
      const length = segment.length();

      if (length <= 1e-9) {
        result.push(result[index].clone());
        continue;
      }

      const heading = segment.divideScalar(length);
      const t = cumulative[index] / total;
      // Full at the base, eases to 0 at `height` and above.
      const weight = amount * smoothstep(Math.max(0, 1 - t / height));

      if (weight > 1e-6) {
        const toFloor = new THREE.Quaternion().setFromUnitVectors(heading, FLOOR_NORMAL);
        const partial = new THREE.Quaternion().slerp(toFloor, weight);
        heading.applyQuaternion(partial);
      }

      result.push(result[index].clone().addScaledVector(heading, length));
    }

    return result;
  }
}

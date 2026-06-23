import * as THREE from "three";
import {
  createDefaultEnvelope,
  type LineModifier,
  type ModifierEnvelope,
  type SeededModifierParams,
} from "./modifier";
import {
  makePerpendicularBasis,
  seededRandom,
} from "./utils";

export type TwistModifierParams = SeededModifierParams & {
  amount: number;
  radius: number;
  turns: number;
};

export type TwistModifierOptions = Partial<TwistModifierParams> & {
  enabled?: boolean;
  envelope?: ModifierEnvelope;
};

export class TwistModifier implements LineModifier<TwistModifierParams> {
  readonly name = "twist";
  enabled: boolean;
  envelope: ModifierEnvelope;
  params: TwistModifierParams;

  constructor({
    amount = 1,
    enabled = true,
    envelope = createDefaultEnvelope(),
    radius = 0.12,
    seed = 73192,
    turns = 1.5,
  }: TwistModifierOptions = {}) {
    this.enabled = enabled;
    this.envelope = envelope;
    this.params = {
      amount,
      radius,
      seed,
      turns,
    };
  }

  apply(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 2 || this.params.amount <= 0 || this.params.radius <= 0) {
      return points.map((point) => point.clone());
    }

    const first = points[0];
    const last = points[points.length - 1];
    const axis = last.clone().sub(first);
    const length = axis.length();

    if (length <= 1e-6) {
      return points.map((point) => point.clone());
    }

    axis.normalize();
    const [sideA, sideB] = makePerpendicularBasis(axis);
    const phase = seededRandom(this.params.seed ^ 0x517a3d) * Math.PI * 2;
    const sign = seededRandom(this.params.seed ^ 0x1b3f7a) >= 0.5 ? 1 : -1;
    const radius = this.params.radius * this.params.amount * length;
    const turns = this.params.turns * this.params.amount;

    return points.map((point, index) => {
      const t = index / (points.length - 1);
      const angle = phase + sign * turns * t * Math.PI * 2;
      const magnitude = radius;

      return point
        .clone()
        .addScaledVector(sideA, Math.cos(angle) * magnitude)
        .addScaledVector(sideB, Math.sin(angle) * magnitude);
    });
  }
}

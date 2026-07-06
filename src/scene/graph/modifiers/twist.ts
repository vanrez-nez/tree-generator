import {
  createDefaultMask,
  type LineModifier,
  type MaskedLine,
  maskWeight,
  type ModifierMask,
  type SeededModifierParams,
} from "./modifier";
import {
  anchorRampWeight,
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
  mask?: ModifierMask;
};

export class TwistModifier implements LineModifier<TwistModifierParams> {
  readonly name = "twist";
  enabled: boolean;
  mask: ModifierMask;
  params: TwistModifierParams;

  constructor({
    amount = 1,
    enabled = true,
    mask = createDefaultMask(),
    radius = 0.12,
    seed = 73192,
    turns = 1.5,
  }: TwistModifierOptions = {}) {
    this.enabled = enabled;
    this.mask = mask;
    this.params = {
      amount,
      radius,
      seed,
      turns,
    };
  }

  applyMasked(input: MaskedLine): MaskedLine {
    const { points, s } = input;

    if (points.length < 2 || this.params.amount <= 0 || this.params.radius <= 0) {
      return { points: points.map((point) => point.clone()), s };
    }

    const first = points[0];
    const last = points[points.length - 1];
    const axis = last.clone().sub(first);
    const length = axis.length();

    if (length <= 1e-6) {
      return { points: points.map((point) => point.clone()), s };
    }

    axis.normalize();
    const [sideA, sideB] = makePerpendicularBasis(axis);
    const phase = seededRandom(this.params.seed ^ 0x517a3d) * Math.PI * 2;
    const sign = seededRandom(this.params.seed ^ 0x1b3f7a) >= 0.5 ? 1 : -1;
    const radius = this.params.radius * this.params.amount * length;
    const turns = this.params.turns * this.params.amount;

    // Additive helix: wrap each point around the base axis by a masked radius. Outside the mask range the
    // weight is 0 → the point is unchanged. `anchorRampWeight(t)` keeps the base joint kink-free.
    const output = points.map((point, index) => {
      const t = s[index];
      const magnitude = radius * maskWeight(t, this.mask) * anchorRampWeight(t);

      if (magnitude <= 0) {
        return point.clone();
      }

      const angle = phase + sign * turns * t * Math.PI * 2;

      return point
        .clone()
        .addScaledVector(sideA, Math.cos(angle) * magnitude)
        .addScaledVector(sideB, Math.sin(angle) * magnitude);
    });

    return { points: output, s };
  }
}

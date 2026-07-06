import * as THREE from "three";
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
  makeValueNoise,
  seededRandom,
} from "./utils";

export type GnarlModifierParams = SeededModifierParams & {
  amplitude: number;
  amount: number;
  cycles: number;
  // World-axis locks: a locked axis is frozen, so the deform only operates in the unlocked ones.
  lockX: boolean;
  lockY: boolean;
  lockZ: boolean;
};

export type GnarlModifierOptions = Partial<GnarlModifierParams> & {
  enabled?: boolean;
  mask?: ModifierMask;
};

export class GnarlModifier implements LineModifier<GnarlModifierParams> {
  readonly name = "gnarl";
  enabled: boolean;
  mask: ModifierMask;
  params: GnarlModifierParams;

  constructor({
    amplitude = 0.25,
    amount = 1,
    cycles = 1.6,
    enabled = true,
    lockX = false,
    lockY = false,
    lockZ = false,
    mask = createDefaultMask(),
    seed = 73192,
  }: GnarlModifierOptions = {}) {
    this.enabled = enabled;
    this.mask = mask;
    this.params = {
      amplitude,
      amount,
      cycles,
      lockX,
      lockY,
      lockZ,
      seed,
    };
  }

  applyMasked(input: MaskedLine): MaskedLine {
    const { points, s } = input;

    if (points.length < 2 || this.params.amount <= 0 || this.params.amplitude <= 0) {
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
    const noise = makeValueNoise(this.params.seed);
    const phase = seededRandom(this.params.seed ^ 0x9e3779b1) * 64;
    const amplitude = this.params.amplitude * this.params.amount * length;

    // Additive perturbation: displace each point off the axis by a masked amount. Outside the mask range
    // the weight is 0 → the point is unchanged, so gnarl composes with other modifiers instead of
    // cancelling. `anchorRampWeight(t)` keeps the base joint kink-free when the range touches s = 0.
    const output = points.map((point, index) => {
      const t = s[index];
      const weight = maskWeight(t, this.mask) * anchorRampWeight(t);

      if (weight <= 0) {
        return point.clone();
      }

      const angleNoise = noise(t * this.params.cycles + phase);
      const radiusNoise = 0.65 + 0.35 * noise(t * this.params.cycles * 1.37 + phase + 17.23);
      const angle = angleNoise * Math.PI * 2;
      const magnitude = amplitude * radiusNoise * weight;

      const delta = new THREE.Vector3()
        .addScaledVector(sideA, Math.cos(angle) * magnitude)
        .addScaledVector(sideB, Math.sin(angle) * magnitude);

      if (this.params.lockX) delta.x = 0;
      if (this.params.lockY) delta.y = 0;
      if (this.params.lockZ) delta.z = 0;

      return point.clone().add(delta);
    });

    return { points: output, s };
  }
}

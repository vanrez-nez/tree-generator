import * as THREE from "three";
import {
  createDefaultEnvelope,
  type LineModifier,
  type ModifierEnvelope,
  type SeededModifierParams,
} from "./modifier";
import {
  makePerpendicularBasis,
  makeValueNoise,
  seededRandom,
} from "./utils";

export type GnarlModifierParams = SeededModifierParams & {
  amplitude: number;
  amount: number;
  cycles: number;
};

export type GnarlModifierOptions = Partial<GnarlModifierParams> & {
  enabled?: boolean;
  envelope?: ModifierEnvelope;
};

export class GnarlModifier implements LineModifier<GnarlModifierParams> {
  readonly name = "gnarl";
  enabled: boolean;
  envelope: ModifierEnvelope;
  params: GnarlModifierParams;

  constructor({
    amplitude = 0.25,
    amount = 1,
    cycles = 1.6,
    enabled = true,
    envelope = createDefaultEnvelope(),
    seed = 73192,
  }: GnarlModifierOptions = {}) {
    this.enabled = enabled;
    this.envelope = envelope;
    this.params = {
      amplitude,
      amount,
      cycles,
      seed,
    };
  }

  apply(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 2 || this.params.amount <= 0 || this.params.amplitude <= 0) {
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
    const noise = makeValueNoise(this.params.seed);
    const phase = seededRandom(this.params.seed ^ 0x9e3779b1) * 64;
    const amplitude = this.params.amplitude * this.params.amount * length;

    return points.map((point, index) => {
      const t = index / (points.length - 1);
      const angleNoise = noise(t * this.params.cycles + phase);
      const radiusNoise = 0.65 + 0.35 * noise(t * this.params.cycles * 1.37 + phase + 17.23);
      const angle = angleNoise * Math.PI * 2;
      const magnitude = amplitude * radiusNoise;

      return point
        .clone()
        .addScaledVector(sideA, Math.cos(angle) * magnitude)
        .addScaledVector(sideB, Math.sin(angle) * magnitude);
    });
  }
}

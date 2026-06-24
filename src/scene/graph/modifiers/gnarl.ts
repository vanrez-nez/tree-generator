import * as THREE from "three";
import {
  createDefaultEnvelope,
  type LineModifier,
  type ModifierEnvelope,
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
    lockX = false,
    lockY = false,
    lockZ = false,
    seed = 73192,
  }: GnarlModifierOptions = {}) {
    this.enabled = enabled;
    this.envelope = envelope;
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
      // Ramp displacement in from the anchor so the base-pinned point 0 doesn't kink.
      const magnitude = amplitude * radiusNoise * anchorRampWeight(t);

      const delta = new THREE.Vector3()
        .addScaledVector(sideA, Math.cos(angle) * magnitude)
        .addScaledVector(sideB, Math.sin(angle) * magnitude);

      if (this.params.lockX) delta.x = 0;
      if (this.params.lockY) delta.y = 0;
      if (this.params.lockZ) delta.z = 0;

      return point.clone().add(delta);
    });
  }
}

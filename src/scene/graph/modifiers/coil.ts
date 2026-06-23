import * as THREE from "three";
import {
  createDefaultEnvelope,
  type LineModifier,
  type ModifierEnvelope,
  type SeededModifierParams,
} from "./modifier";
import {
  getSampleSegments,
  makePerpendicularBasis,
  sampleByArcLength,
  seededRandom,
} from "./utils";

export type CoilModifierParams = SeededModifierParams & {
  amount: number;
  turns: number;
  bias: number;
};

export type CoilModifierOptions = Partial<CoilModifierParams> & {
  enabled?: boolean;
  envelope?: ModifierEnvelope;
};

/**
 * Coils a line by progressively bending its direction of travel along the
 * path. Unlike {@link TwistModifier}, which pushes each point radially around a
 * fixed axis (a helix wrapped around a straight centerline), the coil
 * reconstructs the line by rotating its heading cumulatively as it advances —
 * so the path rolls up on itself, like a tendril or root curling at the tip.
 */
export class CoilModifier implements LineModifier<CoilModifierParams> {
  readonly name = "coil";
  enabled: boolean;
  envelope: ModifierEnvelope;
  params: CoilModifierParams;

  constructor({
    amount = 1,
    bias = 1,
    enabled = true,
    envelope = createDefaultEnvelope(),
    seed = 73192,
    turns = 1.5,
  }: CoilModifierOptions = {}) {
    this.enabled = enabled;
    this.envelope = envelope;
    this.params = {
      amount,
      bias,
      seed,
      turns,
    };
  }

  apply(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 2 || this.params.amount <= 0 || this.params.turns === 0) {
      return points.map((point) => point.clone());
    }

    // Densify so even a 2-point straight line has enough segments to bend into
    // a smooth curl. Output length may differ from input; `applyEnvelope`
    // resamples the input to match before blending.
    const segments = getSampleSegments(points);
    const samples = sampleByArcLength(points, segments);

    if (samples.length < 2) {
      return points.map((point) => point.clone());
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    const axis = last.clone().sub(first);
    const length = axis.length();

    if (length <= 1e-6) {
      return points.map((point) => point.clone());
    }

    axis.normalize();
    const [sideA, sideB] = makePerpendicularBasis(axis);
    const phase = seededRandom(this.params.seed ^ 0x517a3d) * Math.PI * 2;
    const sign = seededRandom(this.params.seed ^ 0x1b3f7a) >= 0.5 ? 1 : -1;

    // The curl happens in the plane perpendicular to `bendAxis`; the seed picks
    // which perpendicular direction the line rolls toward.
    const bendAxis = sideA
      .clone()
      .multiplyScalar(Math.cos(phase))
      .addScaledVector(sideB, Math.sin(phase))
      .normalize();

    const totalTurn = sign * this.params.turns * this.params.amount * Math.PI * 2;
    const bias = Math.max(this.params.bias, 1e-3);
    const segmentCount = samples.length - 1;

    const result: THREE.Vector3[] = [samples[0].clone()];

    for (let index = 0; index < segmentCount; index += 1) {
      const segment = samples[index + 1].clone().sub(samples[index]);
      const segmentLength = segment.length();

      if (segmentLength <= 1e-9) {
        result.push(result[index].clone());
        continue;
      }

      // Rotate the heading by an angle that accumulates along arc length.
      // `bias` > 1 pushes the turning toward the tip (rolls up at the end),
      // `bias` < 1 toward the base.
      const t = index / segmentCount;
      const angle = totalTurn * Math.pow(t, bias);
      const heading = segment.divideScalar(segmentLength).applyAxisAngle(bendAxis, angle);

      result.push(result[index].clone().addScaledVector(heading, segmentLength));
    }

    return result;
  }
}

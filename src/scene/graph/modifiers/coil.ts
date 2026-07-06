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
  getSampleSegments,
  makePerpendicularBasis,
  sampleSWithArcLength,
  seededRandom,
} from "./utils";

export type CoilModifierParams = SeededModifierParams & {
  amount: number;
  turns: number;
  bias: number;
};

export type CoilModifierOptions = Partial<CoilModifierParams> & {
  enabled?: boolean;
  mask?: ModifierMask;
};

// Inner-loop smoothness: at least this many samples per winding so the tightly wound tip stays smooth.
const SAMPLES_PER_TURN = 64;
// Upper bound on samples so extreme tightness × turns can't blow up the vertex count.
const MAX_SEGMENTS = 1024;

/**
 * Coils a line by rolling a span of it into a flat logarithmic-spiral scroll (a volute / fiddlehead):
 * a near-straight shank whose tip winds inward to a tight center, loops nesting rather than crossing.
 *
 * As a RECONSTRUCTION it rebuilds geometry, so it operates only within its mask's `s`-range (the "body"):
 * the span before the range passes through unchanged, the body is reshaped into the spiral starting at the
 * body's base tangent, and the span after the range rigidly follows the reshaped end. The body's total arc
 * length (and hence spiral size) comes from the body span itself; the mask's fade ramps the turning at the
 * range edges for a tangent-continuous hand-off. `turns` is the visible winding count; `bias` sets the
 * TOTAL radius shrink R0/Rtip = e^bias across the whole spiral (not per turn), so more turns spread more
 * visible loops. The shrinking radius keeps curvature monotone (Tait–Kneser) → the spiral cannot self-cross.
 */
export class CoilModifier implements LineModifier<CoilModifierParams> {
  readonly name = "coil";
  enabled: boolean;
  mask: ModifierMask;
  params: CoilModifierParams;

  constructor({
    amount = 1,
    bias = 1.4,
    enabled = true,
    mask = createDefaultMask(),
    seed = 73192,
    turns = 1.25,
  }: CoilModifierOptions = {}) {
    this.enabled = enabled;
    this.mask = mask;
    this.params = {
      amount,
      bias,
      seed,
      turns,
    };
  }

  applyMasked(input: MaskedLine): MaskedLine {
    const { points, s } = input;
    const { amount, turns } = this.params;

    const identity = (): MaskedLine => ({ points: points.map((point) => point.clone()), s });
    if (points.length < 2 || amount <= 0 || turns === 0) {
      return identity();
    }

    // Body = the span whose material coordinate falls in the mask range. Pre passes through, post follows.
    const rangeStart = Math.min(this.mask.range.min, this.mask.range.max);
    const rangeEnd = Math.max(this.mask.range.min, this.mask.range.max);
    let bodyStart = 0;
    while (bodyStart < points.length && s[bodyStart] < rangeStart) bodyStart += 1;
    let bodyEnd = points.length - 1;
    while (bodyEnd >= 0 && s[bodyEnd] > rangeEnd) bodyEnd -= 1;
    if (bodyEnd - bodyStart < 1) {
      return identity();
    }

    // Densify the body, carrying s across the new samples.
    const windings = turns * amount;
    const segments = Math.min(
      Math.max(getSampleSegments(points.slice(bodyStart, bodyEnd + 1)), Math.ceil(SAMPLES_PER_TURN * windings)),
      MAX_SEGMENTS,
    );
    const body = sampleSWithArcLength(
      points.slice(bodyStart, bodyEnd + 1),
      s.slice(bodyStart, bodyEnd + 1),
      segments,
    );
    const samples = body.points;
    const bodyS = body.s;
    const count = samples.length;
    if (count < 2) {
      return identity();
    }

    // Base tangent = the direction the body enters (the pre→body segment when there is a pre span, else the
    // body's own first segment), so the scroll leaves its base tangent-continuously.
    const base = samples[0];
    const heading =
      bodyStart > 0
        ? samples[0].clone().sub(points[bodyStart - 1])
        : samples[1].clone().sub(samples[0]);
    const chord = samples[count - 1].clone().sub(samples[0]);
    const e1 = heading.length() > 1e-6 ? heading : chord;
    if (e1.length() <= 1e-6) {
      return identity();
    }
    e1.normalize();

    // Body arc length (its size drives the spiral radii).
    let length = 0;
    for (let index = 1; index < count; index += 1) {
      length += samples[index - 1].distanceTo(samples[index]);
    }
    if (length <= 1e-6) {
      return identity();
    }

    // Spiral parameters. Total radius ratio Q = e^bias (fixed, not per turn); b = ln(Q)/(2π·N).
    const tightness = Math.max(this.params.bias, 1e-3);
    const radiusRatio = Math.exp(tightness); // Q
    if (radiusRatio - 1 <= 1e-6) {
      return identity();
    }
    const bMag = tightness / (Math.PI * 2 * windings);
    const spiralConstant = Math.sqrt(1 + bMag * bMag) / bMag; // k: arc-from-center = k · radius
    const [sideA, sideB] = makePerpendicularBasis(e1);
    const phase = seededRandom(this.params.seed ^ 0x517a3d) * Math.PI * 2;
    const sign = seededRandom(this.params.seed ^ 0x1b3f7a) >= 0.5 ? 1 : -1;
    const bendAxis = sideA
      .clone()
      .multiplyScalar(Math.cos(phase))
      .addScaledVector(sideB, Math.sin(phase))
      .normalize();
    const e2 = bendAxis.clone().cross(e1).normalize();
    const rTip = length / (spiralConstant * (radiusRatio - 1));
    const r0 = radiusRatio * rTip;
    const angleScale = sign / bMag; // φ = angleScale · ln(R0 / r)

    const faded = this.mask.fadeIn > 1e-6 || this.mask.fadeOut > 1e-6;
    const bodyOut: THREE.Vector3[] = new Array(count);

    if (!faded) {
      // Exact log-spiral positions (no integration drift → tight inner windings stay nested at high turns).
      const canonical: { x: number; y: number }[] = new Array(count);
      for (let index = 0; index < count; index += 1) {
        const t = index / (count - 1);
        const r = r0 - (t * length) / spiralConstant;
        const phi = angleScale * Math.log(r0 / r);
        canonical[index] = { x: r * Math.cos(phi), y: r * Math.sin(phi) };
      }
      const q0 = canonical[0];
      const q1 = canonical[1];
      const tangentLength = Math.hypot(q1.x - q0.x, q1.y - q0.y) || 1;
      const cos = (q1.x - q0.x) / tangentLength;
      const sin = (q1.y - q0.y) / tangentLength;
      for (let index = 0; index < count; index += 1) {
        const dx = canonical[index].x - q0.x;
        const dy = canonical[index].y - q0.y;
        const localX = cos * dx + sin * dy;
        const localY = -sin * dx + cos * dy;
        bodyOut[index] = base.clone().addScaledVector(e1, localX).addScaledVector(e2, localY);
      }
      bodyOut[0] = base.clone();
    } else {
      // Fade the TURNING by the mask (a partial coil): straight where weight is 0, winding up where it is 1.
      // Integrate at each segment's midpoint turn to avoid drift across many windings.
      bodyOut[0] = base.clone();
      let turn = 0;
      let previousPhi = 0;
      for (let index = 1; index < count; index += 1) {
        const t = index / (count - 1);
        const r = r0 - (t * length) / spiralConstant;
        const phi = angleScale * Math.log(r0 / r);
        const previousTurn = turn;
        turn += (phi - previousPhi) * maskWeight(bodyS[index], this.mask);
        previousPhi = phi;
        const midTurn = (previousTurn + turn) * 0.5;
        const segmentLength = samples[index].distanceTo(samples[index - 1]);
        bodyOut[index] = bodyOut[index - 1]
          .clone()
          .addScaledVector(e1, Math.cos(midTurn) * segmentLength)
          .addScaledVector(e2, Math.sin(midTurn) * segmentLength);
      }
    }

    // Assemble: pre (unchanged) + reshaped body + post (rigidly follows the reshaped end).
    const outPoints: THREE.Vector3[] = [];
    const outS: number[] = [];
    for (let index = 0; index < bodyStart; index += 1) {
      outPoints.push(points[index].clone());
      outS.push(s[index]);
    }
    for (let index = 0; index < count; index += 1) {
      outPoints.push(bodyOut[index]);
      outS.push(bodyS[index]);
    }
    if (bodyEnd + 1 < points.length) {
      const originalEnd = samples[count - 1];
      const originalTangent = samples[count - 1].clone().sub(samples[count - 2]).normalize();
      const newEnd = bodyOut[count - 1];
      const newTangent = bodyOut[count - 1].clone().sub(bodyOut[count - 2]).normalize();
      const follow = new THREE.Quaternion().setFromUnitVectors(originalTangent, newTangent);
      for (let index = bodyEnd + 1; index < points.length; index += 1) {
        outPoints.push(points[index].clone().sub(originalEnd).applyQuaternion(follow).add(newEnd));
        outS.push(s[index]);
      }
    }

    return { points: outPoints, s: outS };
  }
}

import * as THREE from "three";
import {
  createDefaultMask,
  type LineModifier,
  type MaskedLine,
  maskWeight,
  type ModifierMask,
} from "./modifier";
import { sampleSWithArcLength } from "./utils";

export type SmoothMode = "laplacian" | "spline";

export type SmoothModifierParams = {
  iterations: number;
  mode: SmoothMode;
  segments: number;
  strength: number;
};

export type SmoothModifierOptions = Partial<SmoothModifierParams> & {
  enabled?: boolean;
  mask?: ModifierMask;
};

export class SmoothModifier implements LineModifier<SmoothModifierParams> {
  readonly name = "smooth";
  enabled: boolean;
  mask: ModifierMask;
  params: SmoothModifierParams;

  constructor({
    enabled = true,
    iterations = 1,
    mask = createDefaultMask(),
    mode = "laplacian",
    segments = 16,
    strength = 0.5,
  }: SmoothModifierOptions = {}) {
    this.enabled = enabled;
    this.mask = mask;
    this.params = {
      iterations,
      mode,
      segments,
      strength,
    };
  }

  applyMasked(input: MaskedLine): MaskedLine {
    if (input.points.length < 2) {
      return { points: input.points.map((point) => point.clone()), s: input.s };
    }

    // Resample by arc length (carrying s), then smooth. The smoothing amount is scaled by the mask, so
    // smoothing can be scoped to a span; outside the range the resampled point passes through unchanged.
    const segments = Math.max(1, Math.floor(this.params.segments));
    const { points, s } = sampleSWithArcLength(input.points, input.s, segments);

    if (this.params.mode === "spline" && points.length >= 3) {
      const curve = new THREE.CatmullRomCurve3(points);
      const output = points.map((point, index) => {
        const target = curve.getPoint(index / (points.length - 1));
        return point.clone().lerp(target, maskWeight(s[index], this.mask));
      });
      return { points: output, s };
    }

    let smoothed = points.map((point) => point.clone());
    const iterations = Math.max(1, Math.floor(this.params.iterations));
    const strength = THREE.MathUtils.clamp(this.params.strength, 0, 1);

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const next = smoothed.map((point) => point.clone());
      for (let index = 1; index < smoothed.length - 1; index += 1) {
        const average = smoothed[index - 1].clone().add(smoothed[index + 1]).multiplyScalar(0.5);
        next[index].lerp(average, strength * maskWeight(s[index], this.mask));
      }
      smoothed = next;
    }

    return { points: smoothed, s };
  }
}

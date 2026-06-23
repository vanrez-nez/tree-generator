import * as THREE from "three";
import type { LineModifier } from "./modifier";

export type SmoothMode = "laplacian" | "spline";

export type SmoothModifierParams = {
  iterations: number;
  mode: SmoothMode;
  strength: number;
};

export type SmoothModifierOptions = Partial<SmoothModifierParams> & {
  enabled?: boolean;
};

export class SmoothModifier implements LineModifier<SmoothModifierParams> {
  readonly name = "smooth";
  enabled: boolean;
  params: SmoothModifierParams;

  constructor({
    enabled = true,
    iterations = 1,
    mode = "laplacian",
    strength = 0.5,
  }: SmoothModifierOptions = {}) {
    this.enabled = enabled;
    this.params = {
      iterations,
      mode,
      strength,
    };
  }

  apply(points: THREE.Vector3[]): THREE.Vector3[] {
    if (this.params.mode === "spline") {
      return this.applySpline(points);
    }

    return this.applyLaplacian(points);
  }

  private applySpline(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 3) {
      return points.map((point) => point.clone());
    }

    const steps = points.length - 1;
    const curve = new THREE.CatmullRomCurve3(points);
    const splinePoints: THREE.Vector3[] = [];

    for (let step = 0; step <= steps; step += 1) {
      splinePoints.push(curve.getPoint(step / steps));
    }

    return splinePoints;
  }

  private applyLaplacian(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 3) {
      return points.map((point) => point.clone());
    }

    let smoothedPoints = points.map((point) => point.clone());
    const iterations = Math.max(1, Math.floor(this.params.iterations));
    const strength = THREE.MathUtils.clamp(this.params.strength, 0, 1);

    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const nextPoints = smoothedPoints.map((point) => point.clone());

      for (let index = 1; index < smoothedPoints.length - 1; index += 1) {
        const average = smoothedPoints[index - 1]
          .clone()
          .add(smoothedPoints[index + 1])
          .multiplyScalar(0.5);
        nextPoints[index].lerp(average, strength);
      }

      smoothedPoints = nextPoints;
    }

    return smoothedPoints;
  }
}

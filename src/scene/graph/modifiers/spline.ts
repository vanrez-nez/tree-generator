import * as THREE from "three";
import type { LineModifier } from "./modifier";

export type SplineModifierParams = {
  segments: number;
};

export type SplineModifierOptions = Partial<SplineModifierParams> & {
  enabled?: boolean;
};

export class SplineModifier implements LineModifier<SplineModifierParams> {
  readonly name = "spline";
  enabled: boolean;
  params: SplineModifierParams;

  constructor({ enabled = true, segments = 64 }: SplineModifierOptions = {}) {
    this.enabled = enabled;
    this.params = { segments };
  }

  apply(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 3) {
      return points.map((point) => point.clone());
    }

    const steps = Math.max(1, Math.floor(this.params.segments));
    const curve = new THREE.CatmullRomCurve3(points);
    const splinePoints: THREE.Vector3[] = [];

    for (let step = 0; step <= steps; step += 1) {
      splinePoints.push(curve.getPoint(step / steps));
    }

    return splinePoints;
  }
}

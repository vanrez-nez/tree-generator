import * as THREE from "three";
import {
  createDefaultEnvelope,
  type LineModifier,
  type ModifierEnvelope,
} from "./modifier";

export type SmoothMode = "laplacian" | "spline";

export type SmoothModifierParams = {
  iterations: number;
  mode: SmoothMode;
  segments: number;
  strength: number;
};

export type SmoothModifierOptions = Partial<SmoothModifierParams> & {
  enabled?: boolean;
  envelope?: ModifierEnvelope;
};

export class SmoothModifier implements LineModifier<SmoothModifierParams> {
  readonly name = "smooth";
  enabled: boolean;
  envelope: ModifierEnvelope;
  params: SmoothModifierParams;

  constructor({
    enabled = true,
    envelope = createDefaultEnvelope(),
    iterations = 1,
    mode = "laplacian",
    segments = 16,
    strength = 0.5,
  }: SmoothModifierOptions = {}) {
    this.enabled = enabled;
    this.envelope = envelope;
    this.params = {
      iterations,
      mode,
      segments,
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
    if (points.length < 2) {
      return points.map((point) => point.clone());
    }

    const steps = Math.max(1, Math.floor(this.params.segments));

    if (points.length < 3) {
      return samplePolyline(points, steps);
    }

    const curve = new THREE.CatmullRomCurve3(points);
    const splinePoints: THREE.Vector3[] = [];

    for (let step = 0; step <= steps; step += 1) {
      splinePoints.push(curve.getPoint(step / steps));
    }

    return splinePoints;
  }

  private applyLaplacian(points: THREE.Vector3[]): THREE.Vector3[] {
    if (points.length < 2) {
      return points.map((point) => point.clone());
    }

    let smoothedPoints = samplePolyline(
      points,
      Math.max(1, Math.floor(this.params.segments)),
    );

    if (smoothedPoints.length < 3) {
      return smoothedPoints;
    }

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

function samplePolyline(points: THREE.Vector3[], segments: number): THREE.Vector3[] {
  const cumulativeLengths = [0];

  for (let index = 1; index < points.length; index += 1) {
    cumulativeLengths[index] =
      cumulativeLengths[index - 1] + points[index - 1].distanceTo(points[index]);
  }

  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];

  if (totalLength <= 1e-6) {
    return points.map((point) => point.clone());
  }

  const samples: THREE.Vector3[] = [];

  for (let step = 0; step <= segments; step += 1) {
    samples.push(sampleAtDistance(points, cumulativeLengths, totalLength * (step / segments)));
  }

  return samples;
}

function sampleAtDistance(
  points: THREE.Vector3[],
  cumulativeLengths: number[],
  distance: number,
): THREE.Vector3 {
  const lastIndex = points.length - 1;
  let index = 0;

  while (index < lastIndex - 1 && cumulativeLengths[index + 1] < distance) {
    index += 1;
  }

  const segmentLength = Math.max(1e-9, cumulativeLengths[index + 1] - cumulativeLengths[index]);
  const localT = THREE.MathUtils.clamp(
    (distance - cumulativeLengths[index]) / segmentLength,
    0,
    1,
  );

  return points[index].clone().lerp(points[index + 1], localT);
}

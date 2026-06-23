import * as THREE from "three";

// Generic cubic-Bézier easing solved by x (the same Newton + subdivision method modifier.ts
// uses internally for envelope curves). `curve` is the two control points [x1, y1, x2, y2];
// the implicit endpoints are (0, 0) and (1, 1).

export type CubicBezierCurve = [number, number, number, number];

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_ITERATIONS = 10;
const SUBDIVISION_PRECISION = 0.0000001;

export function cubicBezierEasing(x: number, [x1, y1, x2, y2]: CubicBezierCurve): number {
  const clampedX = THREE.MathUtils.clamp(x, 0, 1);
  const t = solveCurveX(clampedX, x1, x2);

  return THREE.MathUtils.clamp(sampleCurve(t, y1, y2), 0, 1);
}

function solveCurveX(x: number, x1: number, x2: number): number {
  let t = x;

  for (let index = 0; index < NEWTON_ITERATIONS; index += 1) {
    const slope = sampleCurveDerivative(t, x1, x2);

    if (slope < NEWTON_MIN_SLOPE) {
      break;
    }

    t -= (sampleCurve(t, x1, x2) - x) / slope;
  }

  if (Math.abs(sampleCurve(t, x1, x2) - x) < SUBDIVISION_PRECISION) {
    return t;
  }

  let start = 0;
  let end = 1;
  t = x;

  for (let index = 0; index < SUBDIVISION_ITERATIONS; index += 1) {
    const currentX = sampleCurve(t, x1, x2);

    if (Math.abs(currentX - x) < SUBDIVISION_PRECISION) {
      return t;
    }

    if (x > currentX) {
      start = t;
    } else {
      end = t;
    }

    t = (start + end) * 0.5;
  }

  return t;
}

function sampleCurve(t: number, a1: number, a2: number): number {
  return ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;
}

function sampleCurveDerivative(t: number, a1: number, a2: number): number {
  return 3 * (1 - 3 * a2 + 3 * a1) * t * t + 2 * (3 * a2 - 6 * a1) * t + 3 * a1;
}

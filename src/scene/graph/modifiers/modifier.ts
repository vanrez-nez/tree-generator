import * as THREE from "three";

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_ITERATIONS = 10;
const SUBDIVISION_PRECISION = 0.0000001;

export type ModifierRange = {
  min: number;
  max: number;
};

export type ModifierEnvelope = {
  fadeInEnabled: boolean;
  fadeIn: ModifierRange;
  fadeOutEnabled: boolean;
  fadeOut: ModifierRange;
  curve: [number, number, number, number];
};

export type LineModifier<TParams extends object = Record<string, unknown>> = {
  readonly name: string;
  enabled: boolean;
  envelope: ModifierEnvelope;
  params: TParams;
  apply: (points: THREE.Vector3[]) => THREE.Vector3[];
};

export type SeededModifierParams = {
  seed: number;
};

export function createDefaultEnvelope(): ModifierEnvelope {
  return {
    fadeInEnabled: false,
    fadeIn: { min: 0, max: 0.5 },
    fadeOutEnabled: false,
    fadeOut: { min: 0.5, max: 1 },
    curve: [0.5, 0, 0.5, 1],
  };
}

export function applyEnvelope(
  inputPoints: THREE.Vector3[],
  outputPoints: THREE.Vector3[],
  envelope: ModifierEnvelope,
): THREE.Vector3[] {
  const pointCount = outputPoints.length;
  const envelopeInputPoints =
    inputPoints.length === outputPoints.length
      ? inputPoints
      : resamplePolyline(inputPoints, pointCount);

  return outputPoints.map((point, index) => {
    const t = pointCount <= 1 ? 0 : index / (pointCount - 1);
    const weight = getEnvelopeWeight(t, envelope);

    return envelopeInputPoints[index].clone().lerp(point, weight);
  });
}

export function getEnvelopeWeight(t: number, envelope: ModifierEnvelope): number {
  const fadeInWeight = envelope.fadeInEnabled
    ? getFadeInWeight(t, envelope.fadeIn, envelope.curve)
    : 1;
  const fadeOutWeight = envelope.fadeOutEnabled
    ? getFadeOutWeight(t, envelope.fadeOut, envelope.curve)
    : 1;

  return fadeInWeight * fadeOutWeight;
}

function getFadeInWeight(
  t: number,
  range: ModifierRange,
  curve: ModifierEnvelope["curve"],
): number {
  const [start, end] = normalizeRange(range);

  if (t <= start) {
    return 0;
  }

  if (t >= end) {
    return 1;
  }

  return cubicBezier((t - start) / Math.max(end - start, Number.EPSILON), curve);
}

function getFadeOutWeight(
  t: number,
  range: ModifierRange,
  curve: ModifierEnvelope["curve"],
): number {
  const [start, end] = normalizeRange(range);

  if (t <= start) {
    return 1;
  }

  if (t >= end) {
    return 0;
  }

  return 1 - cubicBezier((t - start) / Math.max(end - start, Number.EPSILON), curve);
}

function normalizeRange(range: ModifierRange): [number, number] {
  const min = THREE.MathUtils.clamp(range.min, 0, 1);
  const max = THREE.MathUtils.clamp(range.max, 0, 1);

  return min <= max ? [min, max] : [max, min];
}

function cubicBezier(x: number, [x1, y1, x2, y2]: ModifierEnvelope["curve"]): number {
  const clampedX = THREE.MathUtils.clamp(x, 0, 1);
  const t = solveCurveX(clampedX, x1, x2);

  return THREE.MathUtils.clamp(sampleCurveY(t, y1, y2), 0, 1);
}

function solveCurveX(x: number, x1: number, x2: number): number {
  let t = x;

  for (let index = 0; index < NEWTON_ITERATIONS; index += 1) {
    const slope = sampleCurveDerivativeX(t, x1, x2);

    if (slope < NEWTON_MIN_SLOPE) {
      break;
    }

    t -= (sampleCurveX(t, x1, x2) - x) / slope;
  }

  if (Math.abs(sampleCurveX(t, x1, x2) - x) < SUBDIVISION_PRECISION) {
    return t;
  }

  let start = 0;
  let end = 1;
  t = x;

  for (let index = 0; index < SUBDIVISION_ITERATIONS; index += 1) {
    const currentX = sampleCurveX(t, x1, x2);

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

function sampleCurveX(t: number, x1: number, x2: number): number {
  return sampleCurve(t, x1, x2);
}

function sampleCurveY(t: number, y1: number, y2: number): number {
  return sampleCurve(t, y1, y2);
}

function sampleCurveDerivativeX(t: number, x1: number, x2: number): number {
  return (
    3 * (1 - 3 * x2 + 3 * x1) * t * t +
    2 * (3 * x2 - 6 * x1) * t +
    3 * x1
  );
}

function sampleCurve(t: number, a1: number, a2: number): number {
  return ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;
}

function resamplePolyline(points: THREE.Vector3[], pointCount: number): THREE.Vector3[] {
  if (points.length === 0) {
    return [];
  }

  if (points.length === 1 || pointCount <= 1) {
    return [points[0].clone()];
  }

  const cumulativeLengths = [0];

  for (let index = 1; index < points.length; index += 1) {
    cumulativeLengths[index] =
      cumulativeLengths[index - 1] + points[index - 1].distanceTo(points[index]);
  }

  const totalLength = cumulativeLengths[cumulativeLengths.length - 1];

  if (totalLength <= 1e-6) {
    return Array.from({ length: pointCount }, () => points[0].clone());
  }

  return Array.from({ length: pointCount }, (_value, index) =>
    sampleAtDistance(
      points,
      cumulativeLengths,
      totalLength * (index / (pointCount - 1)),
    ),
  );
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

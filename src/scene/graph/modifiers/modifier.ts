import * as THREE from "three";

const NEWTON_ITERATIONS = 4;
const NEWTON_MIN_SLOPE = 0.001;
const SUBDIVISION_ITERATIONS = 10;
const SUBDIVISION_PRECISION = 0.0000001;

export type ModifierRange = {
  min: number;
  max: number;
};

// LEGACY envelope shape. Kept only so old saved documents keep loading; `createModifier` migrates it to
// a `ModifierMask`. Nothing at runtime evaluates it anymore.
export type ModifierEnvelope = {
  fadeInEnabled: boolean;
  fadeIn: ModifierRange;
  fadeOutEnabled: boolean;
  fadeOut: ModifierRange;
  curve: [number, number, number, number];
};

// A modifier's spatial scope along the line, in the stable material coordinate `s` (arc-length fraction of
// the REST line, carried through the whole stack). The modifier's effect is 0 outside `[start, end]`,
// ramps up over the first `fadeIn` of s inside the range, plateaus at full strength, then ramps down over
// the last `fadeOut`. This replaces the old position-blend envelope: a modifier scales its OWN effect by
// `maskWeight`, so modifiers partition/compose cleanly instead of cross-fading toward each other's input.
export type ModifierMask = {
  range: ModifierRange; // { min, max } in s — the span the modifier acts on
  fadeIn: number; // ramp width in s at the range min; 0 = hard edge
  fadeOut: number; // ramp width in s at the range max; 0 = hard edge
  curve: [number, number, number, number];
};

// A polyline plus the stable material coordinate `s` (arc-length fraction on the rest line) of every point.
// `points` and `s` are always the same length; `s` is monotone non-decreasing from 0 to 1. Modifiers read
// `s[i]` (never the index) so a range like "0–80%" addresses the same physical span regardless of what
// other modifiers did to the shape or point count.
export type MaskedLine = {
  points: THREE.Vector3[];
  s: number[];
};

export type LineModifier<TParams extends object = Record<string, unknown>> = {
  readonly name: string;
  enabled: boolean;
  mask: ModifierMask;
  params: TParams;
  // Transform the line, applying the modifier's effect scaled by its `mask` and returning both the points
  // and their carried `s`. Perturbations add a masked offset; reconstructions reshape only the mask range.
  applyMasked: (input: MaskedLine) => MaskedLine;
};

export type SeededModifierParams = {
  seed: number;
};

export function createDefaultMask(): ModifierMask {
  return {
    range: { min: 0, max: 1 },
    fadeIn: 0,
    fadeOut: 0,
    curve: [0.5, 0, 0.5, 1],
  };
}

// Back-compat: build a mask from a legacy `ModifierEnvelope` so old saved documents keep loading. The old
// fadeIn/fadeOut ranges become the mask's range extent + edge ramp widths.
export function envelopeToMask(envelope?: ModifierEnvelope): ModifierMask {
  if (!envelope) {
    return createDefaultMask();
  }
  return {
    range: {
      min: envelope.fadeInEnabled ? envelope.fadeIn.min : 0,
      max: envelope.fadeOutEnabled ? envelope.fadeOut.max : 1,
    },
    fadeIn: envelope.fadeInEnabled ? Math.max(0, envelope.fadeIn.max - envelope.fadeIn.min) : 0,
    fadeOut: envelope.fadeOutEnabled ? Math.max(0, envelope.fadeOut.max - envelope.fadeOut.min) : 0,
    curve: envelope.curve,
  };
}

// Effect strength at `s`: 0 outside the range, eased ramps at the edges, 1 on the plateau.
export function maskWeight(s: number, mask: ModifierMask): number {
  const start = Math.min(mask.range.min, mask.range.max);
  const end = Math.max(mask.range.min, mask.range.max);

  if (s < start || s > end) {
    return 0;
  }

  const up =
    mask.fadeIn > 1e-6 ? cubicBezier(clamp01((s - start) / mask.fadeIn), mask.curve) : 1;
  const down =
    mask.fadeOut > 1e-6 ? cubicBezier(clamp01((end - s) / mask.fadeOut), mask.curve) : 1;

  return up * down;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function cubicBezier(x: number, [x1, y1, x2, y2]: ModifierMask["curve"]): number {
  const clampedX = clamp01(x);
  const t = solveCurveX(clampedX, x1, x2);

  return clamp01(sampleCurveY(t, y1, y2));
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
  return 3 * (1 - 3 * x2 + 3 * x1) * t * t + 2 * (3 * x2 - 6 * x1) * t + 3 * x1;
}

function sampleCurve(t: number, a1: number, a2: number): number {
  return ((1 - 3 * a2 + 3 * a1) * t + (3 * a2 - 6 * a1)) * t * t + 3 * a1 * t;
}

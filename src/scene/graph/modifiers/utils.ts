import * as THREE from "three";
import type { MaskedLine } from "./modifier";

export function getSampleSegments(points: THREE.Vector3[]): number {
  return Math.max(points.length - 1, 64);
}

// Resample a polyline to `segments + 1` uniform-arc-length points and stamp the material coordinate
// `s_i = i / segments`. Used once at the top of the stack to build the stable grid every modifier reads.
export function resampleWithS(points: THREE.Vector3[], segments: number): MaskedLine {
  const resampled = sampleByArcLength(points, segments);
  const count = resampled.length;
  const s = resampled.map((_point, index) => (count <= 1 ? 0 : index / (count - 1)));
  return { points: resampled, s };
}

// Resample points to `segments + 1` uniform-arc-length samples AND carry the input's `s` through — each
// new sample's `s` is the input `s` interpolated at the same arc distance. Count-changing modifiers
// (coil body, smooth, disc-align) use this so every output point keeps a valid material coordinate.
export function sampleSWithArcLength(
  points: THREE.Vector3[],
  s: number[],
  segments: number,
): MaskedLine {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) {
    cumulative[index] = cumulative[index - 1] + points[index - 1].distanceTo(points[index]);
  }
  const total = cumulative[cumulative.length - 1];

  if (points.length < 2 || total <= 1e-6) {
    return { points: points.map((point) => point.clone()), s: s.slice() };
  }

  const outPoints: THREE.Vector3[] = [];
  const outS: number[] = [];
  const last = points.length - 1;

  for (let step = 0; step <= segments; step += 1) {
    const distance = total * (step / segments);
    let index = 0;
    while (index < last - 1 && cumulative[index + 1] < distance) {
      index += 1;
    }
    const segmentLength = Math.max(1e-9, cumulative[index + 1] - cumulative[index]);
    const localT = THREE.MathUtils.clamp((distance - cumulative[index]) / segmentLength, 0, 1);
    outPoints.push(points[index].clone().lerp(points[index + 1], localT));
    outS.push(THREE.MathUtils.lerp(s[index], s[index + 1], localT));
  }

  return { points: outPoints, s: outS };
}

export function sampleByArcLength(
  points: THREE.Vector3[],
  segments: number,
): THREE.Vector3[] {
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

export function sampleAtDistance(
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

export function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

// Eases a per-point displacement in from the line's anchor (t = 0), so a base-pinned line has no
// kink at the joint: 0 at the anchor, ramping smoothly to full over the first `ANCHOR_RAMP` of the
// line. Displacement modifiers that offset points off the centerline (gnarl, twist) scale by this.
const ANCHOR_RAMP = 0.2;
export function anchorRampWeight(t: number): number {
  return smoothstep(Math.min(1, Math.max(0, t) / ANCHOR_RAMP));
}

export function makePerpendicularBasis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const fallback =
    Math.abs(axis.dot(_worldUp)) > 0.95 ? _worldRight : _worldUp;
  const sideA = fallback.clone().cross(axis).normalize();
  const sideB = axis.clone().cross(sideA).normalize();

  return [sideA, sideB];
}

export type Frame = {
  tangent: THREE.Vector3;
  normal: THREE.Vector3;
  binormal: THREE.Vector3;
};

// Rotation-minimizing frames along a polyline (double reflection, Wang et al. 2008). Propagates a
// single coherent frame so consecutive cross-sections share the same roll — no twist between rings,
// which is what mesh-ready discs need. `tangents` must be unit vectors aligned with `positions`.
export function rotationMinimizingFrames(
  positions: THREE.Vector3[],
  tangents: THREE.Vector3[],
): Frame[] {
  const count = positions.length;

  if (count === 0) {
    return [];
  }

  const seedNormal = makePerpendicularBasis(tangents[0])[0];
  const frames: Frame[] = [
    {
      tangent: tangents[0].clone(),
      normal: seedNormal.clone(),
      binormal: tangents[0].clone().cross(seedNormal).normalize(),
    },
  ];

  for (let index = 0; index < count - 1; index += 1) {
    const previous = frames[index];
    const tangent = tangents[index + 1];

    const v1 = positions[index + 1].clone().sub(positions[index]);
    const c1 = v1.dot(v1);

    // Reflect the previous normal + tangent across the plane bisecting the two points.
    const reflectedNormal =
      c1 < 1e-12
        ? previous.normal.clone()
        : previous.normal.clone().addScaledVector(v1, (-2 / c1) * v1.dot(previous.normal));
    const reflectedTangent =
      c1 < 1e-12
        ? previous.tangent.clone()
        : previous.tangent.clone().addScaledVector(v1, (-2 / c1) * v1.dot(previous.tangent));

    // Second reflection aligns the reflected tangent with the next tangent.
    const v2 = tangent.clone().sub(reflectedTangent);
    const c2 = v2.dot(v2);
    const normal =
      c2 < 1e-12
        ? reflectedNormal
        : reflectedNormal.addScaledVector(v2, (-2 / c2) * v2.dot(reflectedNormal));

    normal.addScaledVector(tangent, -tangent.dot(normal)).normalize();

    frames.push({
      tangent: tangent.clone(),
      normal,
      binormal: tangent.clone().cross(normal).normalize(),
    });
  }

  return frames;
}

export function makeValueNoise(seed: number): (x: number) => number {
  return (x: number) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = hashNoise(seed, i);
    const b = hashNoise(seed, i + 1);

    return THREE.MathUtils.lerp(a, b, smoothstep(f));
  };
}

export function hashNoise(seed: number, index: number): number {
  let hash = (seed ^ Math.imul(index, 0x9e3779b1)) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;

  return (hash >>> 0) / 0xffffffff;
}

export function seededRandom(seed: number): number {
  return hashNoise(seed, 0);
}

const _worldUp = new THREE.Vector3(0, 1, 0);
const _worldRight = new THREE.Vector3(1, 0, 0);

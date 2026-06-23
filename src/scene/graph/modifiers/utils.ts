import * as THREE from "three";

export function getSampleSegments(points: THREE.Vector3[]): number {
  return Math.max(points.length - 1, 64);
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

export function makePerpendicularBasis(axis: THREE.Vector3): [THREE.Vector3, THREE.Vector3] {
  const fallback =
    Math.abs(axis.dot(_worldUp)) > 0.95 ? _worldRight : _worldUp;
  const sideA = fallback.clone().cross(axis).normalize();
  const sideB = axis.clone().cross(sideA).normalize();

  return [sideA, sideB];
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

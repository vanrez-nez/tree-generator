import * as THREE from "three";

// The single resolved form of a drawn line: the exact polyline the fat-line geometry uploads, plus the
// ONE reader every debug/control dot uses to place itself. Because the geometry and the dots both read
// this same object — the same `points` array, the same `pointAt`, the same `drawable` gate — a dot is the
// line's own data by construction and cannot drift off it. There is no separate re-derivation and no
// origin fallback: a dot is either a point on `points`, or it does not exist (see `drawable`).
export class ResolvedLine {
  constructor(readonly points: readonly THREE.Vector3[]) {}

  // The line — and therefore any dot on it — exists only when there is a span to draw. This is the SAME
  // condition the fat line uses to show/hide itself, so the line and its dots share one fate.
  get drawable(): boolean {
    return this.points.length >= 2;
  }

  // The only way to get a point on the line: an arc-length sample of `points`. Precondition: `drawable`
  // (callers gate on it), so `points[0]`/`points[1]` exist and the result always lies on the drawn
  // polyline. Writes into `target` so callers can pass a mesh's `.position` directly.
  pointAt(t: number, target: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 {
    const points = this.points;

    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      total += points[index - 1].distanceTo(points[index]);
    }
    if (total <= 1e-9) {
      return target.copy(points[0]);
    }

    const goal = t * total;
    let travelled = 0;
    for (let index = 1; index < points.length; index += 1) {
      const segment = points[index - 1].distanceTo(points[index]);
      if (travelled + segment >= goal || index === points.length - 1) {
        // `local` is a within-segment fraction between two on-line points, so the result stays on the
        // segment (the clamp only guards float overshoot at t = 1); it never leaves the polyline.
        const local = segment <= 1e-9 ? 0 : (goal - travelled) / segment;
        return target.copy(points[index - 1]).lerp(points[index], local < 0 ? 0 : local > 1 ? 1 : local);
      }
      travelled += segment;
    }
    return target.copy(points[points.length - 1]);
  }
}

// Arc-length fraction (0..1) of each point along the polyline. Used to place per-authored-point dots at
// the matching arc position on the drawn line, and by the junction collar sampler.
export function getPolylinePointTs(points: readonly THREE.Vector3[]): number[] {
  if (points.length === 0) {
    return [];
  }

  if (points.length === 1) {
    return [0];
  }

  const distances = [0];

  for (let index = 1; index < points.length; index += 1) {
    distances[index] = distances[index - 1] + points[index - 1].distanceTo(points[index]);
  }

  const totalDistance = distances[distances.length - 1];

  if (totalDistance <= 1e-6) {
    return points.map((_point, index) => index / Math.max(points.length - 1, 1));
  }

  return distances.map((distance) => distance / totalDistance);
}

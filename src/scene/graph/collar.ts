import * as THREE from "three";

// The "collar" is where a child line exits its parent's tube surface — the structural junction
// where the limb emerges. Built on a signed distance to the parent tube volume (a tapered tube
// around the parent's drawn polyline), shared by the collar crossing and the per-disc boolean
// clip in line-tube.ts.

export type ParentSurface = {
  points: THREE.Vector3[];
  radiusAt: (t: number) => number;
  cumulative: number[]; // arc length to each point
  total: number;
};

export type Collar = {
  t: number; // arc-length fraction along the child where it crosses out of the parent
  point: THREE.Vector3;
};

export function makeParentSurface(
  points: THREE.Vector3[],
  radiusAt: (t: number) => number,
): ParentSurface {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + points[i - 1].distanceTo(points[i]);
  }
  return { points, radiusAt, cumulative, total: cumulative[cumulative.length - 1] ?? 0 };
}

const _q = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

// Signed distance from `p` to the parent tube surface: < 0 inside, > 0 outside, 0 on surface.
export function signedDistance(surface: ParentSurface, p: THREE.Vector3): number {
  const { points, cumulative, total } = surface;

  if (points.length < 2 || total <= 1e-9) {
    return p.distanceTo(points[0] ?? p) - surface.radiusAt(0);
  }

  let bestDist = Infinity;
  let bestArc = 0;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    _ab.subVectors(points[i + 1], a);
    const segLenSq = _ab.lengthSq();
    const local =
      segLenSq <= 1e-12 ? 0 : THREE.MathUtils.clamp(_ap.subVectors(p, a).dot(_ab) / segLenSq, 0, 1);
    _q.copy(a).addScaledVector(_ab, local);
    const dist = p.distanceTo(_q);

    if (dist < bestDist) {
      bestDist = dist;
      bestArc = (cumulative[i] + local * Math.sqrt(segLenSq)) / total;
    }
  }

  return bestDist - surface.radiusAt(bestArc);
}

// Bisection for the surface crossing (signedDistance = 0) between inside point `a` and outside
// point `b`. Returns a position lying on the parent surface.
export function findCrossing(
  a: THREE.Vector3,
  b: THREE.Vector3,
  surface: ParentSurface,
  iterations = 18,
): THREE.Vector3 {
  const lo = a.clone();
  const hi = b.clone();
  const mid = new THREE.Vector3();

  for (let i = 0; i < iterations; i += 1) {
    mid.copy(lo).lerp(hi, 0.5);
    if (signedDistance(surface, mid) < 0) {
      lo.copy(mid);
    } else {
      hi.copy(mid);
    }
  }

  return lo.lerp(hi, 0.5);
}

// Crossing point between `p` and `q` regardless of which is inside.
export function surfaceCrossing(
  p: THREE.Vector3,
  q: THREE.Vector3,
  surface: ParentSurface,
): THREE.Vector3 {
  return signedDistance(surface, p) < 0
    ? findCrossing(p, q, surface)
    : findCrossing(q, p, surface);
}

// Where the child centerline exits the parent tube. The child starts inside (point 0 is on the
// parent centerline); we walk to the first outside vertex and bisect the crossing.
export function computeCollar(
  childPoints: THREE.Vector3[],
  surface: ParentSurface | null,
): Collar {
  if (!surface || childPoints.length < 2) {
    return { t: 0, point: (childPoints[0] ?? new THREE.Vector3()).clone() };
  }

  const cumulative = [0];
  for (let i = 1; i < childPoints.length; i += 1) {
    cumulative[i] = cumulative[i - 1] + childPoints[i - 1].distanceTo(childPoints[i]);
  }
  const total = cumulative[cumulative.length - 1];

  if (total <= 1e-9) {
    return { t: 0, point: childPoints[0].clone() };
  }

  for (let i = 1; i < childPoints.length; i += 1) {
    if (signedDistance(surface, childPoints[i]) >= 0) {
      const point = findCrossing(childPoints[i - 1], childPoints[i], surface);
      const segLen = Math.max(1e-9, cumulative[i] - cumulative[i - 1]);
      const local = THREE.MathUtils.clamp(point.distanceTo(childPoints[i - 1]) / segLen, 0, 1);
      return { t: (cumulative[i - 1] + local * segLen) / total, point };
    }
  }

  return { t: 1, point: childPoints[childPoints.length - 1].clone() };
}

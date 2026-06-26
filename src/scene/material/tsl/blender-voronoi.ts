import { Fn, float, int, vec3, floor } from "three/tsl";
import type { MaterialValue } from "../graph/types";

// Faithful TSL port of Blender's Voronoi (F1 feature) — plan L4 / decision 2. Transcribed verbatim from
// Blender GPU source:
//   - cell hash: gpu_shader_common_hash.glsl — hash_pcg3d_i (int3 PCG) + hash_int3_to_vec3
//     (mask & 0x7fffffff, * 1/float(0x7fffffff))
//   - feature:   gpu_shader_material_voronoi.glsl — voronoi_distance (metric) + voronoi_f1 (3×3×3 loop)
// Verified against a pure-JS implementation of the same algorithm (the authoritative per-node check),
// and bake-compared to Blender. Distance metrics: 0=Euclidean, 1=Manhattan, 2=Chebychev (Minkowski
// needs an exponent input — deferred). Only the F1 Distance output is ported here; F2 / Smooth F1 /
// Distance-to-Edge and the Color/Position outputs are the remaining Voronoi work.

type V = MaterialValue;

// float(0x7fffffff) rounds to 2147483648 in f32 — match Blender's divisor exactly.
const INV_2147483648 = 1 / 0x80000000;

// hash_pcg3d_i(k) then hash_int3_to_vec3: int3 → vec3 in [0,1]. kx/ky/kz are int nodes. Uses scalar
// toVar locals (not an ivec3) to make the in-place sequential cross-terms explicit.
function hashInt3ToVec3(kx: V, ky: V, kz: V): V {
  const x = kx.mul(1664525).add(1013904223).toVar();
  const y = ky.mul(1664525).add(1013904223).toVar();
  const z = kz.mul(1664525).add(1013904223).toVar();
  x.assign(x.add(y.mul(z)));
  y.assign(y.add(z.mul(x)));
  z.assign(z.add(x.mul(y)));
  x.assign(x.bitXor(x.shiftRight(16)));
  y.assign(y.bitXor(y.shiftRight(16)));
  z.assign(z.bitXor(z.shiftRight(16)));
  x.assign(x.add(y.mul(z)));
  y.assign(y.add(z.mul(x)));
  z.assign(z.add(x.mul(y)));
  const mask = int(0x7fffffff);
  return vec3(
    float(x.bitAnd(mask)).mul(INV_2147483648),
    float(y.bitAnd(mask)).mul(INV_2147483648),
    float(z.bitAnd(mask)).mul(INV_2147483648),
  );
}

// voronoi_distance for one metric (build-time selected). a, b are vec3.
function voronoiDistance(a: V, b: V, metric: number): V {
  if (metric === 1) {
    // Manhattan
    const d = a.sub(b).abs();
    return d.x.add(d.y).add(d.z);
  }
  if (metric === 2) {
    // Chebychev
    const d = a.sub(b).abs();
    return d.x.max(d.y.max(d.z));
  }
  // Euclidean (default)
  return a.sub(b).length();
}

// voronoi_f1 for 3D: the 3×3×3 cell search tracking the closest point. `want` selects which output to
// return — Distance (float), Color (vec3 = hash of the winning cell), or Position (vec3 = winning point
// in world space). Each output re-runs the loop (called once per connected output). `randomness` is a
// live uniform; `metric` is build-time.
type F1Output = "distance" | "color" | "position";

function voronoiF1(coord: V, randomness: V, metric: number, want: F1Output): V {
  return Fn(() => {
    const cell = floor(coord) as V; // floor()'s TS return narrows to float; keep vec component access
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const cz = int(cell.z);
    const minDist = float(1e10).toVar();
    const targetOffset = vec3(0, 0, 0).toVar();
    const targetPosition = vec3(0, 0, 0).toVar();
    for (let k = -1; k <= 1; k++) {
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const offset = vec3(i, j, k);
          const pointPosition = offset.add(
            hashInt3ToVec3(cx.add(i), cy.add(j), cz.add(k)).mul(randomness),
          );
          const d = voronoiDistance(pointPosition, local, metric);
          const closer = d.lessThan(minDist);
          minDist.assign(closer.select(d, minDist));
          targetOffset.assign(closer.select(offset, targetOffset));
          targetPosition.assign(closer.select(pointPosition, targetPosition));
        }
      }
    }
    if (want === "color") {
      return hashInt3ToVec3(
        cx.add(int(targetOffset.x)),
        cy.add(int(targetOffset.y)),
        cz.add(int(targetOffset.z)),
      );
    }
    if (want === "position") return targetPosition.add(cell);
    return minDist;
  })();
}

export const blenderVoronoiF1 = (coord: V, randomness: V, metric: number): V =>
  voronoiF1(coord, randomness, metric, "distance");
export const blenderVoronoiColor = (coord: V, randomness: V, metric: number): V =>
  voronoiF1(coord, randomness, metric, "color");
export const blenderVoronoiPosition = (coord: V, randomness: V, metric: number): V =>
  voronoiF1(coord, randomness, metric, "position");

// voronoi_distance_to_edge for 3D (two passes): find the closest point, then the minimum distance to the
// perpendicular bisector between it and each neighbour. Uses squared Euclidean (dot), independent of the
// metric — matching Blender. Transcribed verbatim from gpu_shader_material_voronoi.glsl.
export function blenderVoronoiDistanceToEdge(coord: V, randomness: V): V {
  return Fn(() => {
    const cell = floor(coord) as V;
    const local = coord.sub(cell);
    const cx = int(cell.x);
    const cy = int(cell.y);
    const cz = int(cell.z);
    const point = (i: number, j: number, k: number): V =>
      vec3(i, j, k).add(hashInt3ToVec3(cx.add(i), cy.add(j), cz.add(k)).mul(randomness)).sub(local);

    const vectorToClosest = vec3(0, 0, 0).toVar();
    const minDist = float(1e10).toVar();
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const vp = point(i, j, k);
          const d = vp.dot(vp);
          const closer = d.lessThan(minDist);
          minDist.assign(closer.select(d, minDist));
          vectorToClosest.assign(closer.select(vp, vectorToClosest));
        }

    const minEdge = float(1e10).toVar();
    for (let k = -1; k <= 1; k++)
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const vp = point(i, j, k);
          const perp = vp.sub(vectorToClosest);
          const onEdge = perp.dot(perp).greaterThan(0.0001);
          const distanceToEdge = vectorToClosest.add(vp).div(2).dot(perp.normalize());
          minEdge.assign(onEdge.select(minEdge.min(distanceToEdge), minEdge));
        }
    return minEdge;
  })();
}

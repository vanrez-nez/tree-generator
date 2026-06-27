import { vec2, vec3, float, int, floor, clamp, length, pow, smoothstep } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { blenderVoronoiF1 } from "../blender-voronoi";
import { hashCell2ToVec3 } from "./hash";

// Cellular noises for the library. `worley` reuses the already-periodic Blender Voronoi F1 (its cell hash
// wraps to an integer period → seamless). `voronoi-smooth` is the @lumiey `voronoi12`: a CHEAP 3×3 (9-tap)
// soft-min blend of neighbouring cell values — periodic via the wrapped cell hash. (Blender's Smooth-F1 is a
// 5×5×5 / 125-tap loop that, ×supersampling ×octaves, overruns the GPU and causes a device loss — so it is
// deliberately NOT used here.) Bases take the period-scaled 2D coord `p` and a square period (cellular noises
// ignore aspect). Returns [0,1].
type V = MaterialValue;
const EXPONENT = float(2); // Minkowski exponent (unused for the Euclidean metric, m = 0)
const RANDOMNESS = float(1);
const SMOOTH_EXP = 2.0; // 1 / edge-smoothness (smoothness 0.5)

// Worley (F1): 1 − distance-to-nearest-feature, in [0,1].
export function worleyBase01(p: V, period: number, _perY: number): V {
  const d = blenderVoronoiF1(vec3(p.x, p.y, float(0)), RANDOMNESS, 0, EXPONENT, period) as V;
  return clamp(float(1).sub(d), 0, 1) as V;
}

// Smooth Voronoi value (@lumiey voronoi12): soft-min weighted average of neighbouring cell values. [0,1].
export function voronoiSmoothBase01(p: V, perX: number, perY: number): V {
  const i = floor(p) as V;
  const f = p.sub(i) as V;
  const ix = int(i.x);
  const iy = int(i.y);
  let va: V = float(0);
  let wt: V = float(0);
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const o = hashCell2ToVec3(ix.add(dx), iy.add(dy), perX, perY) as V; // xy = offset, z = cell value
      const d = length(vec2(dx, dy).sub(f).add(vec2(o.x, o.y))) as V;
      const ww = pow(smoothstep(1.414, 0, d), SMOOTH_EXP) as V;
      va = va.add(o.z.mul(ww)) as V;
      wt = wt.add(ww) as V;
    }
  return va.div(wt.max(1e-4)) as V;
}

import { float, int, floor, sin, dot, mix } from "three/tsl";
import type { MaterialValue } from "../../graph/types";
import { hashCell2ToVec2 } from "./hash";

// Gabor-like noise (@lumiey gabor12), made SEAMLESS. The original blends per-cell sinusoids
// `sin(kF·dot(p, g))` using the GLOBAL position p, which is not periodic — it seams at the tile edge.
// The periodic variant snaps each cell's frequency vector to INTEGER cycles-per-period: with `gInt` integer
// and phase `dot(p, gInt)·(2π/period)`, advancing p by one period changes the phase by an integer multiple
// of 2π, so the field wraps exactly. Orientation still varies per cell (from the wrapped cell hash). Returns
// [0,1]. `p` is the period-scaled coord; `perX`(== perY here, square period) is the build-time period.
type V = MaterialValue;
const TAU = 6.283185307179586;
const MAX_FREQ = 4; // integer cycles per period, 1..MAX_FREQ

export function gaborBase01(p: V, perX: number | V, _perY: number | V): V {
  const i = floor(p) as V;
  const f = p.sub(i) as V;
  const u = f.mul(f).mul(float(3).sub(f.mul(2))) as V; // smoothstep weights
  const ix = int(i.x);
  const iy = int(i.y);
  const w = float(TAU).div(perX) as V; // square period → same angular scale on both axes (node div: perX may be a uniform)
  const k = (dx: number, dy: number): V => {
    const h = hashCell2ToVec2(ix.add(dx), iy.add(dy), perX, _perY) as V;
    // integer frequency vector in [1, MAX_FREQ] per axis → periodic global phase
    const gInt = floor(h.mul(MAX_FREQ)).add(1) as V;
    return sin(dot(p, gInt).mul(w));
  };
  const n = mix(mix(k(0, 0), k(1, 0), u.x), mix(k(0, 1), k(1, 1), u.x), u.y) as V;
  return n.mul(0.5).add(0.5);
}

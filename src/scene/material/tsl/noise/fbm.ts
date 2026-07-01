import { vec2, float } from "three/tsl";
import type { MaterialValue } from "../../graph/types";

// Generic periodic fBm for the noise library: sums a base noise over octaves whose period scales by 2^o
// (lacunarity pinned to 2 so every octave's integer period stays integer → the sum tiles seamlessly over the
// uv tile, exactly like tileableFbm). The base returns ~[0,1]; the result is the amplitude-weighted average,
// also ~[0,1]. `octaves` is a build-time count (JS loop unroll), `gain` a live uniform.
type V = MaterialValue;

// base(p, perX, perY): noise sampled at the (already period-scaled) coordinate `p`, wrapping its integer
// cells at (perX, perY). Returns ~[0,1].
export type NoiseBase01 = (p: V, perX: number, perY: number) => V;

export function periodicFbm01(
  uv2: V,
  periodX: number | V,
  periodY: number | V,
  octaves: number,
  gain: V,
  base: NoiseBase01,
): V {
  // The base period may be a JS number (build-time) OR a uniform node (a live-tweakable `scale` that
  // re-renders without recompiling). Coerce to a node so the octave scaling (×2^o) and the wrap use node math
  // either way; a numeric period is rounded/clamped up front, a uniform one is expected already integer
  // (rounded in-shader by the caller — see tileable-noise.ts) so the lattice still tiles.
  const px: V = typeof periodX === "number" ? float(Math.max(1, Math.round(periodX))) : periodX;
  const py: V = typeof periodY === "number" ? float(Math.max(1, Math.round(periodY))) : periodY;
  let sum: V = float(0);
  let ampSum: V = float(0);
  let amp: V = float(1);
  for (let o = 0; o < Math.max(1, octaves); o++) {
    const f = 1 << o; // 2^o
    const pxo = px.mul(f) as V;
    const pyo = py.mul(f) as V;
    const p = uv2.mul(vec2(pxo, pyo)) as V;
    sum = sum.add(amp.mul(base(p, pxo, pyo))) as V;
    ampSum = ampSum.add(amp) as V;
    amp = amp.mul(gain) as V;
  }
  return sum.div(ampSum.max(1e-4)) as V;
}

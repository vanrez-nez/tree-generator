import { Fn, float, int, vec2, vec3, floor } from "three/tsl";
import type { MaterialValue } from "../../graph/types";

// Shared integer hashes for the noise library (src/scene/material/tsl/noise/). The PERIODIC noise variants
// must hash the wrapped integer CELL INDEX (mod period), not floatBitsToUint of the float coordinate — only
// the former can tile. This is the same PCG3D integer hash used by the Voronoi port (blender-voronoi.ts);
// kept here as the single home for the noise-lib so those files don't reach into Voronoi internals.
type V = MaterialValue;
const INV_2147483648 = 1 / 0x80000000; // float(0x7fffffff) rounds to 2147483648 in f32

// PCG3D integer hash → vec3 in [0,1). Transcribed from gpu_shader_common_hash.glsl (hash_pcg3d_i). Wrapped
// in Fn so the stateful .toVar()/.assign() sequence emits correctly at EVERY call site (an inline call
// outside an Fn scope collapses the assignments → a constant). The Voronoi port calls this inside its own
// Fn; the value/gradient noises call it directly, so the Fn wrapper is required here.
export const hashInt3ToVec3 = Fn(([kx, ky, kz]: V[]): V => {
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
});

// Floored modulo of an integer cell coordinate into [0, period) — wrapping the hash input makes the lattice
// periodic (cell at index `period` matches index 0), so the offline tile edge is seamless. period <= 0 → no
// wrap (faithful, non-tiling — used for the live/3D preview path).
function wrapAxis(v: V, period: number): V {
  if (period <= 0) return v;
  return v.sub(int(floor(float(v).div(period))).mul(int(period)));
}

// Scalar hash in [0,1) of a 2D integer cell, wrapped per-axis (anisotropic periods supported).
export function hashCell2(ix: V, iy: V, perX: number, perY: number): V {
  return hashInt3ToVec3(wrapAxis(ix, perX), wrapAxis(iy, perY), int(0)).x;
}

// vec2 hash in [0,1) of a 2D integer cell (e.g. gradient / feature-point offsets), wrapped per-axis.
export function hashCell2ToVec2(ix: V, iy: V, perX: number, perY: number): V {
  const h = hashInt3ToVec3(wrapAxis(ix, perX), wrapAxis(iy, perY), int(0));
  return vec2(h.x, h.y);
}

// vec3 hash in [0,1) of a 2D integer cell (xy = feature-point offset, z = cell value), wrapped per-axis.
export function hashCell2ToVec3(ix: V, iy: V, perX: number, perY: number): V {
  return hashInt3ToVec3(wrapAxis(ix, perX), wrapAxis(iy, perY), int(0));
}

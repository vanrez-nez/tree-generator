import { float, vec3, sin, floor } from "three/tsl";
import { blenderFbm } from "./blender-noise";
import type { MaterialValue } from "../graph/types";

// Faithful TSL port of Blender's Wave Texture (Fac output) — plan L4. Transcribed verbatim from
// gpu_shader_material_tex_wave.glsl `calc_wave`. Bands/Rings × Sine/Saw/Triangle, with optional fBm
// distortion (reuses the faithful Noise port). Modes are build-time selects; phase/distortion/detail
// scale+roughness are live uniforms; detail (octaves) is a build-time loop count. Verified against a
// pure-JS port of the same function.
type V = MaterialValue;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

export interface WaveOpts {
  waveType: number; // 0 bands, 1 rings
  dir: number; // 0 x, 1 y, 2 z, 3 diagonal/spherical
  profile: number; // 0 sine, 1 saw, 2 triangle
  withDistortion: boolean; // gate the fBm term (skip when distortion param is 0)
  detail: number; // fBm octaves (build-time)
}

export function blenderWave(
  pScaled: V,
  phase: V,
  distortion: V,
  detailScale: V,
  detailRoughness: V,
  opts: WaveOpts,
): V {
  const p = pScaled.add(0.000001).mul(0.999999);
  let n: V;
  if (opts.waveType === 0) {
    // bands
    if (opts.dir === 0) n = p.x.mul(20);
    else if (opts.dir === 1) n = p.y.mul(20);
    else if (opts.dir === 2) n = p.z.mul(20);
    else n = p.x.add(p.y).add(p.z).mul(10);
  } else {
    // rings
    let rp: V = p;
    if (opts.dir === 0) rp = p.mul(vec3(0, 1, 1));
    else if (opts.dir === 1) rp = p.mul(vec3(1, 0, 1));
    else if (opts.dir === 2) rp = p.mul(vec3(1, 1, 0));
    n = rp.length().mul(20);
  }
  n = n.add(phase);
  if (opts.withDistortion) {
    // noise_fbm(p*detail_scale, detail, detail_roughness, lacunarity=2, normalize=true) * 2 - 1
    const fbm = blenderFbm(p.mul(detailScale), opts.detail, detailRoughness, float(2));
    n = n.add(distortion.mul(fbm.mul(2).sub(1)));
  }
  if (opts.profile === 0) return float(0.5).add(sin(n.sub(HALF_PI)).mul(0.5)); // sine
  if (opts.profile === 1) {
    const m = n.div(TAU);
    return m.sub(floor(m)); // saw
  }
  const m = n.div(TAU);
  return m.sub(floor(m.add(0.5))).abs().mul(2); // triangle
}

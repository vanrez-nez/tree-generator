import { mx_fractal_noise_float } from "three/tsl";
import type { MaterialNodeDef } from "../types";

// Fractal Brownian Motion (MaterialX fractal noise) over the coordinate domain. The generic
// substrate generator — replaces the old hand-written Perlin/FBM GLSL (glsl/noise.ts, height.ts).
// `octaves` drives a JS-side loop unroll so it is read raw (not as a dynamic uniform).
export const fbmNode: MaterialNodeDef = {
  type: "fbm",
  nodeClass: "texture",
  label: "FBM Field",
  // Optional `coord` input lets a Domain Warp (or any vector source) drive the domain; unconnected, it
  // falls back to the global coordinate (positionWorld live / uv-slice baked).
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1.2 },
    { key: "octaves", label: "octaves", type: "int", min: 1, max: 8, step: 1, default: 4 },
    { key: "lacunarity", label: "lacunarity", type: "float", min: 1.5, max: 3, step: 0.05, default: 2 },
    { key: "gain", label: "gain", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  build(ctx) {
    const p = (ctx.inputs.coord ?? ctx.coord).div(ctx.uniforms.scale);
    const octaves = (ctx.params.octaves as number) ?? 4;
    // mx_fractal_noise_float(position, octaves, lacunarity, diminish) -> ~[-1,1]; remap to [0,1].
    const field = mx_fractal_noise_float(p, octaves, ctx.uniforms.lacunarity, ctx.uniforms.gain)
      .mul(0.5)
      .add(0.5);
    return { field };
  },
};

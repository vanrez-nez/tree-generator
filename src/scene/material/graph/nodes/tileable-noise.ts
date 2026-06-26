import { vec2, float } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../types";
import { tileableFbm } from "../../tsl/tileable-noise";
import { blenderFbm } from "../../tsl/blender-noise";

type V = MaterialValue;

// Tileable Noise — periodic fBm (tsl/tileable-noise.ts `pnoise2`) that bakes SEAMLESS in the offline
// backend (it's authored for the 2D uv tile, unlike Blender's 3D noise). `scale` = detail (base period,
// integer for exact tiling); `aspect` stretches the X period for directional grain (bark fibers); octaves
// is a build-time loop unroll. In the LIVE backend (3D positionWorld, no tiling needed) it falls back to
// the existing `blenderFbm` so the preview still shows a reasonable field.
export const tileableNoiseNode: MaterialNodeDef = {
  type: "tileable-noise",
  nodeClass: "texture",
  label: "Tileable Noise",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "scale", label: "scale", type: "int", min: 1, max: 24, step: 1, default: 5 },
    { key: "aspect", label: "aspect", type: "float", min: 1, max: 8, step: 0.5, default: 1 },
    { key: "octaves", label: "detail", type: "int", min: 1, max: 8, step: 1, default: 4 },
    { key: "gain", label: "roughness", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    const scale = Math.max(1, Math.round(Number(ctx.params.scale ?? 5)));
    const aspect = Number(ctx.params.aspect ?? 1);
    const octaves = Math.max(1, Number(ctx.params.octaves ?? 4));

    if (ctx.backend === "live") {
      // No tiling in the seamless-3D preview; reuse the Blender fBm over the world coordinate.
      const p = coord.mul(scale) as V;
      return { field: blenderFbm(p, octaves, ctx.uniforms.gain, float(2)) };
    }
    // offline: periodic fBm over the uv tile → seamless. aspect elongates features along Y (fibers).
    const uv2 = vec2(coord.x, coord.y) as V;
    const n = tileableFbm(uv2, scale * aspect, scale, octaves, ctx.uniforms.gain as V);
    return { field: n.mul(0.5).add(0.5) }; // [-1,1] → [0,1]
  },
};

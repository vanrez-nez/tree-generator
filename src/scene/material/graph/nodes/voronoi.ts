import { mx_worley_noise_float } from "three/tsl";
import type { MaterialNodeDef } from "../types";

// MaterialX Worley/cellular field — the generic Voronoi operator (replaces the hand-rolled JFA in
// cells.ts). Drives plates, cracks, scattered cell masks, etc.
export const voronoiNode: MaterialNodeDef = {
  type: "voronoi",
  nodeClass: "texture",
  label: "Voronoi / Cells",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1 },
    { key: "jitter", label: "jitter", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
  ],
  build(ctx) {
    const domain = (ctx.inputs.coord ?? ctx.coord).div(ctx.uniforms.scale);
    return { field: mx_worley_noise_float(domain, ctx.uniforms.jitter) };
  },
};

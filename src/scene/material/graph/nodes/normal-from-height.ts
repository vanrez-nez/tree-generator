import { bumpMap, float } from "three/tsl";
import type { MaterialNodeDef } from "../types";

// Derives a perturbed surface normal from a scalar height field via TSL's bumpMap (screen-space
// derivative bump). Generic replacement for the bespoke normal.ts central-difference pass.
export const normalFromHeightNode: MaterialNodeDef = {
  type: "normal-from-height",
  nodeClass: "vector",
  label: "Normal From Height",
  inputs: [{ key: "height", kind: "float" }],
  outputs: [{ key: "normal", kind: "vector" }],
  params: [
    { key: "strength", label: "strength", type: "float", min: 0, max: 4, step: 0.05, default: 1 },
  ],
  build(ctx) {
    const h = ctx.inputs.height ?? float(0.5);
    // In the baked backend, bake the height to a texture first so the (often heavy) procedural height
    // graph isn't re-evaluated per fragment — the bump then reads a cheap texture fetch. Identity in live.
    return { normal: bumpMap(ctx.bake(h), ctx.uniforms.strength) };
  },
};

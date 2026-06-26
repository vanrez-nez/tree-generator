import { bumpMap, float } from "three/tsl";
import type { MaterialNodeDef } from "../types";

// Derives a perturbed surface normal from a scalar height field via TSL's bumpMap (screen-space
// derivative bump). Generic replacement for the bespoke normal.ts central-difference pass.
export const normalFromHeightNode: MaterialNodeDef = {
  type: "normal-from-height",
  category: "adapter",
  label: "Normal From Height",
  inputs: [{ key: "height", kind: "field" }],
  outputs: [{ key: "normal", kind: "normal" }],
  params: [
    { key: "strength", label: "strength", type: "float", min: 0, max: 4, step: 0.05, default: 1 },
  ],
  build(ctx) {
    const h = ctx.inputs.height ?? float(0.5);
    return { normal: bumpMap(h, ctx.uniforms.strength) };
  },
};

import { bumpMap, float, vec3, normalize, dFdx, dFdy, uv } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../types";

type V = MaterialValue; // loose TSL value (= any); the three/tsl overloads are stricter than we need.

// Derives a surface normal from a scalar height field — backend-aware:
//   live    → bumpMap (screen-space derivative bump over positionWorld; a perturbed world normal).
//   offline → an ENCODED tangent-space normal map: from the height's uv-gradient. Dividing the height
//             derivative by the uv derivative (dFdx(h)/dFdx(uv.x)) yields dh/du independent of bake
//             resolution. Baked into the normal RT and sampled on the surface via triplanarNormalMap (and
//             this is what the exported normal-map PNG contains).
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
    if (ctx.backend === "live") {
      return { normal: bumpMap(h, ctx.uniforms.strength) };
    }
    // offline: tangent-space normal from the resolution-independent uv-gradient of the height.
    const hv = h as V;
    const u = uv() as V;
    const dhdu = dFdx(hv).div(dFdx(u.x)) as V;
    const dhdv = dFdy(hv).div(dFdy(u.y)) as V;
    const s = ctx.uniforms.strength as V;
    const n = normalize(vec3(dhdu.negate().mul(s), dhdv.negate().mul(s), float(1))) as V;
    return { normal: n.mul(0.5).add(0.5) }; // encode [-1,1] → [0,1] for the normal-map texture
  },
};

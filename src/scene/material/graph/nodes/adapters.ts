import { luminance, vec3, float } from "three/tsl";
import type { MaterialNodeDef } from "../types";

// Typed bridges between port kinds (material-graph-plan.md): the explicit adapters that make e.g.
// a colour drive a roughness field, or per-channel masks recombine into a colour.

export const luminanceNode: MaterialNodeDef = {
  type: "luminance",
  category: "adapter",
  label: "Luminance",
  inputs: [{ key: "color", kind: "color" }],
  outputs: [{ key: "field", kind: "field" }],
  params: [],
  build(ctx) {
    const c = ctx.inputs.color;
    return { field: c ? luminance(c) : float(0) };
  },
};

export const splitChannelsNode: MaterialNodeDef = {
  type: "split-channels",
  category: "adapter",
  label: "Split Channels",
  inputs: [{ key: "color", kind: "color" }],
  outputs: [
    { key: "r", kind: "field" },
    { key: "g", kind: "field" },
    { key: "b", kind: "field" },
  ],
  params: [],
  build(ctx) {
    const c = ctx.inputs.color;
    if (!c) return { r: float(0), g: float(0), b: float(0) };
    return { r: c.x, g: c.y, b: c.z };
  },
};

export const combineChannelsNode: MaterialNodeDef = {
  type: "combine-channels",
  category: "adapter",
  label: "Combine Channels",
  inputs: [
    { key: "r", kind: "field" },
    { key: "g", kind: "field" },
    { key: "b", kind: "field" },
  ],
  outputs: [{ key: "color", kind: "color" }],
  params: [],
  build(ctx) {
    return {
      color: vec3(ctx.inputs.r ?? float(0), ctx.inputs.g ?? float(0), ctx.inputs.b ?? float(0)),
    };
  },
};

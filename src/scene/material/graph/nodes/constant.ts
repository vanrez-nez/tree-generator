import type { MaterialNodeDef } from "../types";

// Literal sources. Their value is a live uniform, so a constant can be tweaked without recompiling.

export const constantFieldNode: MaterialNodeDef = {
  type: "constant-field",
  category: "generator",
  label: "Constant (Field)",
  inputs: [],
  outputs: [{ key: "field", kind: "field" }],
  params: [{ key: "value", label: "value", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 }],
  build(ctx) {
    return { field: ctx.uniforms.value };
  },
};

export const constantColorNode: MaterialNodeDef = {
  type: "constant-color",
  category: "color",
  label: "Constant (Color)",
  inputs: [],
  outputs: [{ key: "color", kind: "color" }],
  params: [{ key: "color", label: "color", type: "color", default: "#808080" }],
  build(ctx) {
    return { color: ctx.uniforms.color };
  },
};

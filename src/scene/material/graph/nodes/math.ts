import { float, mix, max, min } from "three/tsl";
import type { MaterialNodeDef } from "../types";

// Generic scalar combiner: a (op) b. If `b` is unconnected, the `factor` scalar stands in for it (and
// is always the blend amount for `mix`). Used to compose fields — e.g. blend FBM with stripes.
export const mathNode: MaterialNodeDef = {
  type: "math",
  category: "filter",
  label: "Math",
  inputs: [
    { key: "a", kind: "field" },
    { key: "b", kind: "field" },
  ],
  outputs: [{ key: "field", kind: "field" }],
  params: [
    {
      key: "op",
      label: "op",
      type: "select",
      options: ["add", "subtract", "multiply", "mix", "max", "min"],
      default: "mix",
    },
    { key: "factor", label: "factor / b", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  build(ctx) {
    const a = ctx.inputs.a ?? float(0);
    const b = ctx.inputs.b ?? ctx.uniforms.factor;
    switch (ctx.params.op as string) {
      case "add":
        return { field: a.add(b) };
      case "subtract":
        return { field: a.sub(b) };
      case "multiply":
        return { field: a.mul(b) };
      case "max":
        return { field: max(a, b) };
      case "min":
        return { field: min(a, b) };
      case "mix":
      default:
        return { field: mix(a, b, ctx.uniforms.factor) };
    }
  },
};

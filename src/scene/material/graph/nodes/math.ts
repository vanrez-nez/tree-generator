import { float, mix, max, min, pow, sqrt, abs, sin, cos, tan, atan, floor, ceil, round, fract, sign, trunc, select } from "three/tsl";
import type { MaterialNodeDef } from "../types";

// Math (Blender ShaderNodeMath): a (op) b. If `b` is unconnected, the `factor` scalar stands in for it
// (and is always the blend amount for `mix`). Operation is a build-time select. Unary ops ignore b.
// Faithful to Blender's Math operations (safe_* variants approximated: divide/sqrt/log not zero-guarded).
const OPS = [
  "add", "subtract", "multiply", "divide", "mix", "max", "min", "power", "sqrt", "absolute",
  "sine", "cosine", "tangent", "arctan2", "floor", "ceil", "round", "fraction", "modulo",
  "greater-than", "less-than", "sign",
];

export const mathNode: MaterialNodeDef = {
  type: "math",
  nodeClass: "converter",
  label: "Math",
  inputs: [
    { key: "a", kind: "float" },
    { key: "b", kind: "float" },
  ],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "op", label: "op", type: "select", options: OPS, default: "mix" },
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
      case "divide":
        return { field: a.div(b) };
      case "max":
        return { field: max(a, b) };
      case "min":
        return { field: min(a, b) };
      case "power":
        return { field: pow(a, b) };
      case "sqrt":
        return { field: sqrt(a) };
      case "absolute":
        return { field: abs(a) };
      case "sine":
        return { field: sin(a) };
      case "cosine":
        return { field: cos(a) };
      case "tangent":
        return { field: tan(a) };
      case "arctan2":
        return { field: atan(a, b) };
      case "floor":
        return { field: floor(a) };
      case "ceil":
        return { field: ceil(a) };
      case "round":
        return { field: round(a) };
      case "fraction":
        return { field: fract(a) };
      case "modulo":
        // Blender's truncated fmod: a - b * trunc(a / b).
        return { field: a.sub(b.mul(trunc(a.div(b)))) };
      case "greater-than":
        return { field: select(a.greaterThan(b), float(1), float(0)) };
      case "less-than":
        return { field: select(a.lessThan(b), float(1), float(0)) };
      case "sign":
        return { field: sign(a) };
      case "mix":
      default:
        return { field: mix(a, b, ctx.uniforms.factor) };
    }
  },
};

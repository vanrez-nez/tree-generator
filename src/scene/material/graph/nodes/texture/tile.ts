import type { MaterialNodeDef, MaterialValue } from "../../types";
import { tilePattern } from "../../../tsl/tile";

type V = MaterialValue;

// Tile Generator — a generic Substance-style grid generator, not brick-specific. It places a rounded-rect
// tile per grid cell with a per-row offset and per-tile randomisation of position / size / rotation / value.
// Presets of THIS one node:
//   running-bond brick : offset 0.5, offset every 2, columns≈½ rows, small gap
//   stack-bond tile    : offset 0
//   planks             : columns 1 (or rows 1)
//   cobblestone        : roundness high + size/position/rotation randomness
// Outputs `mask` (1 on a tile, 0 in the grout → AO / height / colour mask), and `value` (per-tile random →
// colour / roughness / luminance variation). Composite colour downstream, e.g.
// `Blend(groutColor, Blend(tileA, tileB, value), mask)`. Seamless in the offline bake.
export const tileNode: MaterialNodeDef = {
  type: "tile",
  nodeClass: "texture",
  label: "Tile Generator",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [
    { key: "mask", label: "Mask", kind: "float" },
    { key: "value", label: "Value", kind: "float" },
  ],
  params: [
    { key: "columns", label: "columns", type: "int", min: 1, max: 32, step: 1, default: 6 },
    { key: "rows", label: "rows", type: "int", min: 1, max: 64, step: 1, default: 12 },
    { key: "offset", label: "row offset", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
    { key: "offsetFreq", label: "offset every", type: "int", min: 1, max: 6, step: 1, default: 2 },
    { key: "gap", label: "gap", type: "float", min: 0, max: 0.08, step: 0.001, default: 0.012 },
    { key: "roundness", label: "roundness", type: "float", min: 0, max: 1, step: 0.01, default: 0.05 },
    { key: "edge", label: "edge soft", type: "float", min: 0, max: 0.05, step: 0.001, default: 0.004 },
    { key: "sizeRandom", label: "size rand", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "posRandom", label: "pos rand", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
    { key: "rotRandom", label: "rot rand", type: "float", min: 0, max: 1, step: 0.01, default: 0 },
  ],
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    const columns = Math.max(1, Math.round(Number(ctx.params.columns ?? 6)));
    const offsetFreq = Math.max(1, Math.round(Number(ctx.params.offsetFreq ?? 2)));
    // Snap rows up to a multiple of offsetFreq so the offset cycle closes at the tile's top edge (seamless).
    const rawRows = Math.max(1, Math.round(Number(ctx.params.rows ?? 12)));
    const rows = Math.ceil(rawRows / offsetFreq) * offsetFreq;

    const { mask, value } = tilePattern(
      coord,
      { columns, rows, offsetFreq },
      {
        rowOffset: ctx.uniforms.offset as V,
        gap: ctx.uniforms.gap as V,
        roundness: ctx.uniforms.roundness as V,
        edge: ctx.uniforms.edge as V,
        sizeRandom: ctx.uniforms.sizeRandom as V,
        posRandom: ctx.uniforms.posRandom as V,
        rotRandom: ctx.uniforms.rotRandom as V,
      },
    );
    return { mask, value };
  },
};

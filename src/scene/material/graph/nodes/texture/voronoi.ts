import { uniformArray, int, float, floor } from "three/tsl";
import { Vector3 } from "three";
import type { MaterialNodeDef, MaterialValue, PortDef } from "../../types";
import {
  blenderVoronoiF1,
  blenderVoronoiF1Color,
  blenderVoronoiF1Pos,
  blenderVoronoiF2,
  blenderVoronoiF2Color,
  blenderVoronoiF2Pos,
  blenderVoronoiSmoothF1,
  blenderVoronoiSmoothF1Color,
  blenderVoronoiSmoothF1Pos,
  blenderVoronoiDistanceToEdge,
} from "../../../tsl/blender-voronoi";
import { relaxedCellOffsets } from "../../../tsl/lloyd-points";
import { relaxedVoronoiDistanceToEdge } from "../../../tsl/relaxed-voronoi";

const METRICS = ["euclidean", "manhattan", "chebychev", "minkowski"];
const FEATURES = ["f1", "f2", "smooth-f1", "distance-to-edge"];

// Feature-dependent outputs (declare()): F1/F2/Smooth-F1 expose Distance/Color/Position; Distance-to-Edge
// exposes only Distance.
const FULL_OUTPUTS: PortDef[] = [
  { key: "distance", label: "Distance", kind: "float" },
  { key: "color", label: "Color", kind: "color" },
  { key: "position", label: "Position", kind: "vector" },
];
const EDGE_OUTPUTS: PortDef[] = [{ key: "distance", label: "Distance", kind: "float" }];
const COORD_INPUT: PortDef[] = [{ key: "coord", kind: "vector" }];

// Voronoi Texture (Blender ShaderNodeTexVoronoi) — faithful Blender port (PCG cell hash + neighbour search
// in tsl/blender-voronoi.ts). `scale` multiplies the domain; `randomness`/`exponent`/`smoothness` are live
// uniforms; `metric` and `feature` are build-time selects. `declare()` makes the outputs follow the
// feature (Phase 5). Exponent applies to the Minkowski metric; smoothness to Smooth F1.
export const voronoiNode: MaterialNodeDef = {
  type: "voronoi",
  nodeClass: "texture",
  label: "Voronoi",
  inputs: COORD_INPUT,
  outputs: FULL_OUTPUTS,
  params: [
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1 },
    { key: "randomness", label: "randomness", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "metric", label: "metric", type: "select", options: METRICS, default: "euclidean" },
    { key: "feature", label: "feature", type: "select", options: FEATURES, default: "f1" },
    { key: "exponent", label: "exponent", type: "float", min: 0.1, max: 8, step: 0.1, default: 2 },
    { key: "smoothness", label: "smoothness", type: "float", min: 0, max: 1, step: 0.01, default: 0.25 },
    // Lloyd relaxation iterations for natural (centroidal) cells — offline + distance-to-edge only. 0 keeps
    // the faithful jittered-grid Voronoi; 2–4 give equiaxed, sliver-free, non-square mud-crack cells.
    { key: "relax", label: "relax", type: "int", min: 0, max: 5, step: 1, default: 0 },
  ],
  declare(params) {
    const feature = (params.feature as string) ?? "f1";
    return { inputs: COORD_INPUT, outputs: feature === "distance-to-edge" ? EDGE_OUTPUTS : FULL_OUTPUTS };
  },
  build(ctx) {
    // Offline bakes a 2D uv tile: scale by an INTEGER period and wrap the cell hash to that period so the
    // cells repeat seamlessly across the tile edge. Live is a seamless 3D field (positionWorld) — no tiling
    // needed, so period 0 keeps the faithful Blender path and the live `scale` uniform stays tweakable.
    const period = ctx.backend === "offline" ? Math.max(1, Math.round(Number(ctx.params.scale ?? 1))) : 0;
    const p = (ctx.inputs.coord ?? ctx.coord).mul(period > 0 ? period : ctx.uniforms.scale);
    const m = Math.max(0, METRICS.indexOf(ctx.params.metric as string));
    const r = ctx.uniforms.randomness;
    const e = ctx.uniforms.exponent;
    const s = ctx.uniforms.smoothness;
    const feature = (ctx.params.feature as string) ?? "f1";

    // Lloyd-relaxed cells: offline + distance-to-edge only. Precompute a periodic relaxed seed set on the
    // CPU and hand it to the shader as a uniformArray; the relaxed neighbour search reads those offsets
    // instead of the PCG hash (same cost, GPU-safe). `randomness` becomes the build-time initial jitter
    // (baked into the points) rather than a live uniform.
    const relax = Math.max(0, Math.round(Number(ctx.params.relax ?? 0)));
    if (feature === "distance-to-edge" && period > 0 && relax > 0) {
      const data = relaxedCellOffsets(period, Number(ctx.params.randomness ?? 1), relax);
      const vecs: Vector3[] = [];
      for (let n = 0; n < period * period; n++)
        vecs.push(new Vector3(data[n * 3], data[n * 3 + 1], data[n * 3 + 2]));
      const seeds = uniformArray(vecs);
      const wrap = (v: MaterialValue): MaterialValue =>
        v.sub(int(floor(float(v).div(period))).mul(int(period)));
      const seedFn = (ix: MaterialValue, iy: MaterialValue): MaterialValue =>
        seeds.element(wrap(iy).mul(period).add(wrap(ix))) as MaterialValue;
      return { distance: relaxedVoronoiDistanceToEdge(p, seedFn) };
    }

    switch (feature) {
      case "distance-to-edge":
        return { distance: blenderVoronoiDistanceToEdge(p, r, period) };
      case "f2":
        return {
          distance: blenderVoronoiF2(p, r, m, e, period),
          color: blenderVoronoiF2Color(p, r, m, e, period),
          position: blenderVoronoiF2Pos(p, r, m, e, period),
        };
      case "smooth-f1":
        return {
          distance: blenderVoronoiSmoothF1(p, r, m, e, s, period),
          color: blenderVoronoiSmoothF1Color(p, r, m, e, s, period),
          position: blenderVoronoiSmoothF1Pos(p, r, m, e, s, period),
        };
      default:
        return {
          distance: blenderVoronoiF1(p, r, m, e, period),
          color: blenderVoronoiF1Color(p, r, m, e, period),
          position: blenderVoronoiF1Pos(p, r, m, e, period),
        };
    }
  },
};

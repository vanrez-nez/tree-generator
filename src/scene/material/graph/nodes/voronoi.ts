import type { MaterialNodeDef, PortDef } from "../types";
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
} from "../../tsl/blender-voronoi";

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
  ],
  declare(params) {
    const feature = (params.feature as string) ?? "f1";
    return { inputs: COORD_INPUT, outputs: feature === "distance-to-edge" ? EDGE_OUTPUTS : FULL_OUTPUTS };
  },
  build(ctx) {
    const p = (ctx.inputs.coord ?? ctx.coord).mul(ctx.uniforms.scale);
    const m = Math.max(0, METRICS.indexOf(ctx.params.metric as string));
    const r = ctx.uniforms.randomness;
    const e = ctx.uniforms.exponent;
    const s = ctx.uniforms.smoothness;
    switch ((ctx.params.feature as string) ?? "f1") {
      case "distance-to-edge":
        return { distance: blenderVoronoiDistanceToEdge(p, r) };
      case "f2":
        return {
          distance: blenderVoronoiF2(p, r, m, e),
          color: blenderVoronoiF2Color(p, r, m, e),
          position: blenderVoronoiF2Pos(p, r, m, e),
        };
      case "smooth-f1":
        return {
          distance: blenderVoronoiSmoothF1(p, r, m, e, s),
          color: blenderVoronoiSmoothF1Color(p, r, m, e, s),
          position: blenderVoronoiSmoothF1Pos(p, r, m, e, s),
        };
      default:
        return {
          distance: blenderVoronoiF1(p, r, m, e),
          color: blenderVoronoiF1Color(p, r, m, e),
          position: blenderVoronoiF1Pos(p, r, m, e),
        };
    }
  },
};

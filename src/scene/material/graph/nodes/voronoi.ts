import type { MaterialNodeDef, PortDef } from "../types";
import {
  blenderVoronoiF1,
  blenderVoronoiColor,
  blenderVoronoiPosition,
  blenderVoronoiDistanceToEdge,
} from "../../tsl/blender-voronoi";

const METRICS = ["euclidean", "manhattan", "chebychev"];
const FEATURES = ["f1", "distance-to-edge"];

// Feature-dependent outputs (the declare() use case): F1 exposes Distance/Color/Position; Distance-to-Edge
// exposes only Distance — so the output set changes with the `feature` param.
const F1_OUTPUTS: PortDef[] = [
  { key: "distance", label: "Distance", kind: "float" },
  { key: "color", label: "Color", kind: "color" },
  { key: "position", label: "Position", kind: "vector" },
];
const EDGE_OUTPUTS: PortDef[] = [{ key: "distance", label: "Distance", kind: "float" }];
const COORD_INPUT: PortDef[] = [{ key: "coord", kind: "vector" }];

// Voronoi Texture (Blender ShaderNodeTexVoronoi) — faithful Blender port (PCG cell hash + 3×3×3 search in
// tsl/blender-voronoi.ts). `scale` multiplies the domain; `randomness` is a live uniform; `metric` and
// `feature` are build-time selects. `declare()` makes the outputs follow the feature (Phase 5). F2 /
// Smooth F1 and the Minkowski metric are the remaining Voronoi work.
export const voronoiNode: MaterialNodeDef = {
  type: "voronoi",
  nodeClass: "texture",
  label: "Voronoi",
  inputs: COORD_INPUT,
  outputs: F1_OUTPUTS, // default (feature = f1); declare() overrides per-instance
  params: [
    { key: "scale", label: "scale", type: "float", min: 0.1, max: 8, step: 0.05, default: 1 },
    { key: "randomness", label: "randomness", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    { key: "metric", label: "metric", type: "select", options: METRICS, default: "euclidean" },
    { key: "feature", label: "feature", type: "select", options: FEATURES, default: "f1" },
  ],
  declare(params) {
    const feature = (params.feature as string) ?? "f1";
    return {
      inputs: COORD_INPUT,
      outputs: feature === "distance-to-edge" ? EDGE_OUTPUTS : F1_OUTPUTS,
    };
  },
  build(ctx) {
    const p = (ctx.inputs.coord ?? ctx.coord).mul(ctx.uniforms.scale);
    const metric = Math.max(0, METRICS.indexOf(ctx.params.metric as string));
    const rnd = ctx.uniforms.randomness;
    if (((ctx.params.feature as string) ?? "f1") === "distance-to-edge") {
      return { distance: blenderVoronoiDistanceToEdge(p, rnd) };
    }
    return {
      distance: blenderVoronoiF1(p, rnd, metric),
      color: blenderVoronoiColor(p, rnd, metric),
      position: blenderVoronoiPosition(p, rnd, metric),
    };
  },
};

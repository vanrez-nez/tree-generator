import { vec2, float } from "three/tsl";
import type { MaterialNodeDef, MaterialValue } from "../../types";
import { tileableFbm } from "../../../tsl/tileable-noise";
import { blenderFbm } from "../../../tsl/blender-noise";
import {
  periodicFbm01,
  valueBase01,
  worleyBase01,
  voronoiSmoothBase01,
  paperBase01,
  woolBase01,
  stoneBase01,
  gaborBase01,
  simplexBase01,
  waveletBase01,
  erosionBase01,
  curlVec,
  type NoiseBase01,
} from "../../../tsl/noise";

type V = MaterialValue;

// Noise types selectable on this node. "perlin-fbm" is the DEFAULT and reproduces the original Tileable
// Noise output verbatim (existing presets are unaffected). The rest are seamless (period-wrapped) variants
// of the @lumiey noise library — each tiles in the offline bake. New types are added here over time.
const NOISE_TYPES = [
  "perlin-fbm",
  "value",
  "worley",
  "voronoi-smooth",
  "gabor",
  "stone",
  "paper",
  "wool",
  "simplex",
  "wavelet",
  "erosion",
  "curl",
];

// Bases for the generic periodic fBm (offline). Cellular/flow types use a single (square) period — they
// ignore `aspect`. perlin-fbm and curl are special-cased (perlin = bespoke tileableFbm; curl = vector output).
const OFFLINE_BASES: Record<string, NoiseBase01> = {
  value: valueBase01,
  worley: worleyBase01,
  "voronoi-smooth": voronoiSmoothBase01,
  gabor: gaborBase01,
  stone: stoneBase01,
  paper: paperBase01,
  wool: woolBase01,
  simplex: simplexBase01,
  wavelet: waveletBase01,
  erosion: erosionBase01,
};

// curl emits a vector flow field in addition to the scalar magnitude. declare() exposes the extra port.
const FIELD_ONLY = [{ key: "field", kind: "float" as const }];
const FIELD_AND_VECTOR = [
  { key: "field", kind: "float" as const },
  { key: "vector", kind: "vector" as const },
];

// Tileable Noise — periodic fBm that bakes SEAMLESS in the offline backend (authored for the 2D uv tile,
// unlike Blender's 3D noise). `scale` = base period (integer for exact tiling); `aspect` stretches the X
// period for directional grain (perlin only); `octaves` (detail) is a build-time loop unroll; `gain`
// (roughness) is a live uniform. `noiseType` selects the base noise. In the LIVE backend (3D positionWorld,
// no tiling needed) every type falls back to `blenderFbm` as an approximate preview — the offline bake is
// the exact, type-faithful output. Cellular types (worley / voronoi-smooth) use a single square period.
export const tileableNoiseNode: MaterialNodeDef = {
  type: "tileable-noise",
  nodeClass: "texture",
  label: "Tileable Noise",
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "noiseType", label: "type", type: "select", options: NOISE_TYPES, default: "perlin-fbm" },
    { key: "scale", label: "scale", type: "int", min: 1, max: 24, step: 1, default: 5 },
    { key: "aspect", label: "aspect", type: "float", min: 1, max: 8, step: 0.5, default: 1 },
    { key: "octaves", label: "detail", type: "int", min: 1, max: 8, step: 1, default: 4 },
    { key: "gain", label: "roughness", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
  ],
  // curl adds a `vector` output (the flow field); all other types expose just `field`.
  declare(params) {
    const inputs = [{ key: "coord", kind: "vector" as const }];
    return {
      inputs,
      outputs: (params.noiseType as string) === "curl" ? FIELD_AND_VECTOR : FIELD_ONLY,
    };
  },
  build(ctx) {
    const coord = (ctx.inputs.coord ?? ctx.coord) as V;
    const scale = Math.max(1, Math.round(Number(ctx.params.scale ?? 5)));
    const aspect = Number(ctx.params.aspect ?? 1);
    const octaves = Math.max(1, Number(ctx.params.octaves ?? 4));
    const noiseType = (ctx.params.noiseType as string) ?? "perlin-fbm";
    const gain = ctx.uniforms.gain as V;

    if (ctx.backend === "live") {
      // No tiling in the seamless-3D preview; reuse the Blender fBm over the world coordinate for every type.
      const p = coord.mul(scale) as V;
      return { field: blenderFbm(p, octaves, gain, float(2)) };
    }

    const uv2 = vec2(coord.x, coord.y) as V;

    if (noiseType === "curl") {
      // Vector flow field (single sample at the base period); `field` = its magnitude.
      const c = curlVec(uv2.mul(scale), scale, scale) as V;
      return { field: c.length(), vector: c };
    }

    const base = OFFLINE_BASES[noiseType];
    if (base) {
      // Cellular/flow types ignore aspect (square period); value supports it (anisotropic per-axis period).
      const periodX = noiseType === "value" ? scale * aspect : scale;
      return { field: periodicFbm01(uv2, periodX, scale, octaves, gain, base) };
    }
    // Default "perlin-fbm": original bespoke path — periodic fBm over the uv tile. aspect elongates along Y.
    const n = tileableFbm(uv2, scale * aspect, scale, octaves, gain);
    return { field: n.mul(0.5).add(0.5) }; // [-1,1] → [0,1]
  },
};

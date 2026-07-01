import { vec2, float, floor, max, mod } from "three/tsl";
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
  wavelet: waveletBase01,
  erosion: erosionBase01,
  // NOTE: simplex is NOT here — it needs an EVEN period (see build) so it's special-cased.
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
  // Offline: when `tileSize` is set, the baker renders this noise into a small seamless tile once and repeats
  // it (the noise is periodic over [0,1]) instead of evaluating it across the full grid. See compiler tiling.
  bakeTileable: true,
  inputs: [{ key: "coord", kind: "vector" }],
  outputs: [{ key: "field", kind: "float" }],
  params: [
    { key: "noiseType", label: "type", type: "select", options: NOISE_TYPES, default: "perlin-fbm" },
    // `scale` is a live uniform (float, integer-stepped): the offline bake rounds it to an integer period
    // IN-SHADER (so the lattice still tiles) but reads it as a uniform — a scale edit re-renders the baked
    // channels WITHOUT recompiling (the fast path), and finer grain is reachable at the higher max. It must
    // be `float` (not `int`) because the controller treats every int param as structural (→ full recompile).
    { key: "scale", label: "scale", type: "float", min: 1, max: 128, step: 1, default: 5 },
    // aspect (X-period stretch, perlin/value only) is likewise a live uniform now — no recompile on change.
    { key: "aspect", label: "aspect", type: "float", min: 1, max: 8, step: 0.5, default: 1 },
    { key: "octaves", label: "detail", type: "int", min: 1, max: 8, step: 1, default: 4 },
    { key: "gain", label: "roughness", type: "float", min: 0, max: 1, step: 0.01, default: 0.5 },
    // Band-limit (anti-alias) strength, live uniform. 1 = fade octaves finer than the bake texel grid so the
    // noise stays crisp instead of aliasing into speckle/mush (offline only); 0 = the raw, unfiltered sum.
    { key: "antialias", label: "anti-alias", type: "float", min: 0, max: 1, step: 0.01, default: 1 },
    // Tiling (offline only): "off" = evaluate the noise across the full grid (default, unchanged). A px value
    // renders a REPEATING BLOCK — the noise fills a tileSize² seamless tile at full pixel density and repeats
    // it (repeat = outputResolution/tileSize) to cover the texture. Feature size and crispness are UNCHANGED
    // (same as "off"); the only difference is the pattern repeats, and only tileSize² unique texels are
    // computed (cheaper). Smaller tile = more visible repetition. Structural (select) → editing re-bakes.
    // `curl` (vector) output is never tiled.
    { key: "tileSize", label: "tile", type: "select", options: ["off", "64", "128", "256", "512"], default: "off" },
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
    // Guard against a non-finite octaves field (empty editor input → NaN): octaves is a build-time loop
    // count, so a bad value here would just unroll wrong — clamp it. (scale/aspect are uniforms now; the
    // compiler already NaN-guards uniform seeds, so no build-time coercion is needed for them.)
    const octaves = Math.max(1, Math.round(Number.isFinite(Number(ctx.params.octaves)) ? Number(ctx.params.octaves) : 4));
    const noiseType = (ctx.params.noiseType as string) ?? "perlin-fbm";
    const gain = ctx.uniforms.gain as V;
    const scaleU = ctx.uniforms.scale as V; // live uniform (float)

    if (ctx.backend === "live") {
      // No tiling in the seamless-3D preview; reuse the Blender fBm over the world coordinate for every type.
      // scale stays a continuous live uniform here (no integer period needed off the tile).
      const p = coord.mul(scaleU) as V;
      return { field: blenderFbm(p, octaves, gain, float(2)) };
    }

    const uv2 = vec2(coord.x, coord.y) as V;
    const aaU = ctx.uniforms.antialias as V; // live band-limit strength (0..1)
    // Repeating-unit tiling (offline): the compiler renders `period / tileRepeat` periods into a small buffer
    // and repeats it ×tileRepeat, so dividing the period here keeps the final feature size = `scale` (constant)
    // while the block repeats. 1 = no tiling (full render). See compiler maybeTileNode / tileRepeatFor.
    const tileRepeat = Math.max(1, Math.round(ctx.tileRepeat ?? 1));
    const scaleTiled = tileRepeat > 1 ? (scaleU.div(float(tileRepeat)) as V) : scaleU;
    // Offline tiling needs an INTEGER cell count; round the (tile-divided) scale uniform to a whole period
    // IN-SHADER (so a scale drag re-renders without recompiling, yet the lattice at index `period` matches 0).
    const periodU = max(floor(scaleTiled.add(0.5)), float(1)) as V;
    // aspect stretches the X period (perlin/value); keep it integer so X tiles too.
    const aspectU = ctx.uniforms.aspect as V;
    const periodXU = max(floor(periodU.mul(aspectU).add(0.5)), float(1)) as V;

    if (noiseType === "curl") {
      // Vector flow field (single sample at the base period); `field` = its magnitude.
      const c = curlVec(uv2.mul(periodU), periodU, periodU) as V;
      return { field: c.length(), vector: c };
    }

    if (noiseType === "simplex") {
      // psrdnoise's sheared simplex lattice only tiles in Y when the period is EVEN — an odd period shifts
      // the skewed x-index by a half cell across the y-wrap, leaving a vertical seam. Snap the period up to
      // even (every octave period stays even since it's ×2^o): even = period + (period mod 2).
      const evenU = periodU.add(mod(periodU, float(2))) as V;
      return { field: periodicFbm01(uv2, evenU, evenU, octaves, gain, simplexBase01, aaU) };
    }

    const base = OFFLINE_BASES[noiseType];
    if (base) {
      // Cellular/flow types ignore aspect (square period); value supports it (anisotropic per-axis period).
      const periodX = noiseType === "value" ? periodXU : periodU;
      return { field: periodicFbm01(uv2, periodX, periodU, octaves, gain, base, aaU) };
    }
    // Default "perlin-fbm": original bespoke path — periodic fBm over the uv tile. aspect elongates along Y.
    const n = tileableFbm(uv2, periodXU, periodU, octaves, gain, aaU);
    return { field: n.mul(0.5).add(0.5) }; // [-1,1] → [0,1]
  },
};

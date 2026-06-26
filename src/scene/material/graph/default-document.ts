import type { MaterialGraphDocument } from "./types";

// The default bark material, expressed entirely with GENERIC nodes (no wood-specific nodes):
//   domain-warp ─▶ fbm (broad grain) ─┐
//               └▶ anisotropic-stripes ┴▶ math(mix) = height ─▶ color-ramp  → Base Color ┐
//                                                            ├▶ normal-from-height → Normal ┤
//                                                            └▶ levels (invert)    → Roughness ┘
//                                                                          → Principled BSDF → Material Output
// This is the "bark is just a preset" demonstration: swapping stops/counts retargets it to other
// materials. Node positions seed the editor layout.
export function createDefaultDocument(): MaterialGraphDocument {
  return {
    version: 2,
    nodes: [
      {
        id: "warp",
        type: "domain-warp",
        params: { amount: 0.22, scale: 1 },
        position: { x: 40, y: 220 },
        enabled: true,
      },
      {
        id: "fbm",
        type: "fbm",
        params: { scale: 1.2, octaves: 4, lacunarity: 2, gain: 0.5 },
        position: { x: 300, y: 120 },
        enabled: true,
      },
      {
        id: "stripes",
        type: "anisotropic-stripes",
        params: { count: 22, sharpness: 2.2, waviness: 0.18, contrast: 1 },
        position: { x: 300, y: 320 },
        enabled: true,
      },
      {
        id: "height",
        type: "math",
        params: { op: "mix", factor: 0.5 },
        position: { x: 560, y: 220 },
        enabled: true,
      },
      {
        id: "ramp",
        type: "color-ramp",
        params: { colorA: "#3f2d1e", colorB: "#8a6a4a", low: 0.3, high: 0.78 },
        position: { x: 820, y: 80 },
        enabled: true,
      },
      {
        id: "normal",
        type: "normal-from-height",
        params: { strength: 1.1 },
        position: { x: 820, y: 260 },
        enabled: true,
      },
      {
        id: "rough",
        type: "levels",
        params: { min: 0.55, max: 0.95, invert: true },
        position: { x: 820, y: 420 },
        enabled: true,
      },
      {
        id: "principled",
        type: "principled-bsdf",
        params: {},
        position: { x: 1100, y: 240 },
        enabled: true,
      },
      {
        id: "out",
        type: "material-output",
        params: {},
        position: { x: 1400, y: 260 },
        enabled: true,
      },
    ],
    edges: [
      { fromNode: "warp", fromOutput: "coord", toNode: "fbm", toInput: "coord" },
      { fromNode: "warp", fromOutput: "coord", toNode: "stripes", toInput: "coord" },
      { fromNode: "fbm", fromOutput: "field", toNode: "height", toInput: "a" },
      { fromNode: "stripes", fromOutput: "field", toNode: "height", toInput: "b" },
      { fromNode: "height", fromOutput: "field", toNode: "ramp", toInput: "field" },
      { fromNode: "height", fromOutput: "field", toNode: "normal", toInput: "height" },
      { fromNode: "height", fromOutput: "field", toNode: "rough", toInput: "field" },
      { fromNode: "ramp", fromOutput: "color", toNode: "principled", toInput: "baseColor" },
      { fromNode: "normal", fromOutput: "normal", toNode: "principled", toInput: "normal" },
      { fromNode: "rough", fromOutput: "field", toNode: "principled", toInput: "roughness" },
      { fromNode: "principled", fromOutput: "bsdf", toNode: "out", toInput: "surface" },
    ],
  };
}

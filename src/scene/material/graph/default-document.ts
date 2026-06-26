import type { MaterialGraphDocument } from "./types";

// The default bark material, expressed with GENERIC, TILEABLE nodes (authored for the 2D offline bake so
// the texture tiles seamlessly under triplanar):
//   tileable-warp ─▶ tileable-noise (broad grain) ─┐
//                 └▶ tileable-noise (aspect = fibers) ┴▶ math(mix) = height ─▶ color-ramp → Base Color ┐
//                                                                          ├▶ normal-from-height → Normal ┤
//                                                                          └▶ levels (invert)    → Roughness ┘
//                                                                          → Principled BSDF → Material Output
// "bark is just a preset": swapping scale/aspect/stops retargets it. Node positions seed the editor layout.
export function createDefaultDocument(): MaterialGraphDocument {
  return {
    version: 2,
    nodes: [
      {
        id: "warp",
        type: "tileable-warp",
        params: { amount: 0.15, scale: 4 },
        position: { x: 40, y: 220 },
        enabled: true,
      },
      {
        id: "grain",
        type: "tileable-noise",
        params: { scale: 5, aspect: 1, octaves: 4, gain: 0.5 },
        position: { x: 300, y: 120 },
        enabled: true,
      },
      {
        id: "fiber",
        type: "tileable-noise",
        params: { scale: 5, aspect: 4, octaves: 3, gain: 0.5 },
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
      { fromNode: "warp", fromOutput: "coord", toNode: "grain", toInput: "coord" },
      { fromNode: "warp", fromOutput: "coord", toNode: "fiber", toInput: "coord" },
      { fromNode: "grain", fromOutput: "field", toNode: "height", toInput: "a" },
      { fromNode: "fiber", fromOutput: "field", toNode: "height", toInput: "b" },
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

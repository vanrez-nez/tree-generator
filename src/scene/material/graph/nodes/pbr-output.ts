import type { MaterialNodeDef } from "../types";

// Terminal node representing the MeshStandardNodeMaterial contract. Singleton, non-deletable in v1,
// no outputs. Unconnected inputs leave the corresponding material socket unset (material defaults).
// `baseColor` is the internal key; the UI labels it "Albedo / Diffuse". The compiler reads this
// node's connected inputs directly, so build() returns nothing.
export const pbrOutputNode: MaterialNodeDef = {
  type: "pbr-output",
  category: "output",
  label: "PBR Material Output",
  inputs: [
    { key: "baseColor", label: "Albedo / Diffuse", kind: "color" },
    { key: "normal", label: "Normal", kind: "normal" },
    { key: "emission", label: "Emission", kind: "color" },
    { key: "roughness", label: "Roughness", kind: "field" },
    { key: "metallic", label: "Metallic", kind: "field" },
    { key: "ambientOcclusion", label: "Ambient Occlusion", kind: "field" },
  ],
  outputs: [],
  params: [],
  build() {
    return {};
  },
};

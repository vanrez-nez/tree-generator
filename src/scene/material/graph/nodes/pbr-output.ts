import type { MaterialNodeDef } from "../types";

// Terminal node representing the MeshStandardNodeMaterial contract. Singleton, non-deletable in v1,
// no outputs. Unconnected inputs leave the corresponding material socket unset (material defaults).
// `baseColor` is the internal key; the UI labels it "Albedo / Diffuse". The compiler reads this
// node's connected inputs directly, so build() returns nothing.
export const pbrOutputNode: MaterialNodeDef = {
  type: "pbr-output",
  nodeClass: "output",
  label: "PBR Material Output",
  inputs: [
    { key: "baseColor", label: "Albedo / Diffuse", kind: "color" },
    { key: "normal", label: "Normal", kind: "vector" },
    { key: "emission", label: "Emission", kind: "color" },
    { key: "roughness", label: "Roughness", kind: "float" },
    { key: "metallic", label: "Metallic", kind: "float" },
    { key: "ambientOcclusion", label: "Ambient Occlusion", kind: "float" },
  ],
  outputs: [],
  params: [],
  build() {
    return {};
  },
};

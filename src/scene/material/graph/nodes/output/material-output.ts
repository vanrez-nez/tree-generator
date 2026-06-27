import type { MaterialNodeDef } from "../../types";

// Terminal node (Blender's Material Output). Singleton, non-deletable, no outputs. Its single Surface
// input takes the constrained green Shader marker from a Principled BSDF / Emission node; the compiler
// reads the bundle carried on that input and unpacks it onto the MeshPhysicalNodeMaterial. build()
// returns nothing. (Volume / Displacement outputs are out of scope — plan L1/L2.)
export const materialOutputNode: MaterialNodeDef = {
  type: "material-output",
  nodeClass: "output",
  label: "Material Output",
  inputs: [{ key: "surface", label: "Surface", kind: "shader" }],
  outputs: [],
  params: [],
  build() {
    return {};
  },
};

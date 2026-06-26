// Generic composable material graph — core types (material-graph-plan.md).
//
// A MaterialGraphDocument is a serializable, id-based DAG of typed nodes. Each node type is described
// by a MaterialNodeDef in the registry, whose build() emits TSL node-values per output. The compiler
// (compiler.ts) topo-sorts the document and feeds the terminal `pbr-output` node's connected inputs
// into a MeshStandardNodeMaterial (live node sockets) or convertToTexture-baked maps.

// TSL node-values are dynamically typed: DefinitelyTyped's TSL coverage is partial and the
// ShaderNodeObject<T> variance is awkward to thread through generic graph boundaries. A documented
// alias keeps the boundary honest without fighting the type system at every edge; build() internals
// stay precise because the TSL functions they call are themselves typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MaterialValue = any;

// Port kinds map onto TSL value types, mirroring Blender's shader-relevant socket types + colours:
//   float  -> TSL float    (grey:   scalars — height, masks, roughness, AO, metallic)
//   vector -> TSL vec2/3   (blue:   coordinate domains, warp offsets, flow fields, normals)
//   color  -> TSL vec3     (yellow: sRGB-authored colour — basecolor, emission)
// `field` was renamed to `float`; `normal` was folded into `vector` — Blender has no separate normal
// socket type, a normal is just a Vector with semantics (blender-node-alignment-plan.md L3).
export type PortKind = "float" | "vector" | "color";

export interface PortDef {
  key: string;
  label?: string;
  kind: PortKind;
}

// Blender node classes (nclass). Drives Add-menu grouping and node-header colour (consumed in Phase 1).
// Grounded subset from blender-node-alignment-plan.md §4.
export type NodeClass =
  | "input"
  | "output"
  | "shader"
  | "texture"
  | "color"
  | "vector"
  | "converter";

export type ParamType = "float" | "int" | "bool" | "color" | "select";

export interface ParamDef {
  key: string;
  label: string;
  type: ParamType;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default: unknown;
}

export type MaterialBackend = "live" | "baked";

export interface BuildCtx {
  // Resolved upstream TSL node-values keyed by this node's input port key (undefined if unconnected).
  inputs: Record<string, MaterialValue | undefined>;
  // Live-tweakable params as TSL uniform nodes (float / int / color). Updating `.value` re-renders
  // without recompiling.
  uniforms: Record<string, MaterialValue>;
  // Raw param values, for build-time branching (bool/select) and loop counts (octaves) that cannot be
  // dynamic uniforms.
  params: Record<string, unknown>;
  // The coordinate domain: positionWorld (live, 3D seamless) or vec3(uv, 0) (baked, 2D tileable).
  coord: MaterialValue;
  backend: MaterialBackend;
}

export interface MaterialNodeDef {
  type: string;
  nodeClass: NodeClass;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  // Emit one TSL node-value per output port key. The terminal `pbr-output` returns {} — the compiler
  // reads its connected inputs directly.
  build(ctx: BuildCtx): Record<string, MaterialValue>;
}

export interface GraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  position: { x: number; y: number };
  enabled: boolean;
}

export interface GraphEdge {
  fromNode: string;
  fromOutput: string;
  toNode: string;
  toInput: string;
}

export interface MaterialGraphDocument {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const PBR_OUTPUT_TYPE = "pbr-output";

// The six PBR output sockets, in UI order. Internal keys; `baseColor` shows as "Albedo / Diffuse".
export const PBR_SOCKETS = [
  "baseColor",
  "normal",
  "emission",
  "roughness",
  "metallic",
  "ambientOcclusion",
] as const;
export type PbrSocket = (typeof PBR_SOCKETS)[number];

// --- Permissive type coercion (Blender-like) -------------------------------------------------------
// Maps an (output kind → input kind) pair to the conversion injected at build time. Same-kind pairs are
// "identity"; listed cross-kind pairs are allowed and coerced; unlisted pairs are rejected on connect.
// Consumed in Phase 2 (controller.connect veto, compiler.validate, build-time injection) — data only
// for now. `shader`, when added, is intentionally absent here → never coercible. See plan L6.
export type Coercion =
  | "identity"
  | "float-to-vector" // broadcast x → (x, x, x)
  | "float-to-color" //  broadcast x → (x, x, x)
  | "vector-to-float" // average of components
  | "vector-to-color" // reinterpret xyz → rgb
  | "color-to-float" //  luminance (rgb → bw)
  | "color-to-vector"; // reinterpret rgb → xyz

export const COERCION_MATRIX: Record<PortKind, Partial<Record<PortKind, Coercion>>> = {
  float: { float: "identity", vector: "float-to-vector", color: "float-to-color" },
  vector: { vector: "identity", float: "vector-to-float", color: "vector-to-color" },
  color: { color: "identity", float: "color-to-float", vector: "color-to-vector" },
};

// How (or whether) an output kind may feed an input kind. undefined → reject the connection.
export function coercionFor(from: PortKind, to: PortKind): Coercion | undefined {
  return COERCION_MATRIX[from]?.[to];
}

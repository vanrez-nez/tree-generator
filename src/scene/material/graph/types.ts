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

// Port kinds map onto TSL value types:
//   field  -> float  (linear scalar: height, masks, roughness, AO, metallic)
//   color  -> vec3   (sRGB-authored colour: basecolor, emission)
//   normal -> vec3   (encoded tangent/world normal)
//   vector -> vec2/vec3 (coordinate domains, warp offsets, flow fields)
export type PortKind = "field" | "color" | "normal" | "vector";

export interface PortDef {
  key: string;
  label?: string;
  kind: PortKind;
}

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
  category: "generator" | "filter" | "adapter" | "color" | "output";
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

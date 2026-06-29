import * as THREE from "three";
import { MeshStandardNodeMaterial, MeshPhysicalNodeMaterial } from "three/webgpu";
import { positionWorld, uv, vec3, float, uniform, uniformArray, luminance, attribute } from "three/tsl";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  MATERIAL_OUTPUT_TYPE,
  coercionFor,
  curveToArray,
  type CurveValue,
  type BuildCtx,
  type Coercion,
  type GraphNode,
  type MaterialBackend,
  type MaterialBundle,
  type MaterialGraphDocument,
  type MaterialNodeDef,
  type MaterialValue,
  type PortDef,
  type PortKind,
} from "./types";
import { nodePorts, type NodeRegistry } from "./registry";

export interface CompiledMaterial {
  material: MeshStandardNodeMaterial;
  // Per-node param uniforms (nodeId -> { paramKey -> uniform node }), so the editor can live-tweak.
  uniforms: Map<string, Record<string, MaterialValue>>;
}

export interface CompileOptions {
  backend: MaterialBackend;
}

export interface CompiledSockets {
  // The Principled BSDF / Emission bundle feeding Material Output, unpacked by the consumer.
  bundle: MaterialBundle;
  uniforms: Map<string, Record<string, MaterialValue>>;
}

// Validate + topo-sort + build every node's TSL outputs, returning the MaterialBundle the shader node
// feeds into Material Output (and per-node uniforms). Shared by compileGraph (live material), the offline
// baker, and the channel baker (PNG export / 2D preview).
export function compileSockets(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  opts: CompileOptions,
): CompiledSockets {
  // Domain: 3D world position (live, seamless) or a 2D uv slice (offline bake). Shared by every (sub)document.
  const coord: MaterialValue =
    opts.backend === "live" ? positionWorld : vec3(uv().x, uv().y, float(0));
  const { outputs, uniforms } = compileDocument(doc, registry, opts, coord);
  return { bundle: resolveBundle(doc, registry, outputs), uniforms };
}

interface CompiledDocument {
  outputs: Map<string, Record<string, MaterialValue>>;
  uniforms: Map<string, Record<string, MaterialValue>>;
}

// Compile one document's nodes to per-node TSL outputs (topo order). `seededInputs` is present only for
// a group's subgraph: it supplies the Group Input node's outputs (the external values fed into the
// group). Group nodes recurse via compileGroup.
function compileDocument(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  opts: CompileOptions,
  coord: MaterialValue,
  seededInputs?: Record<string, MaterialValue | undefined>,
): CompiledDocument {
  validate(doc, registry, seededInputs !== undefined);
  const order = topoSort(doc);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const outputsByNode = new Map<string, Record<string, MaterialValue>>();
  const uniformsByNode = new Map<string, Record<string, MaterialValue>>();

  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    const ports = nodePorts(node, registry);

    if (node.type === GROUP_INPUT_TYPE) {
      // This node's outputs are the external inputs fed into the subgraph (seeded by the parent group).
      const out: Record<string, MaterialValue> = {};
      for (const p of ports.outputs) out[p.key] = seededInputs?.[p.key];
      outputsByNode.set(id, out);
      continue;
    }
    if (node.type === GROUP_TYPE) {
      const ext = resolveInputs(node, doc, outputsByNode, byId, registry);
      outputsByNode.set(id, compileGroup(node, registry, opts, coord, ext));
      continue;
    }

    const inputs = resolveInputs(node, doc, outputsByNode, byId, registry);
    // Disabled chain nodes pass their first input through (preserves the on/off bypass semantics).
    if (!node.enabled && ports.inputs.length > 0) {
      outputsByNode.set(id, bypassOutputs(ports, inputs));
      continue;
    }
    const def = registry.get(node.type);
    const uniforms = buildUniforms(def, node);
    uniformsByNode.set(id, uniforms);
    const ctx: BuildCtx = { inputs, uniforms, params: node.params, coord, backend: opts.backend };
    outputsByNode.set(id, def.build(ctx));
  }

  return { outputs: outputsByNode, uniforms: uniformsByNode };
}

// Compile a group node: run its subgraph with the group's external inputs seeded into the Group Input
// node, then read the Group Output node's inputs back as the group's outputs. Recursion handles nesting.
function compileGroup(
  groupNode: GraphNode,
  registry: NodeRegistry,
  opts: CompileOptions,
  coord: MaterialValue,
  externalInputs: Record<string, MaterialValue | undefined>,
): Record<string, MaterialValue> {
  const sub = groupNode.subgraph;
  if (!sub) return {};
  const { outputs } = compileDocument(sub, registry, opts, coord, externalInputs);
  const goNode = sub.nodes.find((n) => n.type === GROUP_OUTPUT_TYPE);
  const result: Record<string, MaterialValue> = {};
  if (!goNode) return result;
  const subById = new Map(sub.nodes.map((n) => [n.id, n]));
  for (const p of nodePorts(goNode, registry).inputs) {
    const edge = sub.edges.find((e) => e.toNode === goNode.id && e.toInput === p.key);
    result[p.key] = edge ? resolveEdgeValue(edge, p.kind, outputs, subById, registry) : undefined;
  }
  return result;
}

// A bare MeshPhysicalNodeMaterial with the surface-contract defaults (DoubleSide, polygon offset). Shared
// by the live material here and the offline surface material.
export function newSurfaceMaterial(): MeshPhysicalNodeMaterial {
  return new MeshPhysicalNodeMaterial({
    metalness: 0,
    roughness: 0.9,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

// Unpack a resolved bundle onto a MeshPhysicalNodeMaterial's channels. `wrap` optionally transforms each
// non-normal channel (identity for live). Normal is assigned as-is. Used by the live compile (wrap =
// identity) and reused by the offline surface builder (wrap = triplanar sample).
export function applyBundle(
  material: MeshPhysicalNodeMaterial,
  bundle: MaterialBundle,
): void {
  // AO modulates only the indirect/IBL term. Compose the mesh's per-vertex FORM AO (to-buffer-geometry's
  // `vertexAo`, geometry-driven) with the graph's texture-scale DETAIL AO when the Principled AO input is
  // connected — same as the offline backend's bakedAO × vertexAo.
  const vertexAo = attribute("vertexAo", "float");
  material.aoNode = bundle.ambientOcclusion ? bundle.ambientOcclusion.mul(vertexAo) : vertexAo;
  if (bundle.baseColor) material.colorNode = bundle.baseColor;
  if (bundle.emission) material.emissiveNode = bundle.emission;
  if (bundle.roughness) material.roughnessNode = bundle.roughness;
  if (bundle.metallic) material.metalnessNode = bundle.metallic;
  if (bundle.normal) material.normalNode = bundle.normal;
  // Physical channels — only present when the Principled lobe is active, so unused lobes stay disabled.
  if (bundle.ior) material.iorNode = bundle.ior;
  if (bundle.alpha) {
    material.opacityNode = bundle.alpha;
    material.transparent = true;
  }
  if (bundle.coat) material.clearcoatNode = bundle.coat;
  if (bundle.coatRoughness) material.clearcoatRoughnessNode = bundle.coatRoughness;
  if (bundle.sheen) material.sheenNode = bundle.sheen; // float weight; three wraps as vec3 (grey sheen)
  if (bundle.sheenRoughness) material.sheenRoughnessNode = bundle.sheenRoughness;
  if (bundle.transmission) material.transmissionNode = bundle.transmission;
}

// Compile a document into the LIVE surface material: a procedural MeshPhysicalNodeMaterial whose channels
// are evaluated per fragment over positionWorld (seamless 3D). The offline backend uses OfflineMaterial
// instead (bakes channels to textures). Physical is a subclass of Standard, satisfying the mesher's
// surface-material contract (plan L1/L2).
export function compileGraph(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  opts: CompileOptions,
): CompiledMaterial {
  const { bundle, uniforms: uniformsByNode } = compileSockets(doc, registry, opts);
  const material = newSurfaceMaterial();
  applyBundle(material, bundle);
  return { material, uniforms: uniformsByNode };
}

function resolveInputs(
  node: GraphNode,
  doc: MaterialGraphDocument,
  outputs: Map<string, Record<string, MaterialValue>>,
  byId: Map<string, GraphNode>,
  registry: NodeRegistry,
): Record<string, MaterialValue | undefined> {
  const ins: Record<string, MaterialValue | undefined> = {};
  for (const port of nodePorts(node, registry).inputs) {
    const edge = doc.edges.find((e) => e.toNode === node.id && e.toInput === port.key);
    ins[port.key] = edge ? resolveEdgeValue(edge, port.kind, outputs, byId, registry) : undefined;
  }
  return ins;
}

// Fetch an edge's upstream TSL value, coerced to the target input kind. Permissive linking: when the
// upstream output kind differs, inject the matching coercion (validate() guarantees one exists). Shared
// by every typed input — intermediate nodes AND the terminal pbr-output channels. See plan L6.
function resolveEdgeValue(
  edge: { fromNode: string; fromOutput: string },
  targetKind: PortKind,
  outputs: Map<string, Record<string, MaterialValue>>,
  byId: Map<string, GraphNode>,
  registry: NodeRegistry,
): MaterialValue | undefined {
  let value = outputs.get(edge.fromNode)?.[edge.fromOutput];
  if (value === undefined) return undefined;
  const fromNode = byId.get(edge.fromNode);
  const outKind = fromNode
    ? nodePorts(fromNode, registry).outputs.find((p) => p.key === edge.fromOutput)?.kind
    : undefined;
  if (outKind && outKind !== targetKind) {
    const conv = coercionFor(outKind, targetKind);
    if (conv) value = coerce(value, conv);
  }
  return value;
}

// Apply a port-kind coercion to a TSL value. Mirrors Blender's implicit socket conversions (L6).
function coerce(value: MaterialValue, conversion: Coercion): MaterialValue {
  switch (conversion) {
    case "float-to-vector":
    case "float-to-color":
      return vec3(value); // broadcast x -> (x, x, x)
    case "vector-to-float":
      return value.x.add(value.y).add(value.z).div(3); // average of components
    case "color-to-float":
      return luminance(value); // rgb -> bw
    case "identity":
    case "vector-to-color": // both are vec3 — reinterpret channels
    case "color-to-vector":
      return value;
  }
}

function bypassOutputs(
  ports: { inputs: PortDef[]; outputs: PortDef[] },
  inputs: Record<string, MaterialValue | undefined>,
): Record<string, MaterialValue> {
  const firstIn = ports.inputs[0];
  const firstOut = ports.outputs[0];
  if (firstIn && firstOut && inputs[firstIn.key] !== undefined) {
    return { [firstOut.key]: inputs[firstIn.key] };
  }
  return {};
}

function buildUniforms(def: MaterialNodeDef, node: GraphNode): Record<string, MaterialValue> {
  const out: Record<string, MaterialValue> = {};
  for (const p of def.params) {
    const raw = node.params[p.key] ?? p.default;
    if (p.type === "color") {
      out[p.key] = uniform(new THREE.Color(raw as THREE.ColorRepresentation));
    } else if (p.type === "vec3") {
      const v = (raw ?? { x: 0, y: 0, z: 0 }) as { x: number; y: number; z: number };
      out[p.key] = uniform(new THREE.Vector3(v.x, v.y, v.z));
    } else if (p.type === "float" || p.type === "int") {
      // Coerce non-finite values (e.g. a cleared numeric field → NaN) to the param default, then 0 — a NaN
      // uniform serialises to invalid WGSL (`NaN.0`) and invalidates the whole shader.
      const n = Number(raw);
      out[p.key] = uniform(Number.isFinite(n) ? n : Number(p.default) || 0);
    } else if (p.type === "curve") {
      // 20 floats ([C,R,G,B] × 5 points); build() indexes via .element(). uniformArray.update() copies
      // its `.array` to the GPU each frame, so the controller can mutate it live (no recompile).
      out[p.key] = uniformArray(curveToArray(raw as CurveValue | undefined), "float");
    }
    // bool / select: build() reads the raw value via ctx.params.
  }
  return out;
}

// The bundle feeding Material Output's Surface input. The shader node (Principled/Emission) emitted a
// MaterialBundle as its `shader`-kind output; resolveEdgeValue passes it through (shader→shader is
// identity, never coerced). Returns {} when nothing is wired to Surface.
function resolveBundle(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  outputs: Map<string, Record<string, MaterialValue>>,
): MaterialBundle {
  const outNode = doc.nodes.find((n) => n.type === MATERIAL_OUTPUT_TYPE);
  if (!outNode) return {};
  const edge = doc.edges.find((e) => e.toNode === outNode.id && e.toInput === "surface");
  if (!edge) return {};
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const value = resolveEdgeValue(edge, "shader", outputs, byId, registry);
  return (value as MaterialBundle | undefined) ?? {};
}

function topoSort(doc: MaterialGraphDocument): string[] {
  const indeg = new Map<string, number>();
  for (const n of doc.nodes) indeg.set(n.id, 0);
  const adj = new Map<string, string[]>();
  for (const e of doc.edges) {
    if (!indeg.has(e.fromNode) || !indeg.has(e.toNode)) continue;
    adj.set(e.fromNode, [...(adj.get(e.fromNode) ?? []), e.toNode]);
    indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
  }
  const queue = doc.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (order.length !== doc.nodes.length) throw new Error("Material graph has a cycle");
  return order;
}

function validate(doc: MaterialGraphDocument, registry: NodeRegistry, isSubgraph = false): void {
  // The top-level document ends in Material Output; a group's subgraph ends in Group Output.
  const terminalType = isSubgraph ? GROUP_OUTPUT_TYPE : MATERIAL_OUTPUT_TYPE;
  const terms = doc.nodes.filter((n) => n.type === terminalType);
  if (terms.length !== 1) {
    throw new Error(`Expected exactly one ${terminalType} node, found ${terms.length}`);
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seenInput = new Set<string>();
  for (const e of doc.edges) {
    const from = byId.get(e.fromNode);
    const to = byId.get(e.toNode);
    if (!from) throw new Error(`Edge from unknown node '${e.fromNode}'`);
    if (!to) throw new Error(`Edge to unknown node '${e.toNode}'`);
    const outPort = nodePorts(from, registry).outputs.find((p) => p.key === e.fromOutput);
    const inPort = nodePorts(to, registry).inputs.find((p) => p.key === e.toInput);
    if (!outPort) throw new Error(`Node '${from.type}' has no output '${e.fromOutput}'`);
    if (!inPort) throw new Error(`Node '${to.type}' has no input '${e.toInput}'`);
    if (outPort.kind !== inPort.kind && !coercionFor(outPort.kind, inPort.kind)) {
      throw new Error(
        `Type mismatch (no coercion): ${from.type}.${e.fromOutput} (${outPort.kind}) -> ${to.type}.${e.toInput} (${inPort.kind})`,
      );
    }
    const inputKey = `${e.toNode}/${e.toInput}`;
    if (seenInput.has(inputKey)) throw new Error(`Multiple connections into ${to.type}.${e.toInput}`);
    seenInput.add(inputKey);
  }
}

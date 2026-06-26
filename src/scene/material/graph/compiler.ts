import * as THREE from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { positionWorld, uv, vec3, float, uniform, convertToTexture } from "three/tsl";
import {
  PBR_OUTPUT_TYPE,
  type BuildCtx,
  type GraphNode,
  type MaterialBackend,
  type MaterialGraphDocument,
  type MaterialNodeDef,
  type MaterialValue,
  type PbrSocket,
} from "./types";
import type { NodeRegistry } from "./registry";

// Resolution of baked channel textures (convertToTexture render target).
const BAKE_SIZE = 1024;

export interface CompiledMaterial {
  material: MeshStandardNodeMaterial;
  // Per-node param uniforms (nodeId -> { paramKey -> uniform node }), so the editor can live-tweak.
  uniforms: Map<string, Record<string, MaterialValue>>;
}

export interface CompileOptions {
  backend: MaterialBackend;
}

export interface CompiledSockets {
  sockets: Partial<Record<PbrSocket, MaterialValue>>;
  uniforms: Map<string, Record<string, MaterialValue>>;
}

// Validate + topo-sort + build every node's TSL outputs, returning the terminal pbr-output node's
// connected channel nodes (and per-node uniforms). Shared by compileGraph (material) and the channel
// baker (PNG export / 2D preview).
export function compileSockets(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  opts: CompileOptions,
): CompiledSockets {
  validate(doc, registry);
  const order = topoSort(doc);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));

  // Domain: 3D world position (live, seamless) or a 2D uv slice (baked, tileable into a texture).
  const coord: MaterialValue =
    opts.backend === "live" ? positionWorld : vec3(uv().x, uv().y, float(0));

  const outputsByNode = new Map<string, Record<string, MaterialValue>>();
  const uniformsByNode = new Map<string, Record<string, MaterialValue>>();

  for (const id of order) {
    const node = byId.get(id);
    if (!node) continue;
    const def = registry.get(node.type);
    const inputs = resolveInputs(node, def, doc, outputsByNode);

    // Disabled chain nodes pass their first input through (preserves the on/off bypass semantics).
    if (!node.enabled && def.inputs.length > 0) {
      outputsByNode.set(id, bypassOutputs(def, inputs));
      continue;
    }

    const uniforms = buildUniforms(def, node);
    uniformsByNode.set(id, uniforms);
    const ctx: BuildCtx = { inputs, uniforms, params: node.params, coord, backend: opts.backend };
    outputsByNode.set(id, def.build(ctx));
  }

  return { sockets: resolveOutputSockets(doc, registry, outputsByNode), uniforms: uniformsByNode };
}

// Compile a document into a MeshStandardNodeMaterial. Feeds the terminal pbr-output node's connected
// inputs into the material — as live node sockets, or convertToTexture baked maps.
export function compileGraph(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  opts: CompileOptions,
): CompiledMaterial {
  const { sockets, uniforms: uniformsByNode } = compileSockets(doc, registry, opts);
  const material = new MeshStandardNodeMaterial({
    metalness: 0,
    roughness: 0.9,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  // Baked backend wraps each terminal field/colour in convertToTexture (renders the subgraph once into
  // a texture, then samples it). Normal stays procedural — baking a screen-derivative bump normal does
  // not round-trip; a dedicated normal bake is Phase 5.
  const wrap = (n: MaterialValue): MaterialValue =>
    opts.backend === "baked" ? convertToTexture(n, BAKE_SIZE, BAKE_SIZE) : n;

  if (sockets.baseColor) material.colorNode = wrap(sockets.baseColor);
  if (sockets.emission) material.emissiveNode = wrap(sockets.emission);
  if (sockets.roughness) material.roughnessNode = wrap(sockets.roughness);
  if (sockets.metallic) material.metalnessNode = wrap(sockets.metallic);
  if (sockets.ambientOcclusion) material.aoNode = wrap(sockets.ambientOcclusion);
  if (sockets.normal) material.normalNode = sockets.normal;

  return { material, uniforms: uniformsByNode };
}

function resolveInputs(
  node: GraphNode,
  def: MaterialNodeDef,
  doc: MaterialGraphDocument,
  outputs: Map<string, Record<string, MaterialValue>>,
): Record<string, MaterialValue | undefined> {
  const ins: Record<string, MaterialValue | undefined> = {};
  for (const port of def.inputs) {
    const edge = doc.edges.find((e) => e.toNode === node.id && e.toInput === port.key);
    ins[port.key] = edge ? outputs.get(edge.fromNode)?.[edge.fromOutput] : undefined;
  }
  return ins;
}

function bypassOutputs(
  def: MaterialNodeDef,
  inputs: Record<string, MaterialValue | undefined>,
): Record<string, MaterialValue> {
  const firstIn = def.inputs[0];
  const firstOut = def.outputs[0];
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
    } else if (p.type === "float" || p.type === "int") {
      out[p.key] = uniform(Number(raw));
    }
    // bool / select: build() reads the raw value via ctx.params.
  }
  return out;
}

function resolveOutputSockets(
  doc: MaterialGraphDocument,
  registry: NodeRegistry,
  outputs: Map<string, Record<string, MaterialValue>>,
): Partial<Record<PbrSocket, MaterialValue>> {
  const outNode = doc.nodes.find((n) => n.type === PBR_OUTPUT_TYPE);
  const sockets: Partial<Record<PbrSocket, MaterialValue>> = {};
  if (!outNode) return sockets;
  const def = registry.get(outNode.type);
  for (const port of def.inputs) {
    const edge = doc.edges.find((e) => e.toNode === outNode.id && e.toInput === port.key);
    if (edge) sockets[port.key as PbrSocket] = outputs.get(edge.fromNode)?.[edge.fromOutput];
  }
  return sockets;
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

function validate(doc: MaterialGraphDocument, registry: NodeRegistry): void {
  const outputs = doc.nodes.filter((n) => n.type === PBR_OUTPUT_TYPE);
  if (outputs.length !== 1) {
    throw new Error(`Expected exactly one ${PBR_OUTPUT_TYPE} node, found ${outputs.length}`);
  }
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seenInput = new Set<string>();
  for (const e of doc.edges) {
    const from = byId.get(e.fromNode);
    const to = byId.get(e.toNode);
    if (!from) throw new Error(`Edge from unknown node '${e.fromNode}'`);
    if (!to) throw new Error(`Edge to unknown node '${e.toNode}'`);
    const outPort = registry.get(from.type).outputs.find((p) => p.key === e.fromOutput);
    const inPort = registry.get(to.type).inputs.find((p) => p.key === e.toInput);
    if (!outPort) throw new Error(`Node '${from.type}' has no output '${e.fromOutput}'`);
    if (!inPort) throw new Error(`Node '${to.type}' has no input '${e.toInput}'`);
    if (outPort.kind !== inPort.kind) {
      throw new Error(
        `Type mismatch: ${from.type}.${e.fromOutput} (${outPort.kind}) -> ${to.type}.${e.toInput} (${inPort.kind})`,
      );
    }
    const inputKey = `${e.toNode}/${e.toInput}`;
    if (seenInput.has(inputKey)) throw new Error(`Multiple connections into ${to.type}.${e.toInput}`);
    seenInput.add(inputKey);
  }
}

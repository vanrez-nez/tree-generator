import * as THREE from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import { compileGraph } from "./compiler";
import { defaultRegistry, nodePorts, type NodeRegistry } from "./registry";
import { createDefaultDocument } from "./default-document";
import { coercionFor, curveToArray, GROUP_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE } from "./types";
import type {
  CurveValue,
  GraphEdge,
  GraphNode,
  MaterialBackend,
  MaterialGraphDocument,
  MaterialValue,
  PortDef,
  PortKind,
} from "./types";

const STORAGE_KEY = "material-graph-document:v1";
const DOC_VERSION = 2;

const rid = (): string => Math.random().toString(36).slice(2, 8);

// A freshly-added group starts as a single-float passthrough (Group Input → Group Output) so it is valid
// and enterable immediately; the user builds the network inside. (Editing the interface is future work.)
function initStarterGroup(node: GraphNode): void {
  const io: { inputs: PortDef[]; outputs: PortDef[] } = {
    inputs: [{ key: "value", kind: "float" }],
    outputs: [{ key: "value", kind: "float" }],
  };
  node.ports = io;
  const giId = `group-input-${rid()}`;
  const goId = `group-output-${rid()}`;
  node.subgraph = {
    version: DOC_VERSION,
    nodes: [
      {
        id: giId,
        type: GROUP_INPUT_TYPE,
        params: {},
        position: { x: 40, y: 120 },
        enabled: true,
        ports: { inputs: [], outputs: [{ key: "value", kind: "float" }] },
      },
      {
        id: goId,
        type: GROUP_OUTPUT_TYPE,
        params: {},
        position: { x: 460, y: 120 },
        enabled: true,
        ports: { inputs: [{ key: "value", kind: "float" }], outputs: [] },
      },
    ],
    edges: [{ fromNode: giId, fromOutput: "value", toNode: goId, toInput: "value" }],
  };
}

// Owns the live MaterialGraphDocument and the material compiled from it. The editor and UI mutate the
// document through this controller; float/colour param edits update uniforms live, structural edits
// (topology, int/bool/select params, backend) recompile and notify listeners so the surface swaps the
// material. Persists to sessionStorage (material-graph-plan.md).
export class MaterialGraphController {
  private doc: MaterialGraphDocument;
  private backend: MaterialBackend = "live";
  private material_: MeshStandardNodeMaterial;
  private uniforms: Map<string, Record<string, MaterialValue>>;
  private readonly listeners = new Set<() => void>();
  private lastError_: string | null = null;
  // Group navigation: the chain of group node ids from the root to the document currently being edited.
  // Edits target the active (sub)document; compile/persist always run on the root.
  private path: string[] = [];

  constructor(private readonly registry: NodeRegistry = defaultRegistry) {
    this.doc = this.load() ?? createDefaultDocument();
    const compiled = compileGraph(this.doc, this.registry, { backend: this.backend });
    this.material_ = compiled.material;
    this.uniforms = compiled.uniforms;
  }

  get material(): MeshStandardNodeMaterial {
    return this.material_;
  }
  get document(): MaterialGraphDocument {
    return this.doc;
  }
  // The (sub)document currently being edited — the root, or a group's subgraph when navigated in.
  get activeDocument(): MaterialGraphDocument {
    return this.active();
  }
  // Breadcrumb: the group node ids from root to the active document (empty at the root).
  get groupPath(): string[] {
    return [...this.path];
  }

  // Walk `path` from the root into nested group subgraphs. Self-heals to the root if the path is stale.
  private active(): MaterialGraphDocument {
    let doc = this.doc;
    for (const id of this.path) {
      const g = doc.nodes.find((n) => n.id === id && n.type === GROUP_TYPE);
      if (!g?.subgraph) {
        this.path = [];
        return this.doc;
      }
      doc = g.subgraph;
    }
    return doc;
  }

  // --- group navigation (no recompile; the editor re-renders from activeDocument) ------------------
  enterGroup(nodeId: string): boolean {
    const node = this.active().nodes.find((n) => n.id === nodeId && n.type === GROUP_TYPE);
    if (!node?.subgraph) return false;
    this.path.push(nodeId);
    return true;
  }
  exitGroup(): void {
    this.path.pop();
  }
  exitToDepth(depth: number): void {
    this.path.length = Math.max(0, Math.min(depth, this.path.length));
  }

  // --- group interface editing (Phase 5) ---------------------------------------------------------
  // Only valid while inside a group. A group's interface lives in two mirrored places that must stay in
  // sync: the group node's `ports` (in the parent doc) and the boundary node inside the subgraph
  // (group-input.outputs ↔ group inputs; group-output.inputs ↔ group outputs). These helpers edit both.
  private currentGroup(): { group: GraphNode; parent: MaterialGraphDocument } | null {
    if (this.path.length === 0) return null;
    let parent = this.doc;
    for (let i = 0; i < this.path.length - 1; i++) {
      const g = parent.nodes.find((n) => n.id === this.path[i] && n.type === GROUP_TYPE);
      if (!g?.subgraph) return null;
      parent = g.subgraph;
    }
    const group = parent.nodes.find((n) => n.id === this.path[this.path.length - 1]);
    return group?.subgraph ? { group, parent } : null;
  }

  private boundary(group: GraphNode, side: "input" | "output"): GraphNode | undefined {
    const type = side === "input" ? GROUP_INPUT_TYPE : GROUP_OUTPUT_TYPE;
    return group.subgraph!.nodes.find((n) => n.type === type);
  }

  // The boundary node mirrors the interface on its *opposite* face: group inputs surface as the Group
  // Input node's outputs, group outputs as the Group Output node's inputs.
  private static boundaryPorts(b: GraphNode, side: "input" | "output"): PortDef[] {
    const p = (b.ports ??= { inputs: [], outputs: [] });
    return side === "input" ? p.outputs : p.inputs;
  }
  private static groupPorts(group: GraphNode, side: "input" | "output"): PortDef[] {
    const p = (group.ports ??= { inputs: [], outputs: [] });
    return side === "input" ? p.inputs : p.outputs;
  }

  // Add an exposed socket to the current group. Returns the generated key (stable; rename only changes the
  // label so existing wires survive).
  addGroupSocket(side: "input" | "output", label: string, kind: PortKind): string | null {
    const cur = this.currentGroup();
    const b = cur && this.boundary(cur.group, side);
    if (!cur || !b) return null;
    const existing = MaterialGraphController.groupPorts(cur.group, side);
    const base = (label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "socket");
    let key = base;
    for (let i = 2; existing.some((p) => p.key === key); i++) key = `${base}-${i}`;
    const port: PortDef = { key, label: label.trim() || key, kind };
    existing.push(port);
    MaterialGraphController.boundaryPorts(b, side).push({ ...port });
    this.recompile();
    return key;
  }

  // Rename an exposed socket (label only — the key/identifier stays put, so wires are preserved).
  renameGroupSocket(side: "input" | "output", key: string, label: string): void {
    const cur = this.currentGroup();
    const b = cur && this.boundary(cur.group, side);
    if (!cur || !b) return;
    for (const ports of [
      MaterialGraphController.groupPorts(cur.group, side),
      MaterialGraphController.boundaryPorts(b, side),
    ]) {
      const p = ports.find((p) => p.key === key);
      if (p) p.label = label.trim() || key;
    }
    this.recompile();
  }

  // Remove an exposed socket and prune the wires it leaves dangling — both in the parent (edges on the
  // group node) and inside the subgraph (edges on the boundary node).
  removeGroupSocket(side: "input" | "output", key: string): void {
    const cur = this.currentGroup();
    const b = cur && this.boundary(cur.group, side);
    if (!cur || !b) return;
    const { group, parent } = cur;
    const sub = group.subgraph!;
    const drop = (ports: PortDef[]) => ports.filter((p) => p.key !== key);
    if (side === "input") {
      group.ports!.inputs = drop(group.ports!.inputs);
      b.ports!.outputs = drop(b.ports!.outputs);
      parent.edges = parent.edges.filter((e) => !(e.toNode === group.id && e.toInput === key));
      sub.edges = sub.edges.filter((e) => !(e.fromNode === b.id && e.fromOutput === key));
    } else {
      group.ports!.outputs = drop(group.ports!.outputs);
      b.ports!.inputs = drop(b.ports!.inputs);
      parent.edges = parent.edges.filter((e) => !(e.fromNode === group.id && e.fromOutput === key));
      sub.edges = sub.edges.filter((e) => !(e.toNode === b.id && e.toInput === key));
    }
    this.recompile();
  }
  get lastError(): string | null {
    return this.lastError_;
  }
  getBackend(): MaterialBackend {
    return this.backend;
  }
  getRegistry(): NodeRegistry {
    return this.registry;
  }

  // Subscribe to recompiles (a new material object). Returns an unsubscribe fn.
  onRecompile(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // --- param edits -------------------------------------------------------------------------------
  setParam(nodeId: string, key: string, value: unknown): void {
    const node = this.active().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.params[key] = value;

    // Float/colour params are live uniforms — update in place, no recompile.
    const def = this.registry.get(node.type);
    const param = def.params.find((p) => p.key === key);
    const uniform = this.uniforms.get(nodeId)?.[key];
    if (uniform && (param?.type === "float" || param?.type === "color" || param?.type === "vec3")) {
      if (param.type === "color") uniform.value = new THREE.Color(value as THREE.ColorRepresentation);
      else if (param.type === "vec3") {
        const v = value as { x: number; y: number; z: number };
        uniform.value.set(v.x, v.y, v.z);
      } else uniform.value = Number(value);
      this.persist();
      return;
    }
    // Curve params drive a live uniformArray: mutate its backing `.array` in place (update() re-uploads
    // it each frame), so dragging a curve point updates the render without a recompile.
    if (uniform && param?.type === "curve") {
      const flat = curveToArray(value as CurveValue);
      const arr = (uniform as unknown as { array: number[] }).array;
      for (let i = 0; i < flat.length; i++) arr[i] = flat[i];
      this.persist();
      return;
    }
    // int (loop counts), bool, select: recompile. If the node declares dynamic ports, a param change may
    // have added/removed sockets — drop any edges that now reference a missing port first.
    if (this.registry.get(node.type).declare) this.pruneDanglingEdges(node);
    this.recompile();
  }

  // Remove edges on the active document that reference ports `node` no longer has (after a declare change).
  private pruneDanglingEdges(node: GraphNode): void {
    const ports = nodePorts(node, this.registry);
    const ins = new Set(ports.inputs.map((p) => p.key));
    const outs = new Set(ports.outputs.map((p) => p.key));
    const doc = this.active();
    doc.edges = doc.edges.filter(
      (e) =>
        !(e.toNode === node.id && !ins.has(e.toInput)) &&
        !(e.fromNode === node.id && !outs.has(e.fromOutput)),
    );
  }

  // --- topology edits ----------------------------------------------------------------------------
  addNode(type: string, position: { x: number; y: number }): string {
    const def = this.registry.get(type);
    const params: Record<string, unknown> = {};
    for (const p of def.params) params[p.key] = p.default;
    const id = `${type}-${rid()}`;
    const node: GraphNode = { id, type, params, position, enabled: true };
    if (type === GROUP_TYPE) initStarterGroup(node);
    this.active().nodes.push(node);
    this.recompile();
    return id;
  }

  // Terminal / boundary nodes can't be deleted (output, and a subgraph's group I/O markers).
  private static readonly UNDELETABLE = new Set(["material-output", "group-output", "group-input"]);

  removeNode(id: string): void {
    const doc = this.active();
    const node = doc.nodes.find((n) => n.id === id);
    if (!node || MaterialGraphController.UNDELETABLE.has(node.type)) return;
    doc.nodes = doc.nodes.filter((n) => n.id !== id);
    doc.edges = doc.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
    this.recompile();
  }

  setNodeEnabled(id: string, enabled: boolean): void {
    const node = this.active().nodes.find((n) => n.id === id);
    if (!node) return;
    node.enabled = enabled;
    this.recompile();
  }

  setNodePosition(id: string, position: { x: number; y: number }): void {
    const node = this.active().nodes.find((n) => n.id === id);
    if (!node) return;
    node.position = position;
    this.persist(); // layout only, no recompile
  }

  // Returns false (and makes no change) if the port kinds are incompatible.
  connect(edge: GraphEdge): boolean {
    if (!this.portKindsMatch(edge)) return false;
    const doc = this.active();
    // One connection per single-input socket: drop any existing edge into the same input.
    doc.edges = doc.edges.filter((e) => !(e.toNode === edge.toNode && e.toInput === edge.toInput));
    doc.edges.push(edge);
    this.recompile();
    return true;
  }

  disconnect(edge: GraphEdge): void {
    const doc = this.active();
    doc.edges = doc.edges.filter(
      (e) =>
        !(
          e.fromNode === edge.fromNode &&
          e.fromOutput === edge.fromOutput &&
          e.toNode === edge.toNode &&
          e.toInput === edge.toInput
        ),
    );
    this.recompile();
  }

  // Permissive linking: a connection is allowed when a coercion exists from the output kind to the
  // input kind (identity for same-kind). Incompatible pairs (or any pair involving a non-coercible
  // kind such as shader) return false and are vetoed. See plan L6.
  portKindsMatch(edge: GraphEdge): boolean {
    const doc = this.active();
    const from = doc.nodes.find((n) => n.id === edge.fromNode);
    const to = doc.nodes.find((n) => n.id === edge.toNode);
    if (!from || !to) return false;
    const outKind = nodePorts(from, this.registry).outputs.find((p) => p.key === edge.fromOutput)?.kind;
    const inKind = nodePorts(to, this.registry).inputs.find((p) => p.key === edge.toInput)?.kind;
    return outKind !== undefined && inKind !== undefined && coercionFor(outKind, inKind) !== undefined;
  }

  portKindFor(nodeId: string, port: string, dir: "input" | "output"): PortKind | undefined {
    const node = this.active().nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    const ports = nodePorts(node, this.registry);
    return (dir === "input" ? ports.inputs : ports.outputs).find((p) => p.key === port)?.kind;
  }

  // --- backend + lifecycle -----------------------------------------------------------------------
  setBackend(backend: MaterialBackend): void {
    if (backend === this.backend) return;
    this.backend = backend;
    this.recompile();
  }

  reset(): void {
    this.doc = createDefaultDocument();
    this.path = [];
    this.recompile();
  }

  // Replace the whole graph with an externally-supplied document (a saved/test config) and recompile.
  // Used by the dual-system bake pipeline (__bakeConfig) to drive the graph from a single JSON.
  loadDocument(doc: MaterialGraphDocument): void {
    this.doc = doc;
    this.path = [];
    this.recompile();
  }

  private recompile(): void {
    try {
      const compiled = compileGraph(this.doc, this.registry, { backend: this.backend });
      this.material_ = compiled.material;
      this.uniforms = compiled.uniforms;
      this.lastError_ = null;
    } catch (err) {
      // Keep the previous material so a bad edit doesn't blank the surface; surface the error instead.
      this.lastError_ = err instanceof Error ? err.message : String(err);
      console.warn("[material-graph] compile failed:", this.lastError_);
    }
    this.persist();
    for (const fn of this.listeners) fn();
  }

  private persist(): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.doc));
    } catch {
      // sessionStorage may be unavailable (private mode / quota) — non-fatal.
    }
  }

  private load(): MaterialGraphDocument | null {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as MaterialGraphDocument;
      if (parsed.version !== DOC_VERSION || !Array.isArray(parsed.nodes)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

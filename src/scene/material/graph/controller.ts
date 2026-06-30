import { compileSockets, type CompileOptions, type CompiledSockets } from "./compiler";
import { defaultRegistry, nodePorts, type NodeRegistry } from "./registry";
import { createDefaultDocument } from "../presets";
import { coercionFor, GROUP_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE } from "./types";
import type {
  GraphEdge,
  GraphNode,
  MaterialGraphDocument,
  ParamType,
  PortDef,
  PortKind,
} from "./types";

// A change emitted to surface subscribers. `structural` = topology / document / solo / int-bool-select /
// group edits (the compiled material must be rebuilt). `param` = a single live-tweakable value edit
// (float/colour/vec3/curve) the surface can apply as a uniform (live backend) or fold into a re-bake.
export type GraphChange =
  | { kind: "structural" }
  | { kind: "param"; nodeId: string; key: string; paramType: ParamType; value: unknown };

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

// Owns the editable MaterialGraphDocument and the editor mutation API. It does NOT own a renderer, render
// targets, or a THREE material — baking is the MaterialBakeService's job, and the live on-screen material
// is a TexturedSurface bound to this graph. Edits persist to sessionStorage and emit a GraphChange so the
// surface(s) react (live-uniform tweak vs re-bake vs rebuild). Splitting these concerns means baking one
// graph can never knock out another object's material (material-graph-plan.md).
export class MaterialGraphController {
  private doc: MaterialGraphDocument;
  private lastError_: string | null = null;
  private readonly changeListeners = new Set<(change: GraphChange) => void>();
  // Group navigation: the chain of group node ids from the root to the document currently being edited.
  // Edits target the active (sub)document; compile/persist always run on the root.
  private path: string[] = [];
  // Solo/preview: the single node whose output is routed straight to the surface (Blender-style viewer),
  // or null. Exclusive — soloing one node clears any other. Transient (not persisted to the document).
  private soloNode_: string | null = null;

  // `storageKey` namespaces sessionStorage persistence. The tree's material uses the default key; a second
  // graph (e.g. the visual floor, or a throwaway used purely for an export bake) passes null to disable
  // persistence so it never clobbers the tree's saved graph.
  constructor(
    private readonly registry: NodeRegistry = defaultRegistry,
    private readonly storageKey: string | null = STORAGE_KEY,
  ) {
    this.doc = this.load() ?? createDefaultDocument();
    // A persisted graph can reference a node type/port that no longer exists (a removed/refactored node) —
    // that must not crash boot, so validate by compiling once and fall back to the default if it won't.
    try {
      compileSockets(this.doc, this.registry, { backend: "live" });
    } catch (err) {
      console.warn("[material] persisted graph failed to compile; resetting to default", err);
      this.doc = createDefaultDocument();
    }
  }

  // Compile the graph to a Principled bundle (+ per-node uniforms). The single compile entrypoint shared by
  // the bake service (offline channels) and the TexturedSurface (live material). Records lastError on throw.
  compileBundle(opts: CompileOptions): CompiledSockets {
    try {
      const result = compileSockets(this.doc, this.registry, opts);
      this.lastError_ = null;
      return result;
    } catch (err) {
      this.lastError_ = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // Subscribe to graph edits. Returns an unsubscribe fn. The TexturedSurface uses this to re-bake/recompile.
  onChange(fn: (change: GraphChange) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }
  // Persist the document and notify subscribers of the change. Every doc mutation routes through here.
  private emit(change: GraphChange): void {
    this.persist();
    for (const fn of this.changeListeners) fn(change);
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

  // Breadcrumb labels: each entered group's display name (custom label, else registry def.label, else id),
  // root → active. Walks the same path as active(); self-heals to empty if the path is stale.
  groupTrail(): { id: string; label: string }[] {
    const trail: { id: string; label: string }[] = [];
    let doc = this.doc;
    for (const id of this.path) {
      const g = doc.nodes.find((n) => n.id === id && n.type === GROUP_TYPE);
      if (!g?.subgraph) return [];
      trail.push({ id, label: g.label ?? this.registry.get(g.type).label ?? id });
      doc = g.subgraph;
    }
    return trail;
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
    this.emit({ kind: "structural" });
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
    this.emit({ kind: "structural" });
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
    this.emit({ kind: "structural" });
  }
  get lastError(): string | null {
    return this.lastError_;
  }
  getRegistry(): NodeRegistry {
    return this.registry;
  }

  // --- param edits -------------------------------------------------------------------------------
  setParam(nodeId: string, key: string, value: unknown): void {
    const node = this.active().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.params[key] = value;
    const def = this.registry.get(node.type);
    const paramType = def.params.find((p) => p.key === key)?.type;

    // Declare-driven select/bool can add/remove ports → prune now-dangling edges, then it's structural.
    if (def.declare && (paramType === "select" || paramType === "bool")) {
      this.pruneDanglingEdges(node);
      this.emit({ kind: "structural" });
      return;
    }
    // float/colour/vec3/curve are live-tweakable values (the surface updates a uniform live, or folds the
    // value into a re-bake). Everything else (int loop counts, plain bool/select) needs a structural rebuild.
    if (paramType === "float" || paramType === "color" || paramType === "vec3" || paramType === "curve") {
      this.emit({ kind: "param", nodeId, key, paramType, value });
    } else {
      this.emit({ kind: "structural" });
    }
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
    this.emit({ kind: "structural" });
    return id;
  }

  // Terminal / boundary nodes can't be deleted (output, and a subgraph's group I/O markers).
  private static readonly UNDELETABLE = new Set(["material-output", "group-output", "group-input"]);

  removeNode(id: string): void {
    const doc = this.active();
    const node = doc.nodes.find((n) => n.id === id);
    if (!node || MaterialGraphController.UNDELETABLE.has(node.type)) return;
    if (this.soloNode_ === id) this.soloNode_ = null; // don't preview a node that no longer exists
    doc.nodes = doc.nodes.filter((n) => n.id !== id);
    doc.edges = doc.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
    this.emit({ kind: "structural" });
  }

  // The node currently soloed to the surface, or null.
  get soloNode(): string | null {
    return this.soloNode_;
  }

  // Toggle solo/preview for a node (exclusive): routes its first output to the surface, or clears it if it
  // was already soloed. Recompiles so the surface swaps to/from the preview.
  toggleSolo(id: string): void {
    this.soloNode_ = this.soloNode_ === id ? null : id;
    this.emit({ kind: "structural" });
  }

  // Clear any active solo (e.g. before a structural change). Recompiles only if something was soloed.
  clearSolo(): void {
    if (this.soloNode_ === null) return;
    this.soloNode_ = null;
    this.emit({ kind: "structural" });
  }

  setNodePosition(id: string, position: { x: number; y: number }): void {
    const node = this.active().nodes.find((n) => n.id === id);
    if (!node) return;
    node.position = position;
    this.persist(); // layout only, no recompile
  }

  // Rename a node's display label. Empty/blank clears it (falls back to the registry def.label). Cosmetic:
  // the compiler ignores `label`, so this persists only — no recompile, no layout disturbance.
  setNodeLabel(id: string, label: string): void {
    const node = this.active().nodes.find((n) => n.id === id);
    if (!node) return;
    node.label = label.trim() || undefined;
    this.persist();
  }

  // Returns false (and makes no change) if the port kinds are incompatible.
  connect(edge: GraphEdge): boolean {
    if (!this.portKindsMatch(edge)) return false;
    const doc = this.active();
    // One connection per single-input socket: drop any existing edge into the same input.
    doc.edges = doc.edges.filter((e) => !(e.toNode === edge.toNode && e.toInput === edge.toInput));
    doc.edges.push(edge);
    this.emit({ kind: "structural" });
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
    this.emit({ kind: "structural" });
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

  // --- lifecycle ---------------------------------------------------------------------------------
  reset(): void {
    this.doc = createDefaultDocument();
    this.path = [];
    this.soloNode_ = null;
    this.emit({ kind: "structural" });
  }

  // Replace the whole graph with an externally-supplied document (a saved/test config). Used by preset
  // selection and by throwaway graphs the bake service compiles for export.
  loadDocument(doc: MaterialGraphDocument): void {
    this.doc = doc;
    this.path = [];
    this.soloNode_ = null;
    this.emit({ kind: "structural" });
  }

  private persist(): void {
    if (this.storageKey === null) return; // persistence disabled (e.g. the floor controller)
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(this.doc));
    } catch {
      // sessionStorage may be unavailable (private mode / quota) — non-fatal.
    }
  }

  private load(): MaterialGraphDocument | null {
    if (this.storageKey === null) return null;
    try {
      const raw = sessionStorage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as MaterialGraphDocument;
      if (parsed.version !== DOC_VERSION || !Array.isArray(parsed.nodes)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
}

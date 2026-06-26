import * as THREE from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import { compileGraph } from "./compiler";
import { defaultRegistry, type NodeRegistry } from "./registry";
import { createDefaultDocument } from "./default-document";
import type {
  GraphEdge,
  MaterialBackend,
  MaterialGraphDocument,
  MaterialValue,
  PortKind,
} from "./types";

const STORAGE_KEY = "material-graph-document:v1";
const DOC_VERSION = 1;

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
    const node = this.doc.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    node.params[key] = value;

    // Float/colour params are live uniforms — update in place, no recompile.
    const def = this.registry.get(node.type);
    const param = def.params.find((p) => p.key === key);
    const uniform = this.uniforms.get(nodeId)?.[key];
    if (uniform && (param?.type === "float" || param?.type === "color")) {
      if (param.type === "color") uniform.value = new THREE.Color(value as THREE.ColorRepresentation);
      else uniform.value = Number(value);
      this.persist();
      return;
    }
    // int (loop counts), bool, select: recompile.
    this.recompile();
  }

  // --- topology edits ----------------------------------------------------------------------------
  addNode(type: string, position: { x: number; y: number }): string {
    const def = this.registry.get(type);
    const params: Record<string, unknown> = {};
    for (const p of def.params) params[p.key] = p.default;
    const id = `${type}-${Math.random().toString(36).slice(2, 8)}`;
    this.doc.nodes.push({ id, type, params, position, enabled: true });
    this.recompile();
    return id;
  }

  removeNode(id: string): void {
    const node = this.doc.nodes.find((n) => n.id === id);
    if (!node || node.type === "pbr-output") return; // terminal output is non-deletable in v1
    this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id);
    this.doc.edges = this.doc.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
    this.recompile();
  }

  setNodeEnabled(id: string, enabled: boolean): void {
    const node = this.doc.nodes.find((n) => n.id === id);
    if (!node) return;
    node.enabled = enabled;
    this.recompile();
  }

  setNodePosition(id: string, position: { x: number; y: number }): void {
    const node = this.doc.nodes.find((n) => n.id === id);
    if (!node) return;
    node.position = position;
    this.persist(); // layout only, no recompile
  }

  // Returns false (and makes no change) if the port kinds are incompatible.
  connect(edge: GraphEdge): boolean {
    if (!this.portKindsMatch(edge)) return false;
    // One connection per single-input socket: drop any existing edge into the same input.
    this.doc.edges = this.doc.edges.filter(
      (e) => !(e.toNode === edge.toNode && e.toInput === edge.toInput),
    );
    this.doc.edges.push(edge);
    this.recompile();
    return true;
  }

  disconnect(edge: GraphEdge): void {
    this.doc.edges = this.doc.edges.filter(
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

  portKindsMatch(edge: GraphEdge): boolean {
    const from = this.doc.nodes.find((n) => n.id === edge.fromNode);
    const to = this.doc.nodes.find((n) => n.id === edge.toNode);
    if (!from || !to) return false;
    const outKind = this.registry.get(from.type).outputs.find((p) => p.key === edge.fromOutput)?.kind;
    const inKind = this.registry.get(to.type).inputs.find((p) => p.key === edge.toInput)?.kind;
    return outKind !== undefined && outKind === inKind;
  }

  portKindFor(nodeId: string, port: string, dir: "input" | "output"): PortKind | undefined {
    const node = this.doc.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    const ports = dir === "input" ? this.registry.get(node.type).inputs : this.registry.get(node.type).outputs;
    return ports.find((p) => p.key === port)?.kind;
  }

  // --- backend + lifecycle -----------------------------------------------------------------------
  setBackend(backend: MaterialBackend): void {
    if (backend === this.backend) return;
    this.backend = backend;
    this.recompile();
  }

  reset(): void {
    this.doc = createDefaultDocument();
    this.recompile();
  }

  // Replace the whole graph with an externally-supplied document (a saved/test config) and recompile.
  // Used by the dual-system bake pipeline (__bakeConfig) to drive the graph from a single JSON.
  loadDocument(doc: MaterialGraphDocument): void {
    this.doc = doc;
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

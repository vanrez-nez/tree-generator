import * as THREE from "three";
import type { MeshStandardNodeMaterial } from "three/webgpu";
import { uniform, vec3, normalWorld, texture, normalMap, float, attribute, uv } from "three/tsl";
import { compileGraph, newSurfaceMaterial } from "./compiler";
import { triplanarColor } from "../tsl/triplanar";
import { triplanarNormalMap } from "../tsl/triplanar-normal";
import { parallaxOcclusionUV } from "../tsl/parallax";
import { curveToArray, type CurveValue, type MaterialBackend, type MaterialValue, type PbrSocket } from "./types";
import type { MaterialGraphController, GraphChange } from "./controller";
import { type MaterialBakeService, type BakedTextureSet } from "./bake-service";

// Parallax-occlusion march steps (LINEAR cost, paid per floor fragment — the dominant GPU cost of the
// effect). 12 is the perf/quality balance.
const PARALLAX_LAYERS = 12;
// Coalesce offline re-bakes from rapid edits (slider drags) into one render on settle.
const REBAKE_DEBOUNCE_MS = 150;

// A live, on-screen material driven by a MaterialGraphController. In the OFFLINE backend (default) it bakes
// the graph to per-channel textures THROUGH the shared MaterialBakeService and samples them (triplanar /
// POM) on a stock-PBR surface; in the LIVE backend it shows the procedural node material directly. It owns
// no GPU bake of its own — all baking funnels through the one service — and it never touches another
// object's document, so editing one surface can't knock out another. Subscribes to the graph's onChange and
// reacts: live-uniform tweak (live backend) / debounced re-bake (offline) / full rebuild (structural).
export class TexturedSurface {
  // The baked offline surface material (stock PBR sampling the baked maps). Stable object; re-bakes render
  // into its textures in place.
  private readonly offlineMat = newSurfaceMaterial();
  // Per-node uniforms from the last live compile (for the live-backend live-tweak fast path).
  private liveUniforms = new Map<string, Record<string, MaterialValue>>();
  // The currently-presented material (offline or live), re-read by listeners on rebuild.
  private material_: MeshStandardNodeMaterial;

  readonly scaleUniform = uniform(1.2); // triplanar world scale (the "world / tile" control)
  readonly sharpnessUniform = uniform(8); // triplanar blend exponent
  readonly roughnessFactor = uniform(1); // glTF-style factors multiplied into the baked channels (live)
  readonly metalnessFactor = uniform(1);
  readonly colorTint = uniform(new THREE.Color(1, 1, 1));
  readonly parallaxScale = uniform(0); // 0 = OFF (the march is opt-in; it's the effect's dominant cost)
  lastBakeMs = 0;

  private readonly set: BakedTextureSet;
  private backend: MaterialBackend = "offline";
  private debugNormals = false;
  private triplanar = false; // off by default — plain mesh-UV sampling until enabled
  private wiredOnce = false;
  private lastPresent = new Set<PbrSocket>();
  private rebakeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();
  private lastError_: string | null = null;

  constructor(
    private readonly graph: MaterialGraphController,
    private readonly service: MaterialBakeService,
  ) {
    this.set = service.createTextureSet();
    // Startup fallback: no renderer yet → procedural live material so the surface is valid; the first
    // refresh() (after the service gets a renderer) switches to the baked offline surface.
    this.material_ = this.buildLive();
    this.graph.onChange((change) => this.onGraphChange(change));
  }

  // The material to put on the mesh. Re-read by onRebuilt listeners whenever it changes (backend switch /
  // live recompile). Offline re-bakes keep the same object (textures update in place).
  get material(): MeshStandardNodeMaterial {
    return this.material_;
  }

  get lastError(): string | null {
    return this.lastError_;
  }

  // ms of the last offline texture re-bake (0 in the live backend, which has no bake step).
  getLastBakeMs(): number {
    return this.backend === "offline" ? this.lastBakeMs : 0;
  }

  // Subscribe to material rebuilds (a new material object, or a backend switch). Returns an unsubscribe fn.
  onRebuilt(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // Re-derive the material from the current graph + backend (awaitable). Call after the service gains a
  // renderer, or on a backend switch — and internally on structural graph changes. Resolves once the bake
  // (or live recompile) and any rewire have completed, so callers can use `.material` immediately after.
  refresh(): Promise<void> {
    return this.rebuild();
  }

  // --- live surface tuning (offline backend) -----------------------------------------------------
  setScale(value: number): void {
    this.scaleUniform.value = value;
  }
  setSharpness(value: number): void {
    this.sharpnessUniform.value = value;
  }
  setRoughnessFactor(value: number): void {
    this.roughnessFactor.value = value;
  }
  setMetalnessFactor(value: number): void {
    this.metalnessFactor.value = value;
  }
  setColorTint(hex: string): void {
    this.colorTint.value.set(hex);
  }
  // Parallax depth. 0 must REMOVE the march (its dominant cost), so crossing 0 re-wires; above 0 it's live.
  setParallaxScale(value: number): void {
    const wasOn = this.parallaxScale.value > 0;
    this.parallaxScale.value = value;
    if (value > 0 !== wasOn) this.wire(this.lastPresent);
  }
  setTriplanar(on: boolean): void {
    if (on === this.triplanar) return;
    this.triplanar = on;
    this.wire(this.lastPresent);
  }
  setNormalDebug(on: boolean): void {
    if (on === this.debugNormals) return;
    this.debugNormals = on;
    this.wire(this.lastPresent);
  }
  setBackend(backend: MaterialBackend): void {
    if (backend === this.backend) return;
    this.backend = backend;
    void this.rebuild();
  }
  getBackend(): MaterialBackend {
    return this.backend;
  }

  // --- reacting to graph edits -------------------------------------------------------------------
  private onGraphChange(change: GraphChange): void {
    if (change.kind === "param") {
      // Live backend: float/colour/vec3/curve params are live uniforms — update in place, no re-bake.
      if (this.backend === "live" && this.updateLiveUniform(change)) return;
      // Offline: the value is baked into a texture, so any param edit needs a (debounced) re-bake.
      this.scheduleRebuild();
      return;
    }
    // Structural (topology / load / solo / backend / int-bool-select / group): rebuild promptly.
    void this.rebuild();
  }

  // Apply a single live param to its uniform without recompiling. Returns false if no matching uniform
  // exists (caller falls back to a re-bake/recompile).
  private updateLiveUniform(change: Extract<GraphChange, { kind: "param" }>): boolean {
    const u = this.liveUniforms.get(change.nodeId)?.[change.key];
    if (!u) return false;
    if (change.paramType === "color") {
      u.value = new THREE.Color(change.value as THREE.ColorRepresentation);
    } else if (change.paramType === "vec3") {
      const v = change.value as { x: number; y: number; z: number };
      u.value.set(v.x, v.y, v.z);
    } else if (change.paramType === "curve") {
      const flat = curveToArray(change.value as CurveValue);
      const arr = (u as unknown as { array: number[] }).array;
      for (let i = 0; i < flat.length; i++) arr[i] = flat[i];
    } else {
      u.value = Number(change.value);
    }
    return true;
  }

  private scheduleRebuild(): void {
    if (this.rebakeTimer !== undefined) clearTimeout(this.rebakeTimer);
    this.rebakeTimer = setTimeout(() => {
      this.rebakeTimer = undefined;
      void this.rebuild();
    }, REBAKE_DEBOUNCE_MS);
  }

  // Re-derive the presented material. Offline (with a renderer): bake the graph into the texture set via the
  // service, rewire on a channel-set change. Otherwise: compile the procedural live material.
  private async rebuild(): Promise<void> {
    try {
      if (this.backend === "offline" && this.service.hasRenderer) {
        const soloNodeId = this.graph.soloNode ?? undefined;
        const t0 = performance.now();
        const changed = await this.service.bakeInto(this.set, this.graph, { soloNodeId, label: "surface" });
        this.lastBakeMs = performance.now() - t0;
        if (changed || !this.wiredOnce) {
          this.wire(this.set.present);
          this.wiredOnce = true;
        }
        this.material_ = this.offlineMat;
      } else {
        this.material_ = this.buildLive();
      }
      this.lastError_ = this.graph.lastError;
    } catch (err) {
      this.lastError_ = err instanceof Error ? err.message : String(err);
      console.warn("[textured-surface] rebuild failed:", this.lastError_);
    }
    this.notify();
  }

  // Compile the procedural live material (used as a startup fallback and the "live" backend).
  private buildLive(): MeshStandardNodeMaterial {
    const soloNodeId = this.graph.soloNode ?? undefined;
    const { material, uniforms } = compileGraph(this.graph.document, this.graph.getRegistry(), {
      backend: "live",
      soloNodeId,
    });
    this.liveUniforms = uniforms;
    return material;
  }

  // Point the offline surface material's channel nodes at the baked textures. Only called when the present
  // channel set changes — re-baking re-renders the same texture objects in place.
  private wire(present: Set<PbrSocket>): void {
    this.lastPresent = present;
    const m = this.offlineMat;
    const scale = this.scaleUniform;
    const sharp = this.sharpnessUniform;
    const useParallax = this.set.hasHeight && !this.triplanar && this.parallaxScale.value > 0;
    const baseUv = uv();
    const pUv: MaterialValue = useParallax
      ? parallaxOcclusionUV(this.set.heightTarget!.texture, baseUv, this.parallaxScale, PARALLAX_LAYERS)
      : undefined;
    // Sample AT the parallax-offset location but take the mip LOD from the smooth base-UV derivatives.
    const ddx = baseUv.dFdx();
    const ddy = baseUv.dFdy();
    const sampleUv = (tex: MaterialValue): MaterialValue =>
      useParallax ? texture(tex, pUv).grad(ddx, ddy) : texture(tex);
    const sample = (ch: PbrSocket): MaterialValue =>
      this.triplanar
        ? triplanarColor(this.set.texture(ch)!, scale, sharp)
        : sampleUv(this.set.texture(ch)!);
    const shadingNormal: MaterialValue = !present.has("normal")
      ? normalWorld
      : this.triplanar
        ? triplanarNormalMap(this.set.texture("normal")!, scale, sharp)
        : normalMap(sampleUv(this.set.texture("normal")!).xyz, float(1));

    if (this.debugNormals) {
      m.colorNode = vec3(0, 0, 0);
      m.emissiveNode = shadingNormal.normalize().mul(0.5).add(0.5);
      m.roughnessNode = m.metalnessNode = m.aoNode = m.normalNode = null;
      m.needsUpdate = true;
      return;
    }
    m.colorNode = present.has("baseColor") ? sample("baseColor").mul(this.colorTint) : null;
    m.roughnessNode = present.has("roughness") ? sample("roughness").r.mul(this.roughnessFactor) : null;
    m.metalnessNode = present.has("metallic") ? sample("metallic").r.mul(this.metalnessFactor) : null;
    const vAo = attribute("vertexAo", "float");
    m.aoNode = present.has("ambientOcclusion") ? sample("ambientOcclusion").r.mul(vAo) : vAo;
    m.normalNode = present.has("normal") ? shadingNormal : null;
    m.emissiveNode = present.has("emission") ? sample("emission") : null;
    m.needsUpdate = true;
  }

  dispose(): void {
    this.set.dispose();
    this.offlineMat.dispose();
  }
}

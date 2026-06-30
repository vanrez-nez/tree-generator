import * as THREE from "three";
import { RenderTarget, type WebGPURenderer } from "three/webgpu";
import { vec3 } from "three/tsl";
import { encodeChannel, renderColorNodeToTarget, COLOR_CHANNELS } from "./channel-baker";
import type { MaterialGraphController } from "./controller";
import type { MaterialValue, PbrSocket } from "./types";

// Single owner of all GPU texture baking (plan: "a single pipeline manager to bake the textures").
// Decouples baking from any on-screen object: a material graph is baked into textures here, never by
// hijacking a live controller's document. Work is SERIALISED through one queue — the channel-baker uses
// shared module-level quads/RTs, so two bakes can't safely run at once anyway — and aggregate progress is
// reported (onProgress + console) so "bake N textures from different points" queues and reports as one.

const BAKE_SIZE = 1024;
// Anisotropic-filter taps for baked channel textures (within every desktop GPU's cap; driver clamps down).
const MAX_ANISOTROPY = 8;

// Channels a surface bakes: scalar/colour maps + tangent-space normal + emission. Height is separate (it
// drives parallax, not a lit channel) and tracked on the texture set.
export const SURFACE_CHANNELS: PbrSocket[] = [
  "baseColor", "roughness", "metallic", "ambientOcclusion", "normal", "emission",
];

// Allocate a render target configured for surface sampling (moved verbatim from OfflineMaterial.ensureTarget):
// colour channels sRGB (sampler linearises for PBR), data channels linear; repeat-wrap + trilinear/aniso
// mips so the high-frequency maps don't shimmer at grazing angles.
function makeChannelTarget(ch: PbrSocket | "height", size: number): RenderTarget {
  const rt = new RenderTarget(size, size);
  const t = rt.texture;
  t.colorSpace =
    ch !== "height" && COLOR_CHANNELS.includes(ch as PbrSocket) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = MAX_ANISOTROPY;
  return rt;
}

export interface BakeOptions {
  channels?: PbrSocket[];
  size?: number;
  soloNodeId?: string;
  label?: string;
}

// A reusable set of baked channel textures. A live surface holds ONE and re-renders into it in place, so
// the surface keeps referencing stable texture objects and only rewires when the present-channel set
// changes. A one-off export bake gets a transient set the caller disposes.
export class BakedTextureSet {
  private readonly targets = new Map<PbrSocket, RenderTarget>();
  heightTarget: RenderTarget | null = null;
  hasHeight = false;
  // The set of channels that were actually connected at the last bake, plus a height flag — folded into a
  // signature so a surface can tell when it must rewire its samplers (vs. just re-render in place).
  present = new Set<PbrSocket>();
  signature = "";

  constructor(
    readonly size: number,
    readonly channels: PbrSocket[],
  ) {}

  target(ch: PbrSocket): RenderTarget {
    let rt = this.targets.get(ch);
    if (!rt) {
      rt = makeChannelTarget(ch, this.size);
      this.targets.set(ch, rt);
    }
    return rt;
  }

  ensureHeightTarget(): RenderTarget {
    if (!this.heightTarget) this.heightTarget = makeChannelTarget("height", this.size);
    return this.heightTarget;
  }

  // The baked texture for a channel (null if never baked). Surfaces sample these.
  texture(ch: PbrSocket): THREE.Texture | null {
    return this.targets.get(ch)?.texture ?? null;
  }

  dispose(): void {
    for (const rt of this.targets.values()) rt.dispose();
    this.targets.clear();
    this.heightTarget?.dispose();
    this.heightTarget = null;
  }
}

export interface BakeProgress {
  completed: number;
  total: number;
  active: string | null;
}

export class MaterialBakeService {
  private renderer: WebGPURenderer | null = null;
  // Serial job chain — bakes run one at a time (shared GPU quads). Each job appends to this promise.
  private queue: Promise<unknown> = Promise.resolve();
  private completed = 0;
  private total = 0;
  private active: string | null = null;
  private readonly progressListeners = new Set<(p: BakeProgress) => void>();
  // Scratch readback target for readImage (one-off PNG/preview); resized on demand.
  private scratch: RenderTarget | null = null;
  private scratchSize = 0;

  // Wired once after renderer.init() (replaces the old per-controller attachRenderer). Surfaces that tried
  // to bake before this fall back to the live procedural material until a renderer exists.
  attachRenderer(renderer: WebGPURenderer): void {
    this.renderer = renderer;
  }
  get hasRenderer(): boolean {
    return this.renderer !== null;
  }

  onProgress(cb: (p: BakeProgress) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }
  private emitProgress(): void {
    const p: BakeProgress = { completed: this.completed, total: this.total, active: this.active };
    for (const cb of this.progressListeners) cb(p);
  }

  // Append one unit of GPU work to the serial queue. `total` grows as jobs enqueue and both counters reset
  // when the queue fully drains, so progress reads as N-of-M across a burst then clears.
  private enqueue<T>(label: string, job: () => T | Promise<T>): Promise<T> {
    this.total += 1;
    this.emitProgress();
    const run = this.queue.then(async () => {
      this.active = label;
      this.emitProgress();
      try {
        return await job();
      } finally {
        this.completed += 1;
        this.active = null;
        console.log(`[bake] ${this.completed}/${this.total} ${label}`);
        if (this.completed >= this.total) {
          this.completed = 0;
          this.total = 0;
        }
        this.emitProgress();
      }
    });
    // Keep the chain alive even if a job throws (one bad bake mustn't stall every later one).
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  createTextureSet(channels: PbrSocket[] = SURFACE_CHANNELS, size: number = BAKE_SIZE): BakedTextureSet {
    return new BakedTextureSet(size, channels);
  }

  // Render a graph's connected channels into `set`, in place (queued). Resolves true when the present
  // channel set changed since the last bake (so the caller rewires its samplers), false to just re-render.
  bakeInto(set: BakedTextureSet, graph: MaterialGraphController, opts: BakeOptions = {}): Promise<boolean> {
    return this.enqueue(opts.label ?? "surface", () => {
      const renderer = this.renderer;
      if (!renderer) return false;
      const { bundle } = graph.compileBundle({ backend: "offline", soloNodeId: opts.soloNodeId });
      const channels = opts.channels ?? set.channels;
      const present = new Set<PbrSocket>();
      for (const ch of channels) {
        const node = (bundle as Partial<Record<string, MaterialValue>>)[ch];
        if (!node) continue;
        renderColorNodeToTarget(renderer, encodeChannel(node, ch), set.target(ch), ch === "normal");
        present.add(ch);
      }
      // Height drives the parallax UV offset (its own linear target), not a lit channel.
      set.hasHeight = bundle.height !== undefined;
      if (set.hasHeight) {
        renderColorNodeToTarget(renderer, vec3(bundle.height), set.ensureHeightTarget(), false);
      }
      const signature = [...present].sort().join(",") + (set.hasHeight ? "|h" : "");
      const changed = signature !== set.signature;
      set.present = present;
      set.signature = signature;
      return changed;
    });
  }

  // Convenience pipeline: instantiate a texture set, bake the graph into it, hand it back (caller disposes).
  // This is the "set a preset, await the textures" path for callers that don't keep a live surface.
  async bake(graph: MaterialGraphController, opts: BakeOptions = {}): Promise<BakedTextureSet> {
    const set = this.createTextureSet(opts.channels, opts.size);
    await this.bakeInto(set, graph, opts);
    return set;
  }

  // Bake one channel and read it back as top-down ImageData (null if unconnected). For PNG export / 2D
  // preview — takes a graph, never a live on-screen controller, so it can't clobber another object.
  readImage(graph: MaterialGraphController, channel: PbrSocket, size = 512): Promise<ImageData | null> {
    return this.enqueue(`read:${channel}`, async () => {
      const renderer = this.renderer;
      if (!renderer) return null;
      const { bundle } = graph.compileBundle({ backend: "offline" });
      const node = (bundle as Partial<Record<string, MaterialValue>>)[channel];
      if (!node) return null;
      const rt = this.scratchTarget(size);
      renderColorNodeToTarget(renderer, encodeChannel(node, channel), rt, channel === "normal");
      // WebGPU readback is bottom-up RGBA8; flip vertically into the ImageData buffer. NOTE: `size` must
      // give 256-byte-aligned rows (multiple of 64 px) or the GPU copy's row padding scrambles the image.
      const buffer = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size)) as unknown as Uint8Array;
      const data = new Uint8ClampedArray(size * size * 4);
      const stride = size * 4;
      for (let y = 0; y < size; y++) {
        const src = (size - 1 - y) * stride;
        data.set(buffer.subarray(src, src + stride), y * stride);
      }
      return new ImageData(data, size, size);
    });
  }

  private scratchTarget(size: number): RenderTarget {
    if (!this.scratch || this.scratchSize !== size) {
      this.scratch?.dispose();
      this.scratch = new RenderTarget(size, size);
      this.scratchSize = size;
    }
    return this.scratch;
  }
}

// The one shared instance every caller bakes through.
export const bakeService = new MaterialBakeService();

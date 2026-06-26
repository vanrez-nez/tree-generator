import * as THREE from "three";
import { RenderTarget, type WebGPURenderer, type MeshPhysicalNodeMaterial } from "three/webgpu";
import { triplanarTexture, texture, positionWorld, normalWorld, uniform } from "three/tsl";
import { compileSockets, newSurfaceMaterial } from "./compiler";
import { encodeChannel, renderColorNodeToTarget, COLOR_CHANNELS } from "./channel-baker";
import { triplanarNormalMap } from "../tsl/triplanar-normal";
import type { MaterialGraphDocument, MaterialValue, PbrSocket } from "./types";
import type { NodeRegistry } from "./registry";

const BAKE_SIZE = 1024;
// Channels baked for the surface: the four scalar/colour maps + the tangent-space normal map.
const SURFACE_CHANNELS: PbrSocket[] = ["baseColor", "roughness", "metallic", "ambientOcclusion", "normal"];

// The OFFLINE surface material. The node graph is rendered once to per-channel textures (GPU-resident
// RenderTargets); the surface samples them via world-space triplanar projection + stock PBR lighting — the
// procedural engine never runs on the surface shader. `rebake()` re-renders the textures (cheap, GPU-only,
// no readback) on a graph/uniform edit; the surface material references the stable texture objects, so it
// only needs rewiring when the *set* of connected channels changes.
export class OfflineMaterial {
  readonly material: MeshPhysicalNodeMaterial = newSurfaceMaterial();
  readonly scaleUniform = uniform(1.2); // triplanar world scale (driven by the "world / tile" control)
  lastBakeMs = 0;

  private readonly targets = new Map<PbrSocket, RenderTarget>();
  private wiredSignature = ""; // which channels are currently sampled, to avoid needless material rebuilds

  constructor(private readonly size = BAKE_SIZE) {}

  setScale(value: number): void {
    this.scaleUniform.value = value;
  }

  // Compile the graph (offline/uv), render each connected channel into its RT, and (re)wire the surface
  // sampling if the connected set changed. Returns the bake duration (ms).
  rebake(renderer: WebGPURenderer, doc: MaterialGraphDocument, registry: NodeRegistry): number {
    const t0 = performance.now();
    const { bundle } = compileSockets(doc, registry, { backend: "offline" });
    const present: PbrSocket[] = [];
    for (const ch of SURFACE_CHANNELS) {
      const node = (bundle as Partial<Record<string, MaterialValue>>)[ch];
      if (!node) continue;
      renderColorNodeToTarget(renderer, encodeChannel(node, ch), this.ensureTarget(ch));
      present.push(ch);
    }
    const signature = present.join(",");
    if (signature !== this.wiredSignature) {
      this.wire(new Set(present));
      this.wiredSignature = signature;
    }
    this.lastBakeMs = performance.now() - t0;
    return this.lastBakeMs;
  }

  private ensureTarget(ch: PbrSocket): RenderTarget {
    let rt = this.targets.get(ch);
    if (!rt) {
      rt = new RenderTarget(this.size, this.size);
      const t = rt.texture;
      // Colour maps are sRGB-encoded (encodeChannel) → SRGBColorSpace so the sampler linearises for PBR;
      // data maps (roughness/metallic/ao/normal) stay linear. RepeatWrapping because triplanar samples at
      // world coords well outside [0,1].
      t.colorSpace = COLOR_CHANNELS.includes(ch) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = t.magFilter = THREE.LinearFilter;
      this.targets.set(ch, rt);
    }
    return rt;
  }

  // Point the surface material's channel nodes at the baked textures (triplanar). Only called when the set
  // of connected channels changes — re-baking re-renders the same texture objects in place.
  private wire(present: Set<PbrSocket>): void {
    const m = this.material;
    const scale = this.scaleUniform;
    const tri = (ch: PbrSocket): MaterialValue =>
      triplanarTexture(texture(this.targets.get(ch)!.texture), null, null, scale, positionWorld, normalWorld);

    m.colorNode = present.has("baseColor") ? tri("baseColor") : null;
    m.roughnessNode = present.has("roughness") ? tri("roughness").r : null;
    m.metalnessNode = present.has("metallic") ? tri("metallic").r : null;
    m.aoNode = present.has("ambientOcclusion") ? tri("ambientOcclusion").r : null;
    m.normalNode = present.has("normal")
      ? triplanarNormalMap(this.targets.get("normal")!.texture, scale)
      : null;
    m.needsUpdate = true;
  }

  dispose(): void {
    for (const rt of this.targets.values()) rt.dispose();
    this.targets.clear();
    this.material.dispose();
  }
}

import * as THREE from "three";
import { RenderTarget, type WebGPURenderer, type MeshPhysicalNodeMaterial } from "three/webgpu";
import { uniform, vec3, normalWorld, texture, normalMap, float, attribute } from "three/tsl";
import { compileSockets, newSurfaceMaterial } from "./compiler";
import { encodeChannel, renderColorNodeToTarget, COLOR_CHANNELS } from "./channel-baker";
import { triplanarColor } from "../tsl/triplanar";
import { triplanarNormalMap } from "../tsl/triplanar-normal";
import type { MaterialGraphDocument, MaterialValue, PbrSocket } from "./types";
import type { NodeRegistry } from "./registry";

const BAKE_SIZE = 1024;
// Anisotropic-filter taps for the baked channel textures. 8 is well within every desktop GPU's cap (≥16)
// and kills the grazing-angle normal-map shimmer; the driver clamps to its own max if lower.
const MAX_ANISOTROPY = 8;
// Channels baked for the surface: the scalar/colour maps, the tangent-space normal map, and emission.
// Emission bakes to an sRGB LDR texture (RGBA8), so emission color×strength is clamped to [0,1] — fine for
// glow masks; HDR strengths >1 would need a float RT (use the live backend for those).
const SURFACE_CHANNELS: PbrSocket[] = [
  "baseColor", "roughness", "metallic", "ambientOcclusion", "normal", "emission",
];

// The OFFLINE surface material. The node graph is rendered once to per-channel textures (GPU-resident
// RenderTargets); the surface samples them via world-space triplanar projection + stock PBR lighting — the
// procedural engine never runs on the surface shader. `rebake()` re-renders the textures (cheap, GPU-only,
// no readback) on a graph/uniform edit; the surface material references the stable texture objects, so it
// only needs rewiring when the *set* of connected channels changes.
export class OfflineMaterial {
  readonly material: MeshPhysicalNodeMaterial = newSurfaceMaterial();
  readonly scaleUniform = uniform(1.2); // triplanar world scale (driven by the "world / tile" control)
  readonly sharpnessUniform = uniform(8); // triplanar blend exponent (higher → narrower wash band on ~45° faces)
  // Surface-material factors (glTF-style): the scalar roughness/metalness MULTIPLY the baked channel, and
  // the colour tint multiplies the basecolor. They live as uniforms referenced inside the channel nodes,
  // so the Texture > Material controls scale the look live without a re-bake or material rebuild. Default
  // 1 / white = identity (no change on load). A node material ignores `material.roughness` once
  // `roughnessNode` is set — hence the factor, not the scalar.
  readonly roughnessFactor = uniform(1);
  readonly metalnessFactor = uniform(1);
  readonly colorTint = uniform(new THREE.Color(1, 1, 1));
  lastBakeMs = 0;

  private readonly targets = new Map<PbrSocket, RenderTarget>();
  private wiredSignature = ""; // which channels are currently sampled, to avoid needless material rebuilds
  private lastPresent = new Set<PbrSocket>();
  private debugNormals = false;
  private triplanar = false; // off by default — sample the baked textures by plain mesh UV until enabled

  constructor(private readonly size = BAKE_SIZE) {}

  setScale(value: number): void {
    this.scaleUniform.value = value;
  }

  setSharpness(value: number): void {
    this.sharpnessUniform.value = value;
  }

  // glTF-style factors multiplied into the baked channels (live uniforms — no re-bake / rewire needed).
  setRoughnessFactor(value: number): void {
    this.roughnessFactor.value = value;
  }
  setMetalnessFactor(value: number): void {
    this.metalnessFactor.value = value;
  }
  setColorTint(hex: string): void {
    this.colorTint.value.set(hex);
  }

  // Toggle world-space triplanar projection vs plain UV sampling of the baked maps. Re-wires the surface.
  setTriplanar(on: boolean): void {
    if (on === this.triplanar) return;
    this.triplanar = on;
    this.wire(this.lastPresent);
  }

  // Debug view: paint the surface with its actual shading normal (geometry + the triplanar normal map) as
  // RGB, unlit. Flat surface → smooth gradient; a working normal map → high-frequency relief on top. The
  // surest "is my normal map actually perturbing the surface" check.
  setNormalDebug(on: boolean): void {
    if (on === this.debugNormals) return;
    this.debugNormals = on;
    this.wire(this.lastPresent);
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
      renderColorNodeToTarget(renderer, encodeChannel(node, ch), this.ensureTarget(ch), ch === "normal");
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
      // Trilinear + anisotropic filtering. Without mipmaps the high-frequency normal/roughness maps alias
      // badly at grazing angles and silhouette edges — many texels collapse onto one pixel, so the normal
      // point-samples wildly between texels and the lighting sparkles/crawls as the camera moves. Mips +
      // anisotropy resolve to the right LOD; the WebGPU backend regenerates the RT's mip chain after each
      // bake because `generateMipmaps` is set (WebGPUBackend.finishRender).
      t.generateMipmaps = true;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.anisotropy = MAX_ANISOTROPY;
      this.targets.set(ch, rt);
    }
    return rt;
  }

  // Point the surface material's channel nodes at the baked textures (triplanar). Only called when the set
  // of connected channels changes — re-baking re-renders the same texture objects in place.
  private wire(present: Set<PbrSocket>): void {
    this.lastPresent = present;
    const m = this.material;
    const scale = this.scaleUniform;
    const sharp = this.sharpnessUniform;
    // Channel sampler: world-space triplanar (projection blend) or plain mesh-UV `texture()`.
    const sample = (ch: PbrSocket): MaterialValue =>
      this.triplanar
        ? triplanarColor(this.targets.get(ch)!.texture, scale, sharp)
        : texture(this.targets.get(ch)!.texture);
    // The world-space shading normal: triplanar reorient, or UV normal-map (TBN), else the geometry normal.
    const shadingNormal: MaterialValue = !present.has("normal")
      ? normalWorld
      : this.triplanar
        ? triplanarNormalMap(this.targets.get("normal")!.texture, scale, sharp)
        : normalMap(texture(this.targets.get("normal")!.texture).xyz, float(1));

    if (this.debugNormals) {
      // Unlit normal visualisation: emissive = encoded shading normal, albedo black so lighting can't tint it.
      m.colorNode = vec3(0, 0, 0);
      m.emissiveNode = shadingNormal.normalize().mul(0.5).add(0.5);
      m.roughnessNode = m.metalnessNode = m.aoNode = m.normalNode = null;
      m.needsUpdate = true;
      return;
    }
    // Channels carry the baked map × the live factor/tint (identity by default — see the factor uniforms).
    m.colorNode = present.has("baseColor") ? sample("baseColor").mul(this.colorTint) : null;
    m.roughnessNode = present.has("roughness") ? sample("roughness").r.mul(this.roughnessFactor) : null;
    m.metalnessNode = present.has("metallic") ? sample("metallic").r.mul(this.metalnessFactor) : null;
    // Baked per-vertex form AO (always applied), multiplied by the node-graph AO channel when present.
    // aoNode modulates only the indirect (ambient/IBL) term — exactly ambient occlusion.
    const vAo = attribute("vertexAo", "float");
    m.aoNode = present.has("ambientOcclusion") ? sample("ambientOcclusion").r.mul(vAo) : vAo;
    m.normalNode = present.has("normal") ? shadingNormal : null;
    // Emission: sample the baked emission map (sRGB → linearised by the sampler). LDR (clamped [0,1]).
    m.emissiveNode = present.has("emission") ? sample("emission") : null;
    m.needsUpdate = true;
  }

  dispose(): void {
    for (const rt of this.targets.values()) rt.dispose();
    this.targets.clear();
    this.material.dispose();
  }
}

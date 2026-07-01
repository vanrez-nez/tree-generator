import * as THREE from "three";
import { RenderTarget, PMREMGenerator, type WebGPURenderer } from "three/webgpu";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { bakeService } from "../scene/material/graph/bake-service";
import { MaterialGraphController } from "../scene/material/graph/controller";
import type { NodeRegistry } from "../scene/material/graph/registry";
import { TexturedSurface } from "../scene/material/graph/textured-surface";
import {
  PBR_SOCKETS,
  type PbrSocket,
  type MaterialGraphDocument,
} from "../scene/material/graph/types";
import type { GraphDocument } from "../scene/graph/document";

// Dev-only: bake a PBR channel and POST it to the bake server (scripts/bake-server.mjs,
// `npm run bake:server`), which writes it to ./bake/<channel>.png. Lets a node configuration be saved
// as a 2D texture on disk for inspection. No-op if the bake server isn't running.
const BAKE_SERVER = "http://127.0.0.1:8788";
const MATERIAL_TASK_CHANNELS: PbrSocket[] = [
  "baseColor",
  "roughness",
  "normal",
  "metallic",
  "ambientOcclusion",
];

export interface ExportDeps {
  renderer: WebGPURenderer;
  // The node registry every throwaway export controller is built from. Decoupled from MainScene so the
  // isolated /export-bake worker can reuse this tooling with `defaultRegistry`.
  registry: NodeRegistry;
  // The live document to bake when `saveChannelToBake`/`downloadChannelPng` are called without an explicit
  // `doc` (the app supplies the tree's current graph). Optional: the worker never uses those paths.
  liveDocument?: () => MaterialGraphDocument;
}

// A named lighting setup for the lit sphere/plane demo render. Each profile produces one image
// (renders/<name>.png) tuned to reveal a specific surface aspect. All fields but `name` are optional and
// fall back through: per-entry override → built-in profile → global render options → hard defaults.
export interface RenderProfile {
  name: string; // output file stem (renders/<name>.png)
  lightPosition?: [number, number, number]; // key directional light position
  lightIntensity?: number; // key directional light intensity
  ambientStrength?: number; // AmbientLight intensity
  environmentIntensity?: number; // IBL (RoomEnvironment PMREM) strength; 0 = no environment
  shadows?: boolean; // cast + receive shadows
  background?: string; // CSS hex background
  size?: number; // output px (square); rounded to a multiple of 64 for readback alignment
  samples?: number; // MSAA: WebGPU supports 4× or off, so ≥2 → 4×, else off
}

// Payload-level options for the demo render. `profiles` selects/overrides which named profiles to render
// (default: all built-ins); the other fields are global defaults applied to every profile.
export interface DemoRenderOptions {
  size?: number;
  samples?: number;
  shadows?: boolean;
  background?: string;
  environmentIntensity?: number;
  profiles?: Array<string | RenderProfile>;
}

// Hard defaults (lowest precedence).
const RENDER_DEFAULTS: Required<Omit<RenderProfile, "name">> = {
  lightPosition: [3, 4, 5],
  lightIntensity: 3.0,
  ambientStrength: 0.35,
  environmentIntensity: 0,
  shadows: true,
  background: "#181818",
  size: 512,
  samples: 4,
};

// Built-in profiles. Each tuned to reveal one surface aspect; values are starting points.
const RENDER_PROFILES: Record<string, Omit<RenderProfile, "name">> = {
  // Balanced key + fill, soft shadow. The general-purpose look.
  standard: {},
  // Low raking light + very low ambient so the normal-map relief (surface displacement) casts strong
  // grazing shading gradients. Shadow off so the cast shadow doesn't compete with the micro-relief.
  normals: {
    lightPosition: [6, 0.9, 1.2],
    lightIntensity: 3.4,
    ambientStrength: 0.06,
    shadows: false,
    background: "#101010",
  },
  // A metal reflects only the environment, so add an IBL env at high intensity; keep direct light low so
  // the reflection dominates. Metalness comes from the doc's baked channel (a dielectric stays matte).
  metallic: {
    lightPosition: [3, 4, 5],
    lightIntensity: 1.0,
    ambientStrength: 0.1,
    environmentIntensity: 1.3,
    background: "#202024",
  },
  // Ambient-dominant, weak directional, no shadow — baked AO only modulates the indirect term, so a flat
  // ambient rig lets the occlusion darkening read.
  ao: {
    lightPosition: [0, 6, 2],
    lightIntensity: 0.25,
    ambientStrength: 1.1,
    shadows: false,
    background: "#202020",
  },
};

type ResolvedProfile = Required<Omit<RenderProfile, "name">> & { name: string };

// Drop undefined keys so a `{...partial}` spread doesn't clobber earlier (lower-precedence) values.
function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// Resolve the render options into a list of fully-populated profiles. `profiles` selects/overrides which
// to render (default: all built-ins). Precedence: hard defaults < global render options < built-in
// profile < per-entry override.
function resolveProfiles(render: DemoRenderOptions = {}): ResolvedProfile[] {
  const globals = definedOnly({
    size: render.size,
    samples: render.samples,
    shadows: render.shadows,
    background: render.background,
    environmentIntensity: render.environmentIntensity,
  });
  const entries = render.profiles ?? Object.keys(RENDER_PROFILES);
  return entries.map((entry) => {
    const name = typeof entry === "string" ? entry : entry.name;
    const builtin = RENDER_PROFILES[name] ?? {};
    const override = typeof entry === "string" ? {} : entry;
    return {
      ...RENDER_DEFAULTS,
      ...globals,
      ...definedOnly(builtin),
      ...definedOnly(override),
      name,
    };
  });
}

export interface ExportApi {
  saveChannelToBake(channel: PbrSocket, size?: number, doc?: MaterialGraphDocument): Promise<void>;
  downloadChannelPng(
    channel: PbrSocket,
    filename: string,
    size?: number,
    doc?: MaterialGraphDocument,
  ): Promise<void>;
  bakeConfigToBake(doc: MaterialGraphDocument, name?: string, size?: number): Promise<void>;
  bakeMaterialTask(
    doc: MaterialGraphDocument,
    outputFolder: string,
    channelSize?: number,
    channels?: PbrSocket[],
    render?: DemoRenderOptions,
  ): Promise<string[]>;
  saveTilingComposite(type: string, img: ImageData): Promise<void>;
  downloadDocument(doc: GraphDocument): void;
}

// Reject a malformed document before anything is written. loadDocument does NO validation (it stores the
// value and defers the crash to `.nodes`), so an unchecked bad doc would POST a garbage preset.json first.
export function isValidDocument(doc: unknown): doc is MaterialGraphDocument {
  return (
    !!doc &&
    typeof doc === "object" &&
    Array.isArray((doc as MaterialGraphDocument).nodes) &&
    Array.isArray((doc as MaterialGraphDocument).edges)
  );
}

// The bake/export tooling is decoupled from the pane: every function here bakes on a THROWAWAY,
// non-persisting controller (exportGraph), so inspecting or exporting a channel never reads, mutates,
// or persists any on-screen material. Bound once to the renderer + registry it renders against.
export function createExport({ renderer, registry, liveDocument }: ExportDeps): ExportApi {
  // The live document to fall back on for saveChannelToBake/downloadChannelPng (throws if the caller wired
  // no liveDocument — only relevant to the app, which always provides one).
  function liveDoc(): MaterialGraphDocument {
    if (!liveDocument) throw new Error("createExport: no liveDocument provided for the default doc");
    return structuredClone(liveDocument());
  }

  function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  function imageDataToCanvas(image: ImageData): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    return canvas;
  }

  async function postBakeFile(file: string, body: BodyInit): Promise<boolean> {
    try {
      const res = await fetch(`${BAKE_SERVER}/save?name=${file}`, { method: "POST", body });
      return res.ok;
    } catch {
      console.warn("[bake] POST failed — is `npm run bake:server` running?");
      return false;
    }
  }

  // Build a 2×2 composite of a baked tile and POST it to the bake server (dev) as tiling-<type>.png — the
  // internal edges reveal any seam visually, alongside the numeric score from runTilingTest.
  async function saveTilingComposite(type: string, img: ImageData): Promise<void> {
    const tile = imageDataToCanvas(img);
    const proof = document.createElement("canvas");
    proof.width = img.width * 2;
    proof.height = img.height * 2;
    const ctx = proof.getContext("2d");
    if (!ctx) return;
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) ctx.drawImage(tile, x * img.width, y * img.height);
    const blob = await canvasToPngBlob(proof);
    if (blob) await postBakeFile(`tiling-${type}.png`, blob);
  }

  // A throwaway graph for export baking. Built from a document with NO persistence, so it never touches the
  // tree's or floor's live material — this is the whole point of the bake-service split (no more clobber).
  function exportGraph(doc: MaterialGraphDocument): MaterialGraphController {
    const graph = new MaterialGraphController(registry, null);
    graph.loadDocument(doc, { persist: false });
    if (graph.lastError) console.warn(`[bake] config compiled with error: ${graph.lastError}`);
    return graph;
  }

  // Bake-to-disk is an ephemeral PREVIEW tool: it compiles the document on a throwaway, non-persisting
  // controller (exportGraph) so inspecting a channel never reads, mutates, or persists any on-screen
  // material. `doc` defaults to a clone of the current tree graph (loadDocument mutates its input, so the
  // live doc must never be passed directly); pass any document to bake something off-screen.
  async function saveChannelToBake(
    channel: PbrSocket,
    size = 1024,
    doc: MaterialGraphDocument = liveDoc(),
  ): Promise<void> {
    const image = await bakeService.readImage(exportGraph(doc), channel, size);
    if (!image) return;
    const blob = await canvasToPngBlob(imageDataToCanvas(image));
    if (!blob) return;
    await postBakeFile(`${channel}.png`, blob);
  }

  // Bake a channel of a graph (via the service) and trigger a browser download. Replaces the old
  // ChannelBaker.downloadPng; uses a transient object URL + synthetic anchor (revoked next tick). Like
  // saveChannelToBake, this is ephemeral — it bakes a throwaway clone, never the live material.
  async function downloadChannelPng(
    channel: PbrSocket,
    filename: string,
    size = 1024,
    doc: MaterialGraphDocument = liveDoc(),
  ): Promise<void> {
    const image = await bakeService.readImage(exportGraph(doc), channel, size);
    if (!image) return;
    const blob = await canvasToPngBlob(imageDataToCanvas(image));
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function makeTileabilityProof(channelImages: Map<PbrSocket, ImageData>): HTMLCanvasElement | null {
    const base = channelImages.get("baseColor") ?? channelImages.values().next().value;
    if (!base) return null;
    const tile = imageDataToCanvas(base);
    const proof = document.createElement("canvas");
    proof.width = base.width * 2;
    proof.height = base.height * 2;
    const ctx = proof.getContext("2d");
    if (!ctx) return null;
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) ctx.drawImage(tile, x * base.width, y * base.height);
    }
    return proof;
  }

  function buildStandardMaterialDemoScene(
    material: THREE.Material,
    profile: Required<Omit<RenderProfile, "name">>,
    environment: THREE.Texture | null,
  ): {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    dispose: () => void;
  } {
    const { lightPosition, lightIntensity, ambientStrength, environmentIntensity, shadows, background } =
      profile;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);
    if (environment && environmentIntensity > 0) {
      scene.environment = environment; // IBL reflections (metallic profile); background stays independent
      scene.environmentIntensity = environmentIntensity;
    }
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 20);
    camera.position.set(0, 1.25, 4.2);
    camera.lookAt(0, 0.45, 0);

    const sphereGeometry = new THREE.SphereGeometry(1, 96, 48);
    const planeGeometry = new THREE.PlaneGeometry(8, 8); // wide enough to catch the cast shadow
    const addFullVertexAo = (geometry: THREE.BufferGeometry): void => {
      geometry.setAttribute(
        "vertexAo",
        new THREE.BufferAttribute(new Float32Array(geometry.getAttribute("position").count).fill(1), 1),
      );
    };
    addFullVertexAo(sphereGeometry);
    addFullVertexAo(planeGeometry);
    const sphere = new THREE.Mesh(sphereGeometry, material);
    sphere.position.set(0, 0.95, 0);
    sphere.castShadow = shadows;
    sphere.receiveShadow = shadows;
    const plane = new THREE.Mesh(planeGeometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.12;
    plane.receiveShadow = shadows;

    const key = new THREE.DirectionalLight(0xffffff, lightIntensity);
    key.position.set(lightPosition[0], lightPosition[1], lightPosition[2]);
    if (shadows) {
      key.castShadow = true;
      key.shadow.mapSize.set(2048, 2048);
      const cam = key.shadow.camera;
      cam.near = 0.5;
      cam.far = 20;
      cam.left = -4;
      cam.right = 4;
      cam.top = 4;
      cam.bottom = -4;
      cam.updateProjectionMatrix();
      key.shadow.bias = -0.0008;
      key.shadow.normalBias = 0.02;
      key.shadow.radius = 4; // soft PCF edges
    }
    const fill = new THREE.AmbientLight(0xffffff, ambientStrength);
    scene.add(sphere, plane, key, key.target, fill);

    return {
      scene,
      camera,
      dispose: () => {
        sphereGeometry.dispose();
        planeGeometry.dispose();
        scene.remove(sphere, plane, key, key.target, fill);
      },
    };
  }

  // Render one resolved lighting profile of the lit sphere/plane demo to an offscreen (optionally
  // multisampled) target, read it back, and return a PNG. Uses a RenderTarget instead of the canvas so
  // MSAA + size are configurable and the shared canvas is never disturbed.
  async function renderStandardMaterialDemo(
    material: THREE.Material,
    profile: Required<Omit<RenderProfile, "name">>,
    environment: THREE.Texture | null,
  ): Promise<Blob | null> {
    // Readback needs 256-byte-aligned rows → a multiple of 64 px.
    const dim = Math.max(64, Math.round(profile.size / 64) * 64);
    // WebGPU only supports a sample count of 1 or 4 — so MSAA is 4× or off (anything ≥2 → 4×).
    const msaa = profile.samples >= 2 ? 4 : 0;
    const rt = new RenderTarget(dim, dim, { samples: msaa, depthBuffer: true });
    // Encode to sRGB when writing the offscreen target so the readback matches the canvas' output (an
    // un-tagged target reads back linear → looks too dark).
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const demo = buildStandardMaterialDemoScene(material, profile, environment);

    const prevShadowEnabled = renderer.shadowMap.enabled;
    const prevShadowType = renderer.shadowMap.type;
    const prevTarget = renderer.getRenderTarget();
    try {
      if (profile.shadows) {
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      }
      renderer.setRenderTarget(rt);
      renderer.render(demo.scene, demo.camera);

      // A 3D scene rendered to a RenderTarget is already Y-flipped by three's render-to-texture
      // convention, so — unlike the 2D channel bakes — copy rows straight (no manual flip) to stay upright.
      const buffer = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, dim, dim)) as unknown as Uint8Array;
      const canvas = document.createElement("canvas");
      canvas.width = dim;
      canvas.height = dim;
      canvas.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(buffer), dim, dim), 0, 0);
      return await canvasToPngBlob(canvas);
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.shadowMap.enabled = prevShadowEnabled;
      renderer.shadowMap.type = prevShadowType;
      demo.dispose();
      rt.dispose();
    }
  }

  // Bake every connected PBR channel of a config (a MaterialGraphDocument) and POST each to the bake-server
  // under bake/<name>/<channel>.ours.png alongside the config JSON. The Blender reference for the SAME config
  // is produced separately by `npm run bake:blender` (bake/<name>/<channel>.blender.png) — side by side.
  async function bakeConfigToBake(
    doc: MaterialGraphDocument,
    name = "config",
    size = 1024,
  ): Promise<void> {
    if (!isValidDocument(doc)) throw new Error("bakeConfigToBake: invalid document (missing nodes/edges)");
    const graph = exportGraph(doc);
    await postBakeFile(
      `${name}/config.json`,
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    );

    const written: string[] = [];
    for (const channel of PBR_SOCKETS) {
      const image = await bakeService.readImage(graph, channel, size);
      if (!image) continue; // channel unconnected — skip
      const blob = await canvasToPngBlob(imageDataToCanvas(image));
      if (!blob) continue;
      await postBakeFile(`${name}/${channel}.ours.png`, blob);
      written.push(channel);
    }
    console.log(`[bake] wrote bake/${name}/ — channels: ${written.join(", ") || "(none connected)"}`);
  }

  // Reusable material-task pipeline: bake the standard channel set on a throwaway graph, write the preset,
  // prove the base tile as a 2x2 image, and capture a 512x512 standard material demo (sphere plus plane).
  // Every catalog render task uses this — and it never disturbs the on-screen tree/floor materials.
  async function bakeMaterialTask(
    doc: MaterialGraphDocument,
    outputFolder: string,
    channelSize = 1024,
    channels: PbrSocket[] = MATERIAL_TASK_CHANNELS,
    render: DemoRenderOptions = {},
  ): Promise<string[]> {
    // Validate before writing anything — otherwise a bad doc would POST a garbage preset.json first.
    if (!isValidDocument(doc)) throw new Error("bakeMaterialTask: invalid document (missing nodes/edges)");
    const folder = outputFolder.replace(/^bake\//, "").replace(/\/$/, "");
    const graph = exportGraph(doc);

    const channelImages = new Map<PbrSocket, ImageData>();
    const written: string[] = [];
    await postBakeFile(
      `${folder}/preset.json`,
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    );

    for (const channel of channels) {
      const image = await bakeService.readImage(graph, channel, channelSize);
      if (!image) continue;
      channelImages.set(channel, image);
      const blob = await canvasToPngBlob(imageDataToCanvas(image));
      if (!blob) continue;
      await postBakeFile(`${folder}/channels/${channel}.png`, blob);
      written.push(channel);
    }

    const proof = makeTileabilityProof(channelImages);
    const proofBlob = proof ? await canvasToPngBlob(proof) : null;
    if (proofBlob) await postBakeFile(`${folder}/renders/tiled-2x2.png`, proofBlob);

    // The lit demo needs a real material: build a throwaway textured surface from the same graph (baked
    // through the service) and render each lighting profile to renders/<profile>.png.
    const profiles = resolveProfiles(render);
    const surface = new TexturedSurface(graph, bakeService);
    await surface.refresh();

    // Build the IBL environment once (only if a profile needs it — the metallic profile), shared across
    // all profile renders, then disposed.
    let env: THREE.Texture | null = null;
    let pmrem: PMREMGenerator | null = null;
    if (profiles.some((p) => p.environmentIntensity > 0)) {
      pmrem = new PMREMGenerator(renderer);
      env = pmrem.fromScene(new RoomEnvironment()).texture;
    }

    const rendered: string[] = [];
    for (const profile of profiles) {
      const blob = await renderStandardMaterialDemo(surface.material, profile, env);
      if (!blob) continue;
      await postBakeFile(`${folder}/renders/${profile.name}.png`, blob);
      rendered.push(profile.name);
    }

    env?.dispose();
    pmrem?.dispose();
    surface.dispose();

    console.log(
      `[material-task] wrote bake/${folder}/ — channels: ${written.join(", ") || "(none connected)"}, tileability proof: ${proofBlob ? "yes" : "no"}, renders: ${rendered.join("/") || "(none)"}`,
    );
    return written;
  }

  // Serialize the current graph document and trigger a browser download.
  function downloadDocument(doc: GraphDocument): void {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "tree-document.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return {
    saveChannelToBake,
    downloadChannelPng,
    bakeConfigToBake,
    bakeMaterialTask,
    saveTilingComposite,
    downloadDocument,
  };
}

import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import type { MainScene } from "../scene/main";
import { bakeService } from "../scene/material/graph/bake-service";
import { MaterialGraphController } from "../scene/material/graph/controller";
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
  sceneCanvas: HTMLCanvasElement;
  mainScene: MainScene;
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
  bakeMaterialTask(doc: MaterialGraphDocument, outputFolder: string, channelSize?: number): Promise<void>;
  saveTilingComposite(type: string, img: ImageData): Promise<void>;
  downloadDocument(doc: GraphDocument): void;
}

// The bake/export tooling is decoupled from the pane: every function here bakes on a THROWAWAY,
// non-persisting controller (exportGraph), so inspecting or exporting a channel never reads, mutates,
// or persists any on-screen material. Bound once to the renderer + scene it renders against.
export function createExport({ renderer, sceneCanvas, mainScene }: ExportDeps): ExportApi {
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
    const graph = new MaterialGraphController(mainScene.materialController.getRegistry(), null);
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
    doc: MaterialGraphDocument = structuredClone(mainScene.materialController.document),
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
    doc: MaterialGraphDocument = structuredClone(mainScene.materialController.document),
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

  function buildStandardMaterialDemoScene(material: THREE.Material): {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    dispose: () => void;
  } {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x181818);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 20);
    camera.position.set(0, 1.25, 4.2);
    camera.lookAt(0, 0.45, 0);

    const sphereGeometry = new THREE.SphereGeometry(1, 96, 48);
    const planeGeometry = new THREE.PlaneGeometry(5, 5);
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
    const plane = new THREE.Mesh(planeGeometry, material);
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -0.12;

    const key = new THREE.DirectionalLight(0xffffff, 3.0);
    key.position.set(3, 4, 5);
    const fill = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(sphere, plane, key, fill);

    return {
      scene,
      camera,
      dispose: () => {
        sphereGeometry.dispose();
        planeGeometry.dispose();
        scene.remove(sphere, plane, key, fill);
      },
    };
  }

  async function renderStandardMaterialDemo(material: THREE.Material, size = 512): Promise<Blob | null> {
    const previousPixelRatio = renderer.getPixelRatio();
    const previousSize = new THREE.Vector2();
    renderer.getSize(previousSize);
    const demo = buildStandardMaterialDemoScene(material);
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(size, size, false);
      renderer.render(demo.scene, demo.camera);
      return await canvasToPngBlob(sceneCanvas);
    } finally {
      demo.dispose();
      renderer.setPixelRatio(previousPixelRatio);
      renderer.setSize(previousSize.x, previousSize.y, false);
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
  ): Promise<void> {
    const folder = outputFolder.replace(/^bake\//, "").replace(/\/$/, "");
    const graph = exportGraph(doc);

    const channelImages = new Map<PbrSocket, ImageData>();
    const written: string[] = [];
    await postBakeFile(
      `${folder}/preset.json`,
      new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }),
    );

    for (const channel of MATERIAL_TASK_CHANNELS) {
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
    if (proofBlob) await postBakeFile(`${folder}/proof/tileability-2x2.png`, proofBlob);

    // The lit sphere/plane demo needs a real material: build a throwaway textured surface from the same graph
    // (baked through the service) and render it, then dispose its GPU resources.
    const surface = new TexturedSurface(graph, bakeService);
    await surface.refresh();
    const demoBlob = await renderStandardMaterialDemo(surface.material, 512);
    surface.dispose();
    if (demoBlob) await postBakeFile(`${folder}/renders/standard-demo-512.png`, demoBlob);

    console.log(
      `[material-task] wrote bake/${folder}/ — channels: ${written.join(", ") || "(none connected)"}, tileability proof: ${proofBlob ? "yes" : "no"}, demo: ${demoBlob ? "yes" : "no"}`,
    );
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

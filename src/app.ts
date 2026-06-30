import "./style.css";
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import type { CubicBezierApi } from "@tweakpane/plugin-essentials";
import type { ContainerApi } from "@tweakpane/core";
import {
  Boxes,
  GitBranch,
  LayoutGrid,
  Monitor,
  SlidersVertical,
  Sprout,
  Sun,
  SwatchBook,
} from "lucide";
import * as THREE from "three";
import { WebGPURenderer, PMREMGenerator, MeshPhysicalNodeMaterial } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { FolderApi, Pane } from "tweakpane";
import { DEFAULT_MESHER_OPTIONS, MainScene } from "./scene/main";
import { DEFAULT_SUBDIVISIONS } from "./scene/tree";
import {
  DEFAULT_FORM,
  FIELDS,
  decodeForm,
  encodeForm,
  randomForm,
  type TreeForm,
} from "./scene/tree-code";
import type { GraphDocument } from "./scene/graph/document";
import { GraphLine } from "./scene/graph/line";
import type { CubicBezierCurve } from "./scene/graph/curve";
import type { LineModifier } from "./scene/graph/modifiers/modifier";
import { CoilModifier } from "./scene/graph/modifiers/coil";
import { DiscAlignModifier } from "./scene/graph/modifiers/disc-align";
import { FootAlignModifier } from "./scene/graph/modifiers/foot-align";
import { GnarlModifier } from "./scene/graph/modifiers/gnarl";
import { SmoothModifier } from "./scene/graph/modifiers/smooth";
import { TwistModifier } from "./scene/graph/modifiers/twist";
import { addModifierEnvelopeControls } from "./tweak-pane/modifier-envelope";
import {
  StatsBladeApi,
  StatsPanePluginBundle,
} from "./tweak-pane/stats-blade";
import {
  createLayers,
  type LayerType,
  LayersPluginBundle,
} from "./tweak-pane/layers";
import {
  TexturePreviewBladeApi,
  TexturePreviewPluginBundle,
} from "./tweak-pane/texture-preview-blade";
import {
  VerticalTabsApi,
  VerticalTabsPluginBundle,
} from "./tweak-pane/vertical-tabs-blade";
import { NodeEditorPanel } from "./node-editor";
import { buildMaterialEditorConfig } from "./scene/material/editor-config";
import { bakeService } from "./scene/material/graph/bake-service";
import { MaterialGraphController } from "./scene/material/graph/controller";
import { TexturedSurface } from "./scene/material/graph/textured-surface";
import { runTilingTest } from "./scene/material/graph/tiling-test";
import { MATERIAL_PRESETS, makePreset, DEFAULT_PRESET } from "./scene/material/presets";
import { PBR_SOCKETS, type PbrSocket, type MaterialGraphDocument } from "./scene/material/graph/types";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root element");
}

const canvas = app.querySelector<HTMLCanvasElement>(".scene");
const paneHost = app.querySelector<HTMLDivElement>(".pane-host");

if (!canvas || !paneHost) {
  throw new Error("Missing app elements");
}

const sceneCanvas = canvas;
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.z = 4;

// Renderer config (Render tab). `antialias` + `samples` (MSAA) are WebGPU CONSTRUCTOR-only options — the
// device can't change them live — so they're persisted and applied on the next construction (a reload).
// `pixelRatio` and `transparentBg` apply live. `alpha: true` is fixed so the transparent-bg toggle works
// at runtime via setClearAlpha.
interface RendererConfig {
  antialias: boolean;
  samples: number; // MSAA sample count when antialias is on (2 / 4 / 8)
  pixelRatio: number;
  transparentBg: boolean;
}
const RENDERER_CONFIG_KEY = "rendererConfig";
function loadRendererConfig(): RendererConfig {
  const defaults: RendererConfig = {
    antialias: true,
    samples: 4,
    pixelRatio: Math.min(window.devicePixelRatio, 2),
    transparentBg: false,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(RENDERER_CONFIG_KEY) ?? "{}") };
  } catch {
    return defaults;
  }
}
const rendererConfig = loadRendererConfig();
const saveRendererConfig = (): void =>
  localStorage.setItem(RENDERER_CONFIG_KEY, JSON.stringify(rendererConfig));

const renderer = new WebGPURenderer({
  canvas: sceneCanvas,
  antialias: rendererConfig.antialias,
  samples: rendererConfig.antialias ? rendererConfig.samples : 0,
  alpha: true,
});
renderer.setPixelRatio(rendererConfig.pixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping; // default tone mapping (Scene panel can change it live)
// Static (baked-once) tree shadows: VSM for soft edges. The directional light's shadow map is rendered only
// when the tree or sun changes (shadow.autoUpdate=false in MainScene), so there's no per-frame shadow cost —
// it behaves like a baked shadow. See MainScene's directional-light shadow setup + requestShadowBake().
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;

const controls = new OrbitControls(camera, sceneCanvas);
controls.enableDamping = true;

const mainScene = new MainScene();
const rendererSize = new THREE.Vector2();

const pane = new Pane({ container: paneHost, title: "Settings" });
pane.registerPlugin(EssentialsPlugin);
pane.registerPlugin(StatsPanePluginBundle);
pane.registerPlugin(LayersPluginBundle);
pane.registerPlugin(TexturePreviewPluginBundle);
pane.registerPlugin(VerticalTabsPluginBundle);
const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
// Backend label is finalised after renderer.init() at the bottom (WebGPU vs WebGL2 fallback).

// Single source of truth for the tree's form. Every form control binds to this object; the code
// field is just a serialized view of it. `form` <-> `code` round-trips losslessly (tree-code.ts),
// so you can read a code off a tuned tree and paste it back to reproduce that exact tree.
const form: TreeForm = { ...DEFAULT_FORM };
const codeState = { code: encodeForm(form) };
let refreshCode: () => void = () => {};
// Set while a wholesale form replacement refreshes the bound controls, so their change events
// don't each fire a redundant commit (and re-encode) mid-update.
let suppressFormSync = false;

// Snap a binding's range to the codec grid, so dragged/typed values land exactly on values the
// code can represent (no silent quantization surprises).
function formRange(key: keyof TreeForm): { min: number; max: number; step: number } {
  const field = FIELDS.find((spec) => spec.key === key);
  if (!field) {
    throw new Error(`No field spec for form key: ${key}`);
  }
  return { min: field.min, max: field.max, step: field.step };
}

// Push the live form to the scene, refresh the code readout, and rebuild the dependent panels.
function commitForm(): void {
  if (suppressFormSync) {
    return;
  }
  codeState.code = encodeForm(form);
  refreshCode();
  mainScene.setTreeForm(form);
  rebuildScenePanels();
}

// Replace the whole form at once (from a pasted code or the Random button): copy the values in,
// refresh every bound control, then commit a single time.
function applyForm(next: TreeForm): void {
  Object.assign(form, next);
  suppressFormSync = true;
  pane.refresh();
  suppressFormSync = false;
  commitForm();
}

function addFormBinding(container: ContainerApi, key: keyof TreeForm, label: string): void {
  container.addBinding(form, key, { label, ...formRange(key) }).on("change", commitForm);
}

const mainTabs = pane.addBlade({
  view: "verticalTabs",
  stickyTabs: true,
  pages: [
    {
      title: "Gen",
      tooltip: "Generation",
      icon: Sprout,
      color: "#6ee7b7",
    },
    {
      title: "Graph",
      tooltip: "Graph",
      icon: GitBranch,
      color: "#8aa8ff",
    },
    {
      title: "Mesh",
      tooltip: "Mesh",
      icon: Boxes,
      color: "#c084fc",
    },
    {
      title: "Texture",
      tooltip: "Texture",
      icon: SwatchBook,
      color: "#f59e0b",
    },
    {
      title: "Scene",
      tooltip: "Scene (lighting + tone mapping)",
      icon: Sun,
      color: "#fbbf24",
    },
    {
      title: "Render",
      tooltip: "Renderer (antialias, samples, alpha)",
      icon: Monitor,
      color: "#38bdf8",
    },
    {
      title: "Floor",
      tooltip: "Visual floor (independent material)",
      icon: LayoutGrid,
      color: "#a3a3a3",
    },
    {
      title: "Debug",
      tooltip: "Debug",
      icon: SlidersVertical,
      color: "#fb7185",
    },
  ],
}) as VerticalTabsApi;
const [genPage, graphPage, meshPage, texturePage, scenePage, renderPage, floorPage, debugPage] =
  mainTabs.pages;

const graphTabs = graphPage.addTab({
  pages: [
    {
      title: "Layers",
    },
    {
      title: "Joints",
    },
    {
      title: "Roots",
    },
  ],
});
const [graphLayersPage, graphJointsPage, graphRootsPage] = graphTabs.pages;

// The Lines + Joints panels are rebuilt whenever the tree is regenerated (their line/joint
// instances change), so we track the folders they create to dispose them on rebuild.
let scenePanelFolders: Array<{ dispose: () => void }> = [];

// 2D texture-preview state (declared before buildTextureLayers runs, which references it).
type PreviewChannel = "basecolor" | "normal" | "ao" | "roughness";
let texturePreview: TexturePreviewBladeApi | null = null;
const previewState = { channel: "basecolor" as PreviewChannel, seams: false };
// Maps the preview channel UI options to the graph's PBR output socket keys.
const PREVIEW_SOCKET: Record<PreviewChannel, PbrSocket> = {
  basecolor: "baseColor",
  normal: "normal",
  ao: "ambientOcclusion",
  roughness: "roughness",
};
// The preview is re-baked (async, one in-flight) when marked dirty — on channel/scale/backend change
// or a graph recompile — rather than every frame.
let previewDirty = true;
let previewBaking = false;
const markPreviewDirty = (): void => {
  previewDirty = true;
};
mainScene.treeSurface.onRebuilt(markPreviewDirty);
// Material-graph UI state. `worldPerTile` maps to the FBM generator's scale; `backend` toggles the
// live procedural vs convertToTexture baked-map compile.
const triplanarState = { enabled: false, worldPerTile: 1.2, sharpness: 8, parallax: 0 };
const materialState = { backend: "offline" as "live" | "offline", debugNormals: false, preset: DEFAULT_PRESET };

// Visual floor state. The floor has its own material controller (mainScene.floorMaterialController), driven
// only by preset selection — independent of the tree's node graph. The chosen preset persists by key.
const FLOOR_PRESET_KEY = "floorPreset";
const DEFAULT_FLOOR_PRESET = "rock";
// Fall back to the default if the persisted preset key no longer exists (e.g. a removed preset).
const storedFloorPreset = localStorage.getItem(FLOOR_PRESET_KEY);
const floorState = {
  preset: MATERIAL_PRESETS.some((p) => p.key === storedFloorPreset)
    ? (storedFloorPreset as string)
    : DEFAULT_FLOOR_PRESET,
  visible: true,
  tiling: 6,
  // Parallax-occlusion depth for the floor surface. Default 0 = OFF (opt-in: the march is GPU-heavy). Only
  // has an effect when the preset bakes a height map (e.g. rock) and triplanar is off.
  parallax: 0,
};

// Direct configuration of the THREE surface material (the MeshPhysicalNodeMaterial the controller binds to
// the tree), exposed in Texture > Material. These are the renderer-side PBR knobs — distinct from the node
// graph that authors the channel maps. Note: a channel actively driven by the graph (e.g. roughness in the
// bark preset) overrides its scalar here; the physical lobes (clearcoat / sheen / transmission /
// iridescence) and envMapIntensity / flatShading are never graph-driven, so they always take effect.
const surfaceMaterialState = {
  envMapIntensity: 1,
  flatShading: false,
  // Basecolor / roughness / metalness are authored by the node graph and baked into channel maps, which a
  // node material samples instead of the scalar properties. So these three are exposed as FACTORS that
  // multiply the baked channel (glTF roughnessFactor-style) — identity at 1 / white. Routed through the
  // controller's offline factor uniforms, not applySurfaceMaterialState.
  baseColorTint: "#ffffff",
  roughnessFactor: 1,
  metalnessFactor: 1,
  clearcoat: 0,
  clearcoatRoughness: 0.03,
  sheen: 0,
  sheenRoughness: 0.3,
  sheenColor: "#ffffff",
  transmission: 0,
  thickness: 0.5,
  ior: 1.5,
  iridescence: 0,
  iridescenceIOR: 1.3,
};

// Push the state onto the controller's current surface material. The offline material instance is stable
// (so values persist across re-bakes), but the live backend rebuilds a fresh material on recompile — the
// onRecompile hook below re-applies then. `needsUpdate` forces the node material to re-read the scalars.
function applySurfaceMaterialState(): void {
  const m = mainScene.treeSurface.material as MeshPhysicalNodeMaterial;
  const s = surfaceMaterialState;
  m.envMapIntensity = s.envMapIntensity;
  m.flatShading = s.flatShading;
  m.clearcoat = s.clearcoat;
  m.clearcoatRoughness = s.clearcoatRoughness;
  m.sheen = s.sheen;
  m.sheenRoughness = s.sheenRoughness;
  m.sheenColor.set(s.sheenColor);
  m.transmission = s.transmission;
  m.thickness = s.thickness;
  m.ior = s.ior;
  m.iridescence = s.iridescence;
  m.iridescenceIOR = s.iridescenceIOR;
  m.needsUpdate = true;
}

// The live backend swaps in a new material instance on recompile; re-apply the configured state so the
// settings survive a graph/backend change. Offline reuses one stable material, so this is a no-op there.
let lastSurfaceMaterial: unknown = mainScene.treeSurface.material;
mainScene.treeSurface.onRebuilt(() => {
  const m = mainScene.treeSurface.material;
  if (m !== lastSurfaceMaterial) {
    lastSurfaceMaterial = m;
    applySurfaceMaterialState();
  }
});

// Scene tab: tone mapping + lighting. Blender's viewport tone-maps (AgX) by default, so a "None" surface
// looks blown-out vs the baked albedo — exposing these lets the lit look match the texture.
const TONE_MAPPING_MODES: Record<string, THREE.ToneMapping> = {
  None: THREE.NoToneMapping,
  AgX: THREE.AgXToneMapping,
  "ACES Filmic": THREE.ACESFilmicToneMapping,
  Neutral: THREE.NeutralToneMapping,
  Reinhard: THREE.ReinhardToneMapping,
  Cineon: THREE.CineonToneMapping,
};
const sceneState = {
  toneMapping: renderer.toneMapping as THREE.ToneMapping,
  exposure: renderer.toneMappingExposure,
  dirIntensity: mainScene.directionalLight.intensity,
  dirColor: `#${mainScene.directionalLight.color.getHexString()}`,
  dirPosition: { ...mainScene.directionalLight.position },
  ambIntensity: mainScene.ambientLight.intensity,
  ambColor: `#${mainScene.ambientLight.color.getHexString()}`,
  envIntensity: 0.1,
};
// Baked-shadow knobs, seeded from the light's configured shadow (see MainScene.configureShadow).
const shadowState = {
  softness: mainScene.directionalLight.shadow.radius,
  darkness: mainScene.directionalLight.shadow.intensity,
};

buildGenerationControls(genPage);
buildTreeStatsControls(genPage);
buildMeshControls(meshPage);
buildRootControls(graphRootsPage);
buildDebugFolder(debugPage);
buildSceneControls(scenePage);
buildRenderControls(renderPage);
buildFloorControls(floorPage);
applyTransparentBg(rendererConfig.transparentBg); // reflect the persisted choice on startup
buildScenePanels();
// Built once: the mixer persists across tree regeneration and is topology-independent, so its panel
// must NOT be part of the scenePanelFolders rebuild cycle.
// Dockable material node editor (src/node-editor/). Opened from the Texture tab; it pads #app so the
// 3D canvas reflows (resize is the onLayoutChange hook) while the Tweakpane remains scrollable.
const materialEditor = new NodeEditorPanel({ appElement: app });
// (Re)open the editor with a fresh config from the controller's active document. Passed as the rerender
// callback so group enter/exit navigation can swap the displayed subgraph.
const rebuildEditor = (): void =>
  materialEditor.open(buildMaterialEditorConfig(mainScene.materialController, rebuildEditor));
// Same dockable editor, but bound to the FLOOR's separate controller — tuning the floor graph never touches
// the tree (different controller; the floor one doesn't persist). Opened from the Floor tab.
const openFloorEditor = (): void =>
  materialEditor.open(buildMaterialEditorConfig(mainScene.floorMaterialController, openFloorEditor));
buildTextureLayers();

const timer = new THREE.Timer();
timer.connect(document);

function resize(): void {
  const { clientWidth, clientHeight } = sceneCanvas;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
}

function animate(timestamp?: number): void {
  stats.begin();
  timer.update(timestamp);

  renderer.getDrawingBufferSize(rendererSize);
  mainScene.update(timer.getDelta(), camera, rendererSize);
  refreshTexturePreview();
  controls.update();
  // Skip the frame render while a bake is compiling pipelines: `renderer.compileAsync` mutates shared
  // renderer state, so rendering during its await window corrupts the output (black screen / broken
  // geometry). The canvas holds its last frame for the ~sub-second compile; the DOM UI stays responsive.
  if (!bakeService.rendererBusy) renderer.render(mainScene.scene, camera);
  stats.end();
}

// Drive the renderer size off the canvas's own box (a ResizeObserver) rather than the window
// 'resize' event, so it also reacts when the node editor docks/undocks and pads #app (which shrinks
// the canvas) — not just on window resizes.
const sceneResizeObserver = new ResizeObserver(() => resize());
sceneResizeObserver.observe(sceneCanvas);

// WebGPURenderer initialises its backend asynchronously (unlike WebGLRenderer). Wait for it before
// the first render, then drive the loop via setAnimationLoop (the WebGPU-friendly RAF).
await renderer.init();
// Offline baking needs the renderer — hand it to the one shared bake service now that it's initialised,
// then refresh both surfaces so they swap from the live startup fallback to the baked offline material.
bakeService.attachRenderer(renderer);
mainScene.treeSurface.refresh();

// The visual floor: load the chosen floor preset (independent of the tree's graph) and refresh its surface;
// apply visibility/tiling.
mainScene.floorMaterialController.loadDocument(makePreset(floorState.preset));
mainScene.floorSurface.refresh();
mainScene.setFloorVisible(floorState.visible);
mainScene.setFloorTiling(floorState.tiling);

// Shared IBL environment: one RoomEnvironment PMREM cubemap drives image-based lighting for every tree
// (a single shader sample, no per-instance cost), giving soft directional fill + subtle reflections that
// a flat AmbientLight can't. This is the "fill" half of the fake/baked lighting rig (the baked per-vertex
// AO is the occlusion half); there are deliberately NO shadow maps. Built once after init.
try {
  const pmrem = new PMREMGenerator(renderer);
  mainScene.scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
  mainScene.scene.environmentIntensity = sceneState.envIntensity;
  pmrem.dispose();
} catch (err) {
  // If PMREM generation fails on this backend, fall back to the flat ambient (kept low) so the scene
  // still lights — surfaced rather than silently flat.
  console.warn("[env] IBL setup failed; falling back to ambient light only", err);
}
const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
stats.setRenderer(hasWebGPU ? "WebGPU" : "WebGL2");
resize();
renderer.setAnimationLoop(animate);

// Dev-only handles so the app can be driven/inspected from the console (and by automated checks)
// even when the tab is backgrounded and rAF is throttled. Tree-shaken out of production builds.
if (import.meta.env.DEV) {
  Object.assign(window as unknown as Record<string, unknown>, {
    __scene: mainScene,
    __renderer: renderer,
    __camera: camera,
    __controls: controls,
    __editor: materialEditor,
    __openEditor: rebuildEditor,
    __bakeService: bakeService,
    // Back-compat shim for dev-console bake snippets: `__baker.readImageData(_renderer, graph, ch, size)`
    // now routes through the singleton service (the renderer arg is ignored — the service owns it).
    __baker: {
      readImageData: (_r: unknown, graph: MaterialGraphController, ch: PbrSocket, size?: number) =>
        bakeService.readImage(graph, ch, size),
    },
    __savePng: saveChannelToBake,
    __bakeConfig: bakeConfigToBake,
    __bakeMaterialTask: bakeMaterialTask,
    __frame: () => {
      mainScene.update(0, camera, rendererSize);
      renderer.render(mainScene.scene, camera);
    },
    // Tiling test for every Tileable Noise type: bakes each, scores the wrap-edge seam, console.tables a
    // pass/fail summary, and saves a 2×2 composite PNG per type to ./bake (needs `npm run bake:server`).
    // Usage from the dev console: `await __tilingTest()`  (optionally `__tilingTest(256)`).
    __tilingTest: (size?: number) =>
      runTilingTest(bakeService, mainScene.materialController.getRegistry(), {
        size,
        onTile: (type, img) => saveTilingComposite(type, img),
      }).then((rows) => {
        console.table(
          rows.map((r) => ({
            type: r.type,
            pass: r.pass,
            ratioH: Number.isFinite(r.ratioH) ? +r.ratioH.toFixed(2) : "—",
            ratioV: Number.isFinite(r.ratioV) ? +r.ratioV.toFixed(2) : "—",
          })),
        );
        const failed = rows.filter((r) => !r.pass).map((r) => r.type);
        console.log(failed.length ? `[tiling] SEAMS: ${failed.join(", ")}` : "[tiling] all seamless ✓");
        return rows;
      }),
  });
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

// Per-line disc-tube controls: radius (max), tip taper, opacity, visibility, and a cubic-Bézier
// curve that shapes how the radius falls off from the line's start to its tip.
function addLineTubeControls(folder: ContainerApi, line: GraphLine): void {
  const tube = line.tube;

  if (!tube) {
    return;
  }

  const tubeFolder = folder.addFolder({ title: "Tube", expanded: false });
  tubeFolder.addBinding(tube, "visible");
  tubeFolder.addBinding(tube, "radius", { min: 0, max: 1, step: 0.005 });
  // Density is driven globally by Mesh → subdivisions, not per line.
  tubeFolder.addBinding(tube, "tipScale", { label: "tip", min: 0, max: 1, step: 0.01 });
  tubeFolder.addBinding(tube, "opacity", { min: 0, max: 1, step: 0.01 });

  const curveBlade = tubeFolder.addBlade({
    view: "cubicbezier",
    value: tube.curve,
    expanded: false,
    label: "taper",
    picker: "inline",
  }) as CubicBezierApi;

  curveBlade.on("change", (event) => {
    tube.curve = event.value.toObject() as unknown as CubicBezierCurve;
  });
}

function buildModifierControls(folder: ContainerApi, modifier: LineModifier): void {
  // `enabled` is driven by the layer's eye toggle, so only params + envelope here.
  if (modifier instanceof SmoothModifier) {
    folder.addBinding(modifier.params, "mode", {
      options: {
        Laplacian: "laplacian",
        Spline: "spline",
      },
    });
    folder.addBinding(modifier.params, "iterations", {
      min: 1,
      max: 24,
      step: 1,
    });
    folder.addBinding(modifier.params, "segments", {
      min: 1,
      max: 128,
      step: 1,
    });
    folder.addBinding(modifier.params, "strength", {
      min: 0,
      max: 1,
      step: 0.01,
    });
  }

  if (modifier instanceof GnarlModifier) {
    folder.addBinding(modifier.params, "seed", {
      min: 0,
      max: 100000,
      step: 1,
    });
    folder.addBinding(modifier.params, "amount", {
      min: 0,
      max: 2,
      step: 0.01,
    });
    folder.addBinding(modifier.params, "amplitude", {
      min: 0,
      max: 0.75,
      step: 0.01,
    });
    folder.addBinding(modifier.params, "cycles", {
      min: 0.1,
      max: 8,
      step: 0.1,
    });
    folder.addBinding(modifier.params, "lockX", { label: "lock X" });
    folder.addBinding(modifier.params, "lockY", { label: "lock Y" });
    folder.addBinding(modifier.params, "lockZ", { label: "lock Z" });
  }

  if (modifier instanceof TwistModifier) {
    folder.addBinding(modifier.params, "seed", {
      min: 0,
      max: 100000,
      step: 1,
    });
    folder.addBinding(modifier.params, "amount", {
      min: 0,
      max: 2,
      step: 0.01,
    });
    folder.addBinding(modifier.params, "radius", {
      min: 0,
      max: 0.5,
      step: 0.01,
    });
    folder.addBinding(modifier.params, "turns", {
      min: 0,
      max: 8,
      step: 0.1,
    });
  }

  if (modifier instanceof CoilModifier) {
    folder.addBinding(modifier.params, "seed", {
      min: 0,
      max: 100000,
      step: 1,
    });
    folder.addBinding(modifier.params, "amount", {
      min: 0,
      max: 2,
      step: 0.01,
    });
    folder.addBinding(modifier.params, "turns", {
      min: 0,
      max: 8,
      step: 0.1,
    });
    folder.addBinding(modifier.params, "bias", {
      min: 0.25,
      max: 4,
      step: 0.05,
    });
  }

  if (modifier instanceof FootAlignModifier) {
    folder.addBinding(modifier.params, "height", {
      min: 0,
      max: 0.5,
      step: 0.01,
    });
    folder.addBinding(modifier.params, "amount", {
      min: 0,
      max: 1,
      step: 0.01,
    });
  }

  if (modifier instanceof DiscAlignModifier) {
    folder.addBinding(modifier.params, "clearance", {
      readonly: true,
    });
    folder.addBinding(modifier.params, "safety", {
      min: 1,
      max: 3,
      step: 0.05,
    });
    folder.addBinding(modifier.params, "spacing", {
      min: 0,
      max: 0.5,
      step: 0.01,
    });
  }

  addModifierEnvelopeControls(folder, modifier);
}

function modifierTypeName(modifier: LineModifier): string {
  if (modifier instanceof GnarlModifier) {
    return "Gnarl";
  }
  if (modifier instanceof TwistModifier) {
    return "Twist";
  }
  if (modifier instanceof CoilModifier) {
    return "Coil";
  }
  if (modifier instanceof FootAlignModifier) {
    return "Foot Align";
  }
  if (modifier instanceof DiscAlignModifier) {
    return "Disc Align";
  }
  return "Smooth";
}

// Each line's modifiers are themselves a sortable layer list: add/remove modifiers,
// toggle them with the eye (`enabled`), and reorder them to change the modifier stack.
function buildModifierLayers(folder: ContainerApi, line: GraphLine): void {
  const modifierTypes: LayerType<LineModifier>[] = [
    {
      name: "Smooth",
      createState: () => new SmoothModifier(),
      build: (modFolder, layer) => buildModifierControls(modFolder, layer.state),
    },
    {
      name: "Gnarl",
      createState: () => new GnarlModifier(),
      build: (modFolder, layer) => buildModifierControls(modFolder, layer.state),
    },
    {
      name: "Twist",
      createState: () => new TwistModifier(),
      build: (modFolder, layer) => buildModifierControls(modFolder, layer.state),
    },
    {
      name: "Coil",
      createState: () => new CoilModifier(),
      build: (modFolder, layer) => buildModifierControls(modFolder, layer.state),
    },
    {
      name: "Foot Align",
      createState: () => new FootAlignModifier(),
      build: (modFolder, layer) => buildModifierControls(modFolder, layer.state),
    },
    {
      name: "Disc Align",
      createState: () => new DiscAlignModifier(),
      build: (modFolder, layer) => buildModifierControls(modFolder, layer.state),
    },
  ];

  createLayers(folder, {
    title: "Modifiers",
    addLabel: "Add Modifier",
    types: modifierTypes,
    initialLayers: line.modifiers.map((modifier) => ({
      type: modifierTypeName(modifier),
      name: modifier.name,
      state: modifier,
      visible: modifier.enabled,
    })),
    onVisibility: (layer) => {
      (layer.state as LineModifier).enabled = layer.visible;
    },
    onAdd: (layer) => {
      const modifier = layer.state as LineModifier;
      modifier.enabled = layer.visible;
      line.modifiers.push(modifier);
    },
    onRemove: (layer) => {
      line.modifiers = line.modifiers.filter((modifier) => modifier !== layer.state);
    },
    onReorder: (layers) => {
      line.modifiers = layers.map((layer) => layer.state as LineModifier);
    },
  });
}

function buildScenePanels(): void {
  scenePanelFolders = [buildLineLayers(graphLayersPage), ...buildJointsPage(graphJointsPage)];
}

function rebuildScenePanels(): void {
  for (const folder of scenePanelFolders) {
    folder.dispose();
  }
  scenePanelFolders = [];
  buildScenePanels();
}

// The Texture tab drives the node-graph material (src/scene/material/). A single shared HEIGHT field
// feeds the basecolor (gradient map), normal (slope) and AO (cavity) channels. Editing any param
// changes the graph signature, so MainScene's poll re-bakes the affected channels on the GPU. No
// explicit invalidate needed — params feed each node's signature.
// 2D texture preview (top of the Texture tab): drag to pan the tiling texture, wheel to zoom, with a
// channel selector and a seams overlay. Fed from MainScene's animate loop when the material changes.
// State is declared earlier (before buildTextureLayers runs).
function refreshTexturePreview(): void {
  if (!texturePreview || !previewDirty || previewBaking) return;
  previewDirty = false;
  previewBaking = true;
  const socket = PREVIEW_SOCKET[previewState.channel];
  void bakeService
    .readImage(mainScene.materialController, socket, 256)
    .then((image) => {
      if (image) texturePreview?.setImageData(image);
    })
    .catch(() => {
      /* a transient compile/readback failure just leaves the previous preview in place */
    })
    .finally(() => {
      previewBaking = false;
    });
}

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

// A throwaway graph for export baking. Built from a document with NO persistence, so it never touches the
// tree's or floor's live material — this is the whole point of the bake-service split (no more clobber).
function exportGraph(doc: MaterialGraphDocument): MaterialGraphController {
  const graph = new MaterialGraphController(mainScene.materialController.getRegistry(), null);
  graph.loadDocument(doc, { persist: false });
  if (graph.lastError) console.warn(`[bake] config compiled with error: ${graph.lastError}`);
  return graph;
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
  await postBakeFile(`${name}/config.json`, new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));

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
  await postBakeFile(`${folder}/preset.json`, new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));

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

// Apply a tone-mapping mode: set it on the renderer and force every scene material to recompile (the tone
// curve is baked into each node material's output, so a mode change needs a rebuild — exposure is a live
// uniform and doesn't).
function setToneMapping(mode: THREE.ToneMapping): void {
  renderer.toneMapping = mode;
  mainScene.scene.traverse((obj) => {
    const material = (obj as THREE.Mesh).material;
    if (!material) return;
    for (const m of Array.isArray(material) ? material : [material]) m.needsUpdate = true;
  });
}

// Toggle a transparent canvas (the renderer is constructed with alpha:true, so clear-alpha works live).
// Drops the scene's opaque background and clears with alpha 0, so the canvas composites over the page.
function applyTransparentBg(on: boolean): void {
  mainScene.scene.background = on ? null : new THREE.Color(0x111111); // 0x111111 = MainScene default
  renderer.setClearAlpha(on ? 0 : 1);
}

// Render tab: renderer-level config. Pixel ratio + transparent background apply live; antialias and MSAA
// samples are WebGPU construction-time options (the device can't change them on the fly), so they're
// persisted and applied on the next load via the Apply (reload) button.
function buildRenderControls(container: ContainerApi): void {
  const quality = container.addFolder({ title: "Quality", expanded: true });
  quality
    .addBinding(rendererConfig, "pixelRatio", { label: "pixel ratio", min: 0.5, max: 2, step: 0.05 })
    .on("change", (e) => {
      renderer.setPixelRatio(e.value);
      resize();
      saveRendererConfig();
    });
  quality
    .addBinding(rendererConfig, "transparentBg", { label: "transparent bg" })
    .on("change", (e) => {
      applyTransparentBg(e.value);
      saveRendererConfig();
    });

  // MSAA: constructor-only on WebGPU. Edits persist; "Apply (reload)" rebuilds the renderer with them.
  const aa = container.addFolder({ title: "Anti-aliasing", expanded: true });
  aa.addBinding(rendererConfig, "antialias", { label: "MSAA" }).on("change", saveRendererConfig);
  aa.addBinding(rendererConfig, "samples", {
    label: "samples",
    options: { "2×": 2, "4×": 4, "8×": 8 },
  }).on("change", saveRendererConfig);
  aa.addButton({ title: "Apply (reload)" }).on("click", () => {
    saveRendererConfig();
    location.reload();
  });
}

// Floor tab: the visual ground plane's own material (preset-driven, independent of the tree's node graph),
// plus visibility and tiling. Selecting a preset loads it into the floor's separate controller only.
function buildFloorControls(container: ContainerApi): void {
  const folder = container.addFolder({ title: "Floor", expanded: true });
  folder
    .addBinding(floorState, "visible", { label: "visible" })
    .on("change", (e) => mainScene.setFloorVisible(e.value));
  folder
    .addBinding(floorState, "preset", {
      label: "material",
      options: Object.fromEntries(MATERIAL_PRESETS.map((p) => [p.label, p.key])),
    })
    .on("change", (e) => {
      mainScene.floorMaterialController.loadDocument(makePreset(e.value));
      localStorage.setItem(FLOOR_PRESET_KEY, e.value);
    });
  folder
    .addBinding(floorState, "tiling", { label: "tiling", min: 1, max: 24, step: 1 })
    .on("change", (e) => mainScene.setFloorTiling(e.value));
  // Parallax-occlusion depth: shader-side height relief (motion parallax + self-occlusion) over the baked
  // height map. Needs a preset with a Height channel (e.g. rock) and triplanar off; 0 = flat.
  folder
    .addBinding(floorState, "parallax", { label: "parallax", min: 0, max: 0.12, step: 0.005 })
    .on("change", (e) => mainScene.floorSurface.setParallaxScale(e.value));
  // Open the node editor on the FLOOR's own graph (independent of the tree) so it can be tuned in place.
  folder.addButton({ title: "Open Floor Node Editor" }).on("click", () => openFloorEditor());
}

// Scene tab: tone mapping + lighting, one folder per group. Drives the renderer and the lights live.
function buildSceneControls(container: ContainerApi): void {
  const tone = container.addFolder({ title: "Tone Mapping", expanded: true });
  tone
    .addBinding(sceneState, "toneMapping", { label: "mode", options: TONE_MAPPING_MODES })
    .on("change", (e) => setToneMapping(e.value));
  tone
    .addBinding(sceneState, "exposure", { label: "exposure", min: 0, max: 3, step: 0.01 })
    .on("change", (e) => (renderer.toneMappingExposure = e.value));

  const dir = container.addFolder({ title: "Directional Light", expanded: true });
  dir
    .addBinding(sceneState, "dirIntensity", { label: "intensity", min: 0, max: 10, step: 0.1 })
    .on("change", (e) => (mainScene.directionalLight.intensity = e.value));
  dir
    .addBinding(sceneState, "dirColor", { label: "color", view: "color" })
    .on("change", (e) => mainScene.directionalLight.color.set(e.value));
  dir
    .addBinding(sceneState, "dirPosition", { label: "direction" })
    .on("change", (e) => {
      mainScene.directionalLight.position.set(e.value.x, e.value.y, e.value.z);
      mainScene.requestShadowBake(); // sun moved → re-bake the frozen shadow
    });

  // Baked (static) shadow controls. The map renders only on a re-bake (tree regen / sun move), so these are
  // quality knobs, not per-frame cost. Softness is the VSM blur width.
  const shadow = dir.addFolder({ title: "Shadow", expanded: true });
  shadow
    .addBinding(shadowState, "softness", { label: "softness", min: 0, max: 25, step: 0.5 })
    .on("change", (e) => {
      mainScene.directionalLight.shadow.radius = e.value;
      mainScene.requestShadowBake();
    });
  shadow
    .addBinding(shadowState, "darkness", { label: "darkness", min: 0, max: 1, step: 0.01 })
    .on("change", (e) => (mainScene.directionalLight.shadow.intensity = e.value));

  const amb = container.addFolder({ title: "Ambient Light", expanded: true });
  amb
    .addBinding(sceneState, "ambIntensity", { label: "intensity", min: 0, max: 3, step: 0.05 })
    .on("change", (e) => (mainScene.ambientLight.intensity = e.value));
  amb
    .addBinding(sceneState, "ambColor", { label: "color", view: "color" })
    .on("change", (e) => mainScene.ambientLight.color.set(e.value));

  // Image-based lighting fill (the shared RoomEnvironment PMREM set up after renderer.init()).
  const env = container.addFolder({ title: "Environment (IBL)", expanded: true });
  env
    .addBinding(sceneState, "envIntensity", { label: "intensity", min: 0, max: 3, step: 0.05 })
    .on("change", (e) => (mainScene.scene.environmentIntensity = e.value));
}

function buildTextureLayers(): void {
  const previewFolder = texturePage.addFolder({ title: "Preview", expanded: true });
  texturePreview = previewFolder.addBlade({
    view: "texturePreview",
    height: 220,
  }) as TexturePreviewBladeApi;
  previewFolder
    .addBinding(previewState, "channel", {
      options: { Basecolor: "basecolor", Normal: "normal", AO: "ao", Roughness: "roughness" },
    })
    .on("change", () => markPreviewDirty());
  previewFolder
    .addBinding(previewState, "seams")
    .on("change", (event) => texturePreview?.setSeams(event.value));

  // Material graph controls. The backend toggle switches the offline baked-texture surface (default) vs
  // live procedural shading.
  const materialFolder = texturePage.addFolder({ title: "Material", expanded: true });
  materialFolder
    .addBinding(materialState, "backend", { options: { Offline: "offline", Live: "live" } })
    .on("change", (event) => mainScene.treeSurface.setBackend(event.value));
  // Preset graph selector — loads a named starter document (configs are authored here; future presets too).
  materialFolder
    .addBinding(materialState, "preset", {
      label: "preset",
      options: Object.fromEntries(MATERIAL_PRESETS.map((p) => [p.label, p.key])),
    })
    .on("change", (event) => {
      mainScene.materialController.loadDocument(makePreset(event.value));
      // Only refresh the editor if it's already open — changing a preset must not pop it open. It opens
      // solely from the "Open Node Editor" button.
      if (materialEditor.isOpen()) rebuildEditor();
    });
  // Debug: paint the offline surface with its shading normal (geometry + normal map) as RGB — relief
  // visible = the normal map is perturbing the surface.
  materialFolder
    .addBinding(materialState, "debugNormals", { label: "debug normals" })
    .on("change", (event) => mainScene.treeSurface.setNormalDebug(event.value));
  // The dockable node editor (src/node-editor/) shows the live material graph, generated from the
  // registry. Param/toggle edits flow into the controller and recompile the surface.
  materialFolder.addButton({ title: "Open Node Editor" }).on("click", () => rebuildEditor());

  // THREE surface-material properties — the renderer-side PBR config for the selected material. Every
  // control writes straight onto the live MeshPhysicalNodeMaterial via applySurfaceMaterialState.
  const surface = materialFolder.addFolder({ title: "Surface (PBR)", expanded: true });
  const onSurface = (): void => applySurfaceMaterialState();
  surface
    .addBinding(surfaceMaterialState, "envMapIntensity", { label: "env intensity", min: 0, max: 3, step: 0.05 })
    .on("change", onSurface);
  surface.addBinding(surfaceMaterialState, "flatShading", { label: "flat shading" }).on("change", onSurface);
  // Factors multiplied into the baked channels (the scalar props are ignored once the graph drives them).
  surface
    .addBinding(surfaceMaterialState, "baseColorTint", { label: "color tint", view: "color" })
    .on("change", (e) => mainScene.treeSurface.setColorTint(e.value));
  surface
    .addBinding(surfaceMaterialState, "roughnessFactor", { label: "roughness ×", min: 0, max: 2, step: 0.01 })
    .on("change", (e) => mainScene.treeSurface.setRoughnessFactor(e.value));
  surface
    .addBinding(surfaceMaterialState, "metalnessFactor", { label: "metalness ×", min: 0, max: 1, step: 0.01 })
    .on("change", (e) => mainScene.treeSurface.setMetalnessFactor(e.value));

  const coat = surface.addFolder({ title: "Clearcoat", expanded: false });
  coat
    .addBinding(surfaceMaterialState, "clearcoat", { label: "weight", min: 0, max: 1, step: 0.01 })
    .on("change", onSurface);
  coat
    .addBinding(surfaceMaterialState, "clearcoatRoughness", { label: "roughness", min: 0, max: 1, step: 0.01 })
    .on("change", onSurface);

  const sheen = surface.addFolder({ title: "Sheen", expanded: false });
  sheen
    .addBinding(surfaceMaterialState, "sheen", { label: "weight", min: 0, max: 1, step: 0.01 })
    .on("change", onSurface);
  sheen
    .addBinding(surfaceMaterialState, "sheenRoughness", { label: "roughness", min: 0, max: 1, step: 0.01 })
    .on("change", onSurface);
  sheen
    .addBinding(surfaceMaterialState, "sheenColor", { label: "color", view: "color" })
    .on("change", onSurface);

  const trans = surface.addFolder({ title: "Transmission", expanded: false });
  trans
    .addBinding(surfaceMaterialState, "transmission", { label: "weight", min: 0, max: 1, step: 0.01 })
    .on("change", onSurface);
  trans
    .addBinding(surfaceMaterialState, "thickness", { label: "thickness", min: 0, max: 5, step: 0.05 })
    .on("change", onSurface);
  trans
    .addBinding(surfaceMaterialState, "ior", { label: "IOR", min: 1, max: 2.5, step: 0.01 })
    .on("change", onSurface);

  const irid = surface.addFolder({ title: "Iridescence", expanded: false });
  irid
    .addBinding(surfaceMaterialState, "iridescence", { label: "weight", min: 0, max: 1, step: 0.01 })
    .on("change", onSurface);
  irid
    .addBinding(surfaceMaterialState, "iridescenceIOR", { label: "IOR", min: 1, max: 2.5, step: 0.01 })
    .on("change", onSurface);

  // Triplanar projection of the baked maps onto the surface (off → plain UV sampling). Off by default.
  const triplanarFolder = texturePage.addFolder({ title: "Triplanar", expanded: true });
  triplanarFolder
    .addBinding(triplanarState, "enabled", { label: "enabled" })
    .on("change", (event) => mainScene.treeSurface.setTriplanar(event.value));
  triplanarFolder
    .addBinding(triplanarState, "worldPerTile", { label: "world / tile", min: 0.2, max: 6, step: 0.05 })
    .on("change", (event) => mainScene.treeSurface.setScale(event.value));
  triplanarFolder
    .addBinding(triplanarState, "sharpness", { label: "sharpness", min: 1, max: 24, step: 0.5 })
    .on("change", (event) => mainScene.treeSurface.setSharpness(event.value));
  // Parallax-occlusion depth (UV-space path — disable triplanar to see it). Needs a Height channel baked.
  triplanarFolder
    .addBinding(triplanarState, "parallax", { label: "parallax", min: 0, max: 0.12, step: 0.005 })
    .on("change", (event) => mainScene.treeSurface.setParallaxScale(event.value));


  // Export each PBR channel to a PNG (baked from the graph via convertToTexture readback).
  const exportFolder = texturePage.addFolder({ title: "Export PNG", expanded: false });
  for (const channel of ["basecolor", "normal", "ao", "roughness"] as const) {
    exportFolder.addButton({ title: `Export ${channel}` }).on("click", () => {
      void downloadChannelPng(PREVIEW_SOCKET[channel], `material-${channel}.png`);
    });
  }

  // Dev-only: save channels straight into ./bake via the bake server (npm run bake:server).
  if (import.meta.env.DEV) {
    const bakeFolder = texturePage.addFolder({ title: "Bake → ./bake (dev)", expanded: false });
    for (const channel of ["basecolor", "normal", "ao", "roughness"] as const) {
      bakeFolder
        .addButton({ title: `Save ${channel}` })
        .on("click", () => void saveChannelToBake(PREVIEW_SOCKET[channel]));
    }
  }
}

// Generation folder (pinned at the top): the reversible tree code plus the structural knobs that
// feed it. Editing any knob re-encodes the code; editing the code (paste) decodes back into every
// knob. "Random" rolls a fresh code. All of it regenerates the tree and the dependent panels.
function buildGenerationControls(container: ContainerApi): void {
  const folder = container.addFolder({ title: "Generation", expanded: true });

  // The code is editable: typing/pasting a valid code reconfigures the whole tree; an invalid one
  // is rejected and the field snaps back to the current tree's code.
  const codeBinding = folder.addBinding(codeState, "code", { label: "code" });
  refreshCode = () => codeBinding.refresh();
  codeBinding.on("change", (event) => {
    if (suppressFormSync) {
      return;
    }
    const decoded = decodeForm(event.value);
    if (!decoded) {
      codeState.code = encodeForm(form);
      codeBinding.refresh();
      return;
    }
    applyForm(decoded);
  });

  folder.addButton({ title: "Random" }).on("click", () => applyForm(randomForm()));

  addFormBinding(folder, "height", "height");
  addFormBinding(folder, "branchCount", "branches");
  addFormBinding(folder, "branchLevels", "branch levels");
  addFormBinding(folder, "branchL2", "branch L2 fan");
  addFormBinding(folder, "branchL3", "branch L3 fan");
  addFormBinding(folder, "rootLevels", "root levels");
  addFormBinding(folder, "rootL2", "root L2 fan");
  addFormBinding(folder, "rootL3", "root L3 fan");

  // Proportions + per-level lean: shape variations that are still part of the form (and the code),
  // tucked into a collapsed subfolder to keep the top of the panel about topology.
  const shape = folder.addFolder({ title: "Proportions", expanded: false });
  addFormBinding(shape, "trunkRadius", "trunk radius");
  addFormBinding(shape, "radiusScale", "radius scale");
  addFormBinding(shape, "tipScale", "tip scale");
  addFormBinding(shape, "branchLean1", "lean L1 (°)");
  addFormBinding(shape, "branchLean2", "lean L2 (°)");
  addFormBinding(shape, "branchLean3", "lean L3 (°)");

  folder.addButton({ title: "Export JSON" }).on("click", () => downloadDocument(mainScene.getDocument()));
}

// Tree generation readout. Read-only bindings are monitors that poll `meshStats`, so they refresh
// on their own after each (debounced) rebuild.
function buildTreeStatsControls(container: ContainerApi): void {
  const folder = container.addFolder({ title: "Tree", expanded: true });
  folder.addBinding(mainScene.meshStats, "geometryMs", {
    readonly: true,
    label: "Geometry (ms)",
    format: (value) => value.toFixed(1),
  });
  folder.addBinding(mainScene.meshStats, "textureMs", {
    readonly: true,
    label: "Texture (ms)",
    format: (value) => value.toFixed(1),
  });
  folder.addBinding(mainScene.meshStats, "totalMs", {
    readonly: true,
    label: "Total (ms)",
    format: (value) => value.toFixed(1),
  });
  folder.addBinding(mainScene.meshStats, "vertices", {
    readonly: true,
    label: "verts",
    format: (value) => value.toFixed(0),
  });
  folder.addBinding(mainScene.meshStats, "triangles", {
    readonly: true,
    label: "tris",
    format: (value) => value.toFixed(0),
  });
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

// Root form controls. These are part of the form (and therefore the code): editing one rebuilds
// the whole tree graph (count/topology may change) and re-encodes the code.
function buildRootControls(container: ContainerApi): void {
  addFormBinding(container, "rootRadius", "radius");
  addFormBinding(container, "rootHeight", "height");
  addFormBinding(container, "rootSeparation", "separation");
  addFormBinding(container, "rootLSmooth", "L smooth");
  addFormBinding(container, "rootLength", "length");
  addFormBinding(container, "rootDownAngle", "down angle (°)");
  addFormBinding(container, "rootDownCurve", "down curve (°)");
  addFormBinding(container, "maxRoots", "max roots");
}

function buildMeshControls(container: ContainerApi): void {
  buildMeshFolder(container);
}

// Mesh resolution + surface view: the actual geometry the mesher builds.
function buildMeshFolder(container: ContainerApi): void {
  const meshParams = { subdivisions: DEFAULT_SUBDIVISIONS };
  container
    .addBinding(meshParams, "subdivisions", { min: 3, max: 48, step: 1 })
    .on("change", () => {
      mainScene.setSubdivisions(meshParams.subdivisions);
      rebuildScenePanels();
    });

  const mesherParams = {
    radialResolution: DEFAULT_MESHER_OPTIONS.radialResolution,
    smoothIterations: DEFAULT_MESHER_OPTIONS.smoothIterations,
  };
  container
    .addBinding(mesherParams, "radialResolution", { label: "radial res", min: 3, max: 64, step: 1 })
    .on("change", () =>
      mainScene.setMesherOptions({ radialResolution: mesherParams.radialResolution }),
    );
  container
    .addBinding(mesherParams, "smoothIterations", { label: "smooth", min: 0, max: 12, step: 1 })
    .on("change", () =>
      mainScene.setMesherOptions({ smoothIterations: mesherParams.smoothIterations }),
    );

  buildCapControls(container);

  container.addButton({ title: "Rebuild mesh" }).on("click", () => mainScene.rebuildMesh());
}

// Per-group tip-cap shape: length (× tip radius, 0 = flat) and roundness (0 = sharp cone,
// 1 = rounded dome). The full caps object is owned here and re-sent on every edit.
function buildCapControls(parent: ContainerApi): void {
  const caps = structuredClone(DEFAULT_MESHER_OPTIONS.caps);
  const capsFolder = parent.addFolder({ title: "Caps", expanded: false });

  for (const group of ["trunk", "branch", "root"] as const) {
    capsFolder
      .addBinding(caps[group], "length", { label: `${group} length`, min: 0, max: 4, step: 0.05 })
      .on("change", () => mainScene.setMesherOptions({ caps }));
    capsFolder
      .addBinding(caps[group], "roundness", { label: `${group} round`, min: 0, max: 1, step: 0.01 })
      .on("change", () => mainScene.setMesherOptions({ caps }));
  }
}

// Debug instrumentation: overlay visibility + per-point markers, all editing aids.
function buildDebugFolder(container: ContainerApi): void {
  const debugView = {
    surface: true,
    wireframe: false,
    view: "surface" as "surface" | "normals" | "uv",
    graph: false,
    helpers: false,
    discs: false,
    debugT: 0.5,
    debugPoint: true,
    linePoints: false,
  };
  // Surface visibility + wireframe overlay (moved here from the Mesh folder).
  container
    .addBinding(debugView, "surface", { label: "mesh surface" })
    .on("change", (event) => mainScene.mesher.setSurfaceVisible(event.value));
  container
    .addBinding(debugView, "wireframe", { label: "wireframe" })
    .on("change", (event) => mainScene.mesher.setSurfaceWireframe(event.value));
  // Surface view: shaded PBR, view-space normals (normal map in action), or the UV checker.
  container
    .addBinding(debugView, "view", {
      label: "surface view",
      options: { Surface: "surface", Normals: "normals", UV: "uv" },
    })
    .on("change", (event) => mainScene.mesher.setDebugView(event.value));
  // Apply the initial (off) state to the scene — the change handlers only fire on user input, so the
  // graph overlay and reference helpers would otherwise stay visible despite the unchecked boxes.
  mainScene.setGraphVisible(debugView.graph);
  mainScene.setDebugHelpersVisible(debugView.helpers);
  container
    .addBinding(debugView, "graph", { label: "graph" })
    .on("change", (event) => mainScene.setGraphVisible(event.value));
  container
    .addBinding(debugView, "helpers", { label: "helpers" })
    .on("change", (event) => mainScene.setDebugHelpersVisible(event.value));
  container
    .addBinding(debugView, "discs", { label: "show discs" })
    .on("change", (event) => mainScene.setDiscsVisible(event.value));
  container
    .addBinding(debugView, "debugT", { label: "debug T", min: 0, max: 1, step: 0.01 })
    .on("change", (event) => mainScene.setDebugT(event.value));
  container
    .addBinding(debugView, "debugPoint", { label: "debug point" })
    .on("change", (event) => mainScene.setDebugPointVisible(event.value));
  container
    .addBinding(debugView, "linePoints", { label: "line points" })
    .on("change", (event) => mainScene.setDebugLinePointsVisible(event.value));
}

function buildLineLayers(container: ContainerApi): { dispose: () => void } {
  // Each graph line is a layer; selecting one reveals its properties + modifier layers.
  const lineType: LayerType<GraphLine> = {
    name: "Line",
    createState: () =>
      mainScene.graph.addLine({
        color: 0x9ad1ff,
        points: [
          new THREE.Vector3(-0.5, 0, 0),
          new THREE.Vector3(0.5, 0, 0),
        ],
      }),
    build: (folder, layer) => {
      const line = layer.state;
      folder.addBinding(line, "pointCount", { readonly: true });
      folder.addBinding(line, "thickness", { min: 1, max: 10, step: 1 });
      addLineTubeControls(folder, line);
      buildModifierLayers(folder, line);
    },
  };

  return createLayers(container, {
    title: "Lines",
    addLabel: "Add Line",
    wrap: false,
    types: [lineType],
    initialLayers: mainScene.graph.getLineEntries().map(({ id, line }) => ({
      type: "Line",
      id,
      name: id,
      state: line,
      visible: line.object.visible,
    })),
    onSelect: (layer) => {
      if (layer) {
        mainScene.selectedLineId = layer.id;
      }
    },
    onVisibility: (layer) => {
      (layer.state as GraphLine).object.visible = layer.visible;
    },
    onRemove: (layer) => {
      mainScene.graph.removeLine(layer.state as GraphLine);
    },
  });
}

function buildJointsPage(container: ContainerApi): FolderApi[] {
  const folders: FolderApi[] = [];

  for (const { document, joint } of mainScene.graph.getJointEntries()) {
    // Collapsed by default; populate the bindings only the first time the folder is expanded,
    // so opening the Joints tab doesn't build controls for every joint at once.
    const folder = container.addFolder({ title: document.id, expanded: false });
    folders.push(folder);
    let built = false;

    folder.on("fold", (event) => {
      if (built || !event.expanded) {
        return;
      }
      built = true;

      const jointView = {
        id: document.id,
        parent: `${document.parentLineId} @ ${document.parentT.toFixed(2)}`,
        child: `${document.childLineId}[${document.childPointIndex}]`,
      };

      folder.addBinding(jointView, "id", { readonly: true });
      folder.addBinding(jointView, "parent", { readonly: true });
      folder.addBinding(jointView, "child", { readonly: true });
      folder.addBinding(joint, "maxLeanAngle", {
        label: "Max lean (°)",
        min: 0,
        max: 90,
        step: 1,
      });
      folder.addBinding(joint, "directionPoints", {
        label: "Direction points",
        min: 1,
        max: 16,
        step: 1,
      });
      folder.addBinding(joint, "collarT", { label: "collar", readonly: true });
    });
  }

  return folders;
}

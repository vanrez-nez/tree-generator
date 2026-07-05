import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import type { CubicBezierApi } from "@tweakpane/plugin-essentials";
import type { ContainerApi } from "@tweakpane/core";
import { Boxes, GitBranch, LayoutGrid, Monitor, SlidersVertical, Sprout, Sun } from "lucide";
import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { FolderApi, Pane } from "tweakpane";
import { DEFAULT_MESHER_OPTIONS, MainScene } from "../scene/main";
import { DEFAULT_SUBDIVISIONS } from "../scene/tree";
import {
  DEFAULT_FORM,
  FIELDS,
  decodeForm,
  encodeForm,
  randomForm,
  type TreeForm,
} from "../scene/tree-code";
import { GraphLine } from "../scene/graph/line";
import type { CubicBezierCurve } from "../scene/graph/curve";
import type { LineModifier } from "../scene/graph/modifiers/modifier";
import { CoilModifier } from "../scene/graph/modifiers/coil";
import { DiscAlignModifier } from "../scene/graph/modifiers/disc-align";
import { FootAlignModifier } from "../scene/graph/modifiers/foot-align";
import { GnarlModifier } from "../scene/graph/modifiers/gnarl";
import { SmoothModifier } from "../scene/graph/modifiers/smooth";
import { TwistModifier } from "../scene/graph/modifiers/twist";
import { addModifierEnvelopeControls } from "../tweak-pane/modifier-envelope";
import { StatsBladeApi, StatsPanePluginBundle } from "../tweak-pane/stats-blade";
import { createLayers, type LayerType, LayersPluginBundle } from "../tweak-pane/layers";
import { VerticalTabsApi, VerticalTabsPluginBundle } from "../tweak-pane/vertical-tabs-blade";

export interface RendererConfig {
  antialias: boolean;
  samples: number;
  pixelRatio: number;
  transparentBg: boolean;
}

const RENDERER_CONFIG_KEY = "rendererConfig";

export function loadRendererConfig(): RendererConfig {
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

export interface TweakpaneDeps {
  paneHost: HTMLDivElement;
  renderer: WebGPURenderer;
  mainScene: MainScene;
  rendererConfig: RendererConfig;
  resize: () => void;
}

export interface TweakpaneHandles {
  stats: StatsBladeApi;
  initFloor: () => void;
}

function formRange(key: keyof TreeForm): { min: number; max: number; step: number } {
  const field = FIELDS.find((spec) => spec.key === key);
  if (!field) throw new Error(`No field spec for form key: ${key}`);
  return { min: field.min, max: field.max, step: field.step };
}

function downloadJson(filename: string, data: unknown): void {
  downloadText(filename, JSON.stringify(data, null, 2), "application/json");
}

function downloadText(filename: string, text: string, type = "text/plain"): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function addLineTubeControls(folder: ContainerApi, line: GraphLine): void {
  const tube = line.tube;
  if (!tube) return;

  const tubeFolder = folder.addFolder({ title: "Tube", expanded: false });
  tubeFolder.addBinding(tube, "visible");
  tubeFolder.addBinding(tube, "radius", { min: 0, max: 1, step: 0.005 });
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
  if (modifier instanceof SmoothModifier) {
    folder.addBinding(modifier.params, "mode", { options: { Laplacian: "laplacian", Spline: "spline" } });
    folder.addBinding(modifier.params, "iterations", { min: 1, max: 24, step: 1 });
    folder.addBinding(modifier.params, "segments", { min: 1, max: 128, step: 1 });
    folder.addBinding(modifier.params, "strength", { min: 0, max: 1, step: 0.01 });
  }

  if (modifier instanceof GnarlModifier) {
    folder.addBinding(modifier.params, "seed", { min: 0, max: 100000, step: 1 });
    folder.addBinding(modifier.params, "amount", { min: 0, max: 2, step: 0.01 });
    folder.addBinding(modifier.params, "amplitude", { min: 0, max: 0.75, step: 0.01 });
    folder.addBinding(modifier.params, "cycles", { min: 0.1, max: 8, step: 0.1 });
    folder.addBinding(modifier.params, "lockX", { label: "lock X" });
    folder.addBinding(modifier.params, "lockY", { label: "lock Y" });
    folder.addBinding(modifier.params, "lockZ", { label: "lock Z" });
  }

  if (modifier instanceof TwistModifier) {
    folder.addBinding(modifier.params, "seed", { min: 0, max: 100000, step: 1 });
    folder.addBinding(modifier.params, "amount", { min: 0, max: 2, step: 0.01 });
    folder.addBinding(modifier.params, "radius", { min: 0, max: 0.5, step: 0.01 });
    folder.addBinding(modifier.params, "turns", { min: 0, max: 8, step: 0.1 });
  }

  if (modifier instanceof CoilModifier) {
    folder.addBinding(modifier.params, "seed", { min: 0, max: 100000, step: 1 });
    folder.addBinding(modifier.params, "amount", { min: 0, max: 2, step: 0.01 });
    folder.addBinding(modifier.params, "turns", { min: 0, max: 8, step: 0.1 });
    folder.addBinding(modifier.params, "bias", { min: 0.25, max: 4, step: 0.05 });
  }

  if (modifier instanceof FootAlignModifier) {
    folder.addBinding(modifier.params, "height", { min: 0, max: 0.5, step: 0.01 });
    folder.addBinding(modifier.params, "amount", { min: 0, max: 1, step: 0.01 });
  }

  if (modifier instanceof DiscAlignModifier) {
    folder.addBinding(modifier.params, "clearance", { readonly: true });
    folder.addBinding(modifier.params, "safety", { min: 1, max: 3, step: 0.05 });
    folder.addBinding(modifier.params, "spacing", { min: 0, max: 0.5, step: 0.01 });
  }

  addModifierEnvelopeControls(folder, modifier);
}

function modifierTypeName(modifier: LineModifier): string {
  if (modifier instanceof GnarlModifier) return "Gnarl";
  if (modifier instanceof TwistModifier) return "Twist";
  if (modifier instanceof CoilModifier) return "Coil";
  if (modifier instanceof FootAlignModifier) return "Foot Align";
  if (modifier instanceof DiscAlignModifier) return "Disc Align";
  return "Smooth";
}

function buildModifierLayers(folder: ContainerApi, line: GraphLine): void {
  const modifierTypes: LayerType<LineModifier>[] = [
    { name: "Smooth", createState: () => new SmoothModifier(), build: (modFolder, layer) => buildModifierControls(modFolder, layer.state) },
    { name: "Gnarl", createState: () => new GnarlModifier(), build: (modFolder, layer) => buildModifierControls(modFolder, layer.state) },
    { name: "Twist", createState: () => new TwistModifier(), build: (modFolder, layer) => buildModifierControls(modFolder, layer.state) },
    { name: "Coil", createState: () => new CoilModifier(), build: (modFolder, layer) => buildModifierControls(modFolder, layer.state) },
    { name: "Foot Align", createState: () => new FootAlignModifier(), build: (modFolder, layer) => buildModifierControls(modFolder, layer.state) },
    { name: "Disc Align", createState: () => new DiscAlignModifier(), build: (modFolder, layer) => buildModifierControls(modFolder, layer.state) },
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

export function setupTweakpane({
  paneHost,
  renderer,
  mainScene,
  rendererConfig,
  resize,
}: TweakpaneDeps): TweakpaneHandles {
  const saveRendererConfig = (): void =>
    localStorage.setItem(RENDERER_CONFIG_KEY, JSON.stringify(rendererConfig));

  const pane = new Pane({ container: paneHost, title: "Settings" });
  pane.registerPlugin(EssentialsPlugin);
  pane.registerPlugin(StatsPanePluginBundle);
  pane.registerPlugin(LayersPluginBundle);
  pane.registerPlugin(VerticalTabsPluginBundle);
  const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;

  const form: TreeForm = { ...DEFAULT_FORM };
  const codeState = { code: encodeForm(form) };
  let refreshCode: () => void = () => {};
  let suppressFormSync = false;

  function commitForm(): void {
    if (suppressFormSync) return;
    codeState.code = encodeForm(form);
    refreshCode();
    mainScene.setTreeForm(form);
    rebuildScenePanels();
  }

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
      { title: "Gen", tooltip: "Generation", icon: Sprout, color: "#6ee7b7" },
      { title: "Graph", tooltip: "Graph", icon: GitBranch, color: "#8aa8ff" },
      { title: "Mesh", tooltip: "Mesh", icon: Boxes, color: "#c084fc" },
      { title: "Scene", tooltip: "Scene", icon: Sun, color: "#fbbf24" },
      { title: "Render", tooltip: "Renderer", icon: Monitor, color: "#38bdf8" },
      { title: "Floor", tooltip: "Visual floor", icon: LayoutGrid, color: "#a3a3a3" },
      { title: "Debug", tooltip: "Debug", icon: SlidersVertical, color: "#fb7185" },
    ],
  }) as VerticalTabsApi;
  const [genPage, graphPage, meshPage, scenePage, renderPage, floorPage, debugPage] = mainTabs.pages;

  const graphTabs = graphPage.addTab({
    pages: [{ title: "Layers" }, { title: "Joints" }, { title: "Roots" }],
  });
  const [graphLayersPage, graphJointsPage, graphRootsPage] = graphTabs.pages;
  let scenePanelFolders: Array<{ dispose: () => void }> = [];

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
  const shadowState = {
    softness: mainScene.directionalLight.shadow.radius,
    darkness: mainScene.directionalLight.shadow.intensity,
  };
  const floorState = {
    visible: true,
    tiling: 6,
    collar: true,
  };
  // Root-collar shaping params (mirrors RootCollar DEFAULTS). Live-editable; sweep to find good values.
  const collarState = {
    centerHeight: 0.12,
    slope: 1.5,
    disturbance: 0.04,
    disturbanceScale: 1.6,
    floorBlend: 0.5,
    rootRaise: 0.12,
    rootEdgeBlend: 0.12,
    rootEdgeAO: 0.5,
    rootEdgeMix: 0.5,
  };

  function setToneMapping(mode: THREE.ToneMapping): void {
    renderer.toneMapping = mode;
    mainScene.scene.traverse((obj) => {
      const material = (obj as THREE.Mesh).material;
      if (!material) return;
      for (const m of Array.isArray(material) ? material : [material]) m.needsUpdate = true;
    });
  }

  function applyTransparentBg(on: boolean): void {
    mainScene.scene.background = on ? null : new THREE.Color(0x111111);
    renderer.setClearAlpha(on ? 0 : 1);
  }

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

    const aa = container.addFolder({ title: "Anti-aliasing", expanded: true });
    aa.addBinding(rendererConfig, "antialias", { label: "MSAA" }).on("change", saveRendererConfig);
    aa.addBinding(rendererConfig, "samples", {
      label: "samples",
      options: { "2x": 2, "4x": 4, "8x": 8 },
    }).on("change", saveRendererConfig);
    aa.addButton({ title: "Apply (reload)" }).on("click", () => {
      saveRendererConfig();
      location.reload();
    });
  }

  function buildFloorControls(container: ContainerApi): void {
    const folder = container.addFolder({ title: "Floor", expanded: true });
    folder
      .addBinding(floorState, "visible", { label: "visible" })
      .on("change", (e) => mainScene.setFloorVisible(e.value));
    folder
      .addBinding(floorState, "tiling", { label: "tiling", min: 1, max: 24, step: 1 })
      .on("change", (e) => mainScene.setFloorTiling(e.value));
    folder
      .addBinding(floorState, "collar", { label: "root collar" })
      .on("change", (e) => mainScene.setCollarVisible(e.value));

    // Root-collar shaping. Each slider triggers a cheap collar-only rebuild (the tree is untouched).
    const collar = folder.addFolder({ title: "Root Collar", expanded: true });
    const bind = (
      key: keyof typeof collarState,
      label: string,
      min: number,
      max: number,
      step: number,
    ): void => {
      collar
        .addBinding(collarState, key, { label, min, max, step })
        .on("change", (e) => mainScene.setCollarOptions({ [key]: e.value }));
    };
    bind("centerHeight", "center height", 0, 0.5, 0.005);
    bind("slope", "slope", 0.3, 4, 0.05);
    bind("disturbance", "disturbance", 0, 0.15, 0.005);
    bind("disturbanceScale", "disturb scale", 0.3, 5, 0.1);
    bind("floorBlend", "floor blend", 0.05, 1.5, 0.05);
    bind("rootRaise", "root raise", 0, 0.3, 0.005);
    bind("rootEdgeBlend", "root edge", 0.02, 0.4, 0.01);
    bind("rootEdgeAO", "root AO", 0, 1, 0.05);
    bind("rootEdgeMix", "root bark mix", 0, 1, 0.05);
  }

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
        mainScene.requestShadowBake();
      });

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

    const env = container.addFolder({ title: "Environment (IBL)", expanded: true });
    env
      .addBinding(sceneState, "envIntensity", { label: "intensity", min: 0, max: 3, step: 0.05 })
      .on("change", (e) => (mainScene.scene.environmentIntensity = e.value));
  }

  function buildGenerationControls(container: ContainerApi): void {
    const folder = container.addFolder({ title: "Generation", expanded: true });
    const codeBinding = folder.addBinding(codeState, "code", { label: "code" });
    refreshCode = () => codeBinding.refresh();
    codeBinding.on("change", (event) => {
      if (suppressFormSync) return;
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

    const shape = folder.addFolder({ title: "Proportions", expanded: false });
    addFormBinding(shape, "trunkRadius", "trunk radius");
    addFormBinding(shape, "radiusScale", "radius scale");
    addFormBinding(shape, "tipScale", "tip scale");
    addFormBinding(shape, "branchLean1", "lean L1");
    addFormBinding(shape, "branchLean2", "lean L2");
    addFormBinding(shape, "branchLean3", "lean L3");

    folder.addButton({ title: "Export JSON" }).on("click", () => downloadJson("tree.json", mainScene.getDocument()));
    folder.addButton({ title: "Export OBJ" }).on("click", () => downloadText("tree.obj", mainScene.mesher.toObj()));
  }

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

  function buildRootControls(container: ContainerApi): void {
    addFormBinding(container, "rootRadius", "radius");
    addFormBinding(container, "rootHeight", "height");
    addFormBinding(container, "rootSeparation", "separation");
    addFormBinding(container, "rootLSmooth", "L smooth");
    addFormBinding(container, "rootLength", "length");
    addFormBinding(container, "rootDownAngle", "down angle");
    addFormBinding(container, "rootDownCurve", "down curve");
    addFormBinding(container, "maxRoots", "max roots");
  }

  function buildMeshControls(container: ContainerApi): void {
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
      .on("change", () => mainScene.setMesherOptions({ radialResolution: mesherParams.radialResolution }));
    container
      .addBinding(mesherParams, "smoothIterations", { label: "smooth", min: 0, max: 12, step: 1 })
      .on("change", () => mainScene.setMesherOptions({ smoothIterations: mesherParams.smoothIterations }));

    const caps = structuredClone(DEFAULT_MESHER_OPTIONS.caps);
    const capsFolder = container.addFolder({ title: "Caps", expanded: false });
    for (const group of ["trunk", "branch", "root"] as const) {
      capsFolder
        .addBinding(caps[group], "length", { label: `${group} length`, min: 0, max: 4, step: 0.05 })
        .on("change", () => mainScene.setMesherOptions({ caps }));
      capsFolder
        .addBinding(caps[group], "roundness", { label: `${group} round`, min: 0, max: 1, step: 0.01 })
        .on("change", () => mainScene.setMesherOptions({ caps }));
    }

    container.addButton({ title: "Rebuild mesh" }).on("click", () => mainScene.rebuildMesh());
  }

  function buildDebugControls(container: ContainerApi): void {
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
    container
      .addBinding(debugView, "surface", { label: "mesh surface" })
      .on("change", (event) => mainScene.mesher.setSurfaceVisible(event.value));
    container
      .addBinding(debugView, "wireframe", { label: "wireframe" })
      .on("change", (event) => {
        mainScene.mesher.setSurfaceWireframe(event.value);
        mainScene.setCollarWireframe(event.value);
      });
    container
      .addBinding(debugView, "view", {
        label: "surface view",
        options: { Surface: "surface", Normals: "normals", UV: "uv" },
      })
      .on("change", (event) => mainScene.mesher.setDebugView(event.value));

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
    const lineType: LayerType<GraphLine> = {
      name: "Line",
      createState: () =>
        mainScene.graph.addLine({
          color: 0x9ad1ff,
          points: [new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 0, 0)],
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
        if (layer) mainScene.selectedLineId = layer.id;
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
      const folder = container.addFolder({ title: document.id, expanded: false });
      folders.push(folder);
      let built = false;

      folder.on("fold", (event) => {
        if (built || !event.expanded) return;
        built = true;
        const jointView = {
          id: document.id,
          parent: `${document.parentLineId} @ ${document.parentT.toFixed(2)}`,
          child: `${document.childLineId}[${document.childPointIndex}]`,
        };

        folder.addBinding(jointView, "id", { readonly: true });
        folder.addBinding(jointView, "parent", { readonly: true });
        folder.addBinding(jointView, "child", { readonly: true });
        folder.addBinding(joint, "maxLeanAngle", { label: "Max lean", min: 0, max: 90, step: 1 });
        folder.addBinding(joint, "directionPoints", { label: "Direction points", min: 1, max: 16, step: 1 });
        folder.addBinding(joint, "collarT", { label: "collar", readonly: true });
      });
    }
    return folders;
  }

  function buildScenePanels(): void {
    scenePanelFolders = [buildLineLayers(graphLayersPage), ...buildJointsPage(graphJointsPage)];
  }

  function rebuildScenePanels(): void {
    for (const folder of scenePanelFolders) folder.dispose();
    scenePanelFolders = [];
    buildScenePanels();
  }

  function initFloor(): void {
    mainScene.setFloorVisible(floorState.visible);
    mainScene.setFloorTiling(floorState.tiling);
    mainScene.setCollarVisible(floorState.collar);
  }

  buildGenerationControls(genPage);
  buildTreeStatsControls(genPage);
  buildMeshControls(meshPage);
  buildRootControls(graphRootsPage);
  buildDebugControls(debugPage);
  buildSceneControls(scenePage);
  buildRenderControls(renderPage);
  buildFloorControls(floorPage);
  applyTransparentBg(rendererConfig.transparentBg);
  buildScenePanels();

  return { stats, initFloor };
}

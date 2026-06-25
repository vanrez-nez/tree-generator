import "./style.css";
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import type { CubicBezierApi } from "@tweakpane/plugin-essentials";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
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
import type { TextureLayer } from "./scene/texturer/layer";
import { ImageLayer } from "./scene/texturer/layers/image";
import { SAMPLE_TEXTURES } from "./scene/texturer/document";

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

const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const controls = new OrbitControls(camera, sceneCanvas);
controls.enableDamping = true;

const mainScene = new MainScene();
const rendererSize = new THREE.Vector2();

const pane = new Pane({ container: paneHost, title: "Settings" });
pane.registerPlugin(EssentialsPlugin);
pane.registerPlugin(StatsPanePluginBundle);
pane.registerPlugin(LayersPluginBundle);
const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
stats.setRenderer(renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL");

// Tree generation readout, pinned at the top under the FPS blade. Read-only bindings are monitors
// that poll `meshStats`, so they refresh on their own after each (debounced) rebuild.
const treeInfo = pane.addFolder({ title: "Tree", expanded: true });
treeInfo.addBinding(mainScene.meshStats, "generationMs", {
  readonly: true,
  label: "gen (ms)",
  format: (value) => value.toFixed(1),
});
treeInfo.addBinding(mainScene.meshStats, "vertices", {
  readonly: true,
  label: "verts",
  format: (value) => value.toFixed(0),
});
treeInfo.addBinding(mainScene.meshStats, "triangles", {
  readonly: true,
  label: "tris",
  format: (value) => value.toFixed(0),
});

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

function addFormBinding(folder: FolderApi, key: keyof TreeForm, label: string): void {
  folder.addBinding(form, key, { label, ...formRange(key) }).on("change", commitForm);
}

buildGenerationControls();

const tab = pane.addTab({
  pages: [{ title: "Line" }, { title: "Joints" }, { title: "Texture" }],
});
const [linePage, jointsPage, texturePage] = tab.pages;

// The Lines + Joints panels are rebuilt whenever the tree is regenerated (their line/joint
// instances change), so we track the folders they create to dispose them on rebuild.
let scenePanelFolders: FolderApi[] = [];

buildMeshControls();
buildRootControls();
buildScenePanels();
// Built once: the mixer persists across tree regeneration and is topology-independent, so its panel
// must NOT be part of the scenePanelFolders rebuild cycle.
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
  controls.update();
  renderer.render(mainScene.scene, camera);
  stats.end();
  requestAnimationFrame(animate);
}

window.addEventListener("resize", resize);
resize();
animate();

// Per-line disc-tube controls: radius (max), tip taper, opacity, visibility, and a cubic-Bézier
// curve that shapes how the radius falls off from the line's start to its tip.
function addLineTubeControls(folder: FolderApi, line: GraphLine): void {
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

function buildModifierControls(folder: FolderApi, modifier: LineModifier): void {
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
function buildModifierLayers(folder: FolderApi, line: GraphLine): void {
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
  scenePanelFolders = [buildLineLayers(), ...buildJointsPage()];
}

function rebuildScenePanels(): void {
  for (const folder of scenePanelFolders) {
    folder.dispose();
  }
  scenePanelFolders = [];
  buildScenePanels();
}

// The Texture tab: a layers panel over the texture mixer, mirroring buildModifierLayers. Each layer
// is a configurable step composited in stack order; the eye toggles it, drag reorders. Every edit
// invalidates the mixer so MainScene's poll repaints the surface texture.
function buildTextureLayers(): void {
  const imageType: LayerType<ImageLayer> = {
    name: "Image",
    createState: () => new ImageLayer(),
    build: (folder, layer) => buildImageLayerControls(folder, layer.state),
  };

  createLayers(texturePage, {
    title: "Layers",
    addLabel: "Add Layer",
    types: [imageType],
    initialLayers: mainScene.mixer.getLayerEntries().map(({ layer }) => ({
      type: "Image",
      name: layer.name,
      state: layer,
      visible: layer.enabled,
    })),
    onVisibility: (layer) => {
      (layer.state as TextureLayer).enabled = layer.visible;
      mainScene.mixer.invalidate();
    },
    onAdd: (layer) => {
      const textureLayer = layer.state as TextureLayer;
      textureLayer.enabled = layer.visible;
      mainScene.mixer.addLayer(textureLayer);
    },
    onRemove: (layer) => {
      mainScene.mixer.removeLayer(layer.state as TextureLayer);
    },
    onReorder: (layers) => {
      mainScene.mixer.reorderLayers(layers.map((layer) => layer.state as TextureLayer));
    },
  });
}

// Per-Image-layer controls. Every binding invalidates the mixer so the surface texture repaints.
function buildImageLayerControls(folder: FolderApi, layer: ImageLayer): void {
  const invalidate = (): void => mainScene.mixer.invalidate();
  const srcOptions = Object.fromEntries(SAMPLE_TEXTURES.map((sample) => [sample.label, sample.path]));

  folder.addBinding(layer.params, "src", { label: "image", options: srcOptions }).on("change", invalidate);
  folder.addBinding(layer.params, "opacity", { min: 0, max: 1, step: 0.01 }).on("change", invalidate);
  folder
    .addBinding(layer.params, "blend", {
      options: {
        Normal: "source-over",
        Multiply: "multiply",
        Screen: "screen",
        Overlay: "overlay",
        Darken: "darken",
        Lighten: "lighten",
      },
    })
    .on("change", invalidate);
  folder
    .addBinding(layer.params, "fit", { options: { Stretch: "stretch", Tile: "tile" } })
    .on("change", invalidate);
  folder.addBinding(layer.params, "scale", { min: 0.1, max: 8, step: 0.05 }).on("change", invalidate);
  folder.addBinding(layer.params, "offsetX", { label: "offset X", min: 0, max: 1, step: 0.01 }).on("change", invalidate);
  folder.addBinding(layer.params, "offsetY", { label: "offset Y", min: 0, max: 1, step: 0.01 }).on("change", invalidate);
}

// Generation folder (pinned at the top): the reversible tree code plus the structural knobs that
// feed it. Editing any knob re-encodes the code; editing the code (paste) decodes back into every
// knob. "Random" rolls a fresh code. All of it regenerates the tree and the dependent panels.
function buildGenerationControls(): void {
  const folder = pane.addFolder({ title: "Generation", expanded: true });

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
function buildRootControls(): void {
  const folder = pane.addFolder({ title: "Roots" });
  addFormBinding(folder, "rootRadius", "radius");
  addFormBinding(folder, "rootHeight", "height");
  addFormBinding(folder, "rootSeparation", "separation");
  addFormBinding(folder, "rootLSmooth", "L smooth");
  addFormBinding(folder, "rootLength", "length");
  addFormBinding(folder, "rootDownAngle", "down angle (°)");
  addFormBinding(folder, "rootDownCurve", "down curve (°)");
  addFormBinding(folder, "maxRoots", "max roots");
}

function buildMeshControls(): void {
  buildMeshFolder();
  buildDebugFolder();
}

// Mesh resolution + surface view: the actual geometry the mesher builds.
function buildMeshFolder(): void {
  const folder = pane.addFolder({ title: "Mesh" });

  const meshParams = { subdivisions: DEFAULT_SUBDIVISIONS };
  folder
    .addBinding(meshParams, "subdivisions", { min: 3, max: 48, step: 1 })
    .on("change", () => {
      mainScene.setSubdivisions(meshParams.subdivisions);
      rebuildScenePanels();
    });

  const mesherParams = {
    radialResolution: DEFAULT_MESHER_OPTIONS.radialResolution,
    smoothIterations: DEFAULT_MESHER_OPTIONS.smoothIterations,
  };
  folder
    .addBinding(mesherParams, "radialResolution", { label: "radial res", min: 3, max: 64, step: 1 })
    .on("change", () =>
      mainScene.setMesherOptions({ radialResolution: mesherParams.radialResolution }),
    );
  folder
    .addBinding(mesherParams, "smoothIterations", { label: "smooth", min: 0, max: 12, step: 1 })
    .on("change", () =>
      mainScene.setMesherOptions({ smoothIterations: mesherParams.smoothIterations }),
    );

  const view = { surface: true, wireframe: false };
  folder
    .addBinding(view, "surface", { label: "mesh surface" })
    .on("change", (event) => mainScene.mesher.setSurfaceVisible(event.value));
  folder
    .addBinding(view, "wireframe", { label: "wireframe" })
    .on("change", (event) => mainScene.mesher.setSurfaceWireframe(event.value));

  buildCapControls(folder);

  folder.addButton({ title: "Rebuild mesh" }).on("click", () => mainScene.rebuildMesh());
}

// Per-group tip-cap shape: length (× tip radius, 0 = flat) and roundness (0 = sharp cone,
// 1 = rounded dome). The full caps object is owned here and re-sent on every edit.
function buildCapControls(parent: FolderApi): void {
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
function buildDebugFolder(): void {
  const folder = pane.addFolder({ title: "Debug" });

  const debugView = {
    graph: true,
    helpers: true,
    discs: false,
    debugT: 0.5,
    debugPoint: true,
    linePoints: false,
  };
  folder
    .addBinding(debugView, "graph", { label: "graph" })
    .on("change", (event) => mainScene.setGraphVisible(event.value));
  folder
    .addBinding(debugView, "helpers", { label: "helpers" })
    .on("change", (event) => mainScene.setDebugHelpersVisible(event.value));
  folder
    .addBinding(debugView, "discs", { label: "show discs" })
    .on("change", (event) => mainScene.setDiscsVisible(event.value));
  folder
    .addBinding(debugView, "debugT", { label: "debug T", min: 0, max: 1, step: 0.01 })
    .on("change", (event) => mainScene.setDebugT(event.value));
  folder
    .addBinding(debugView, "debugPoint", { label: "debug point" })
    .on("change", (event) => mainScene.setDebugPointVisible(event.value));
  folder
    .addBinding(debugView, "linePoints", { label: "line points" })
    .on("change", (event) => mainScene.setDebugLinePointsVisible(event.value));
}

function buildLineLayers(): FolderApi {
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

  return createLayers(linePage, {
    title: "Lines",
    addLabel: "Add Line",
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
  }).folder;
}

function buildJointsPage(): FolderApi[] {
  const folders: FolderApi[] = [];

  for (const { document, joint } of mainScene.graph.getJointEntries()) {
    // Collapsed by default; populate the bindings only the first time the folder is expanded,
    // so opening the Joints tab doesn't build controls for every joint at once.
    const folder = jointsPage.addFolder({ title: document.id, expanded: false });
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

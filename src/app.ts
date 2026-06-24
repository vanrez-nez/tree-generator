import "./style.css";
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import type { CubicBezierApi } from "@tweakpane/plugin-essentials";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FolderApi, Pane } from "tweakpane";
import { MainScene } from "./scene/main";
import { DEFAULT_TREE_OPTIONS } from "./scene/tree";
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

const tab = pane.addTab({
  pages: [{ title: "Line" }, { title: "Joints" }],
});
const [linePage, jointsPage] = tab.pages;

// The Lines + Joints panels are rebuilt whenever the tree is regenerated (their line/joint
// instances change), so we track the folders they create to dispose them on rebuild.
let scenePanelFolders: FolderApi[] = [];

buildMeshControls();
buildRootControls();
buildScenePanels();

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

// Live tree controls: editing a root param rebuilds the whole tree graph (count/topology may
// change) and refreshes the dependent panels.
function buildRootControls(): void {
  const rootParams = {
    rootHeight: DEFAULT_TREE_OPTIONS.rootHeight,
    rootSeparation: DEFAULT_TREE_OPTIONS.rootSeparation,
    rootLSmooth: DEFAULT_TREE_OPTIONS.rootLSmooth,
    rootLength: DEFAULT_TREE_OPTIONS.rootLength,
    rootDownAngle: DEFAULT_TREE_OPTIONS.rootDownAngle,
    rootDownCurve: DEFAULT_TREE_OPTIONS.rootDownCurve,
    maxRoots: DEFAULT_TREE_OPTIONS.maxRoots,
  };

  const folder = pane.addFolder({ title: "Roots" });
  folder.addBinding(rootParams, "rootHeight", { label: "height", min: 0, max: 0.5, step: 0.01 });
  folder.addBinding(rootParams, "rootSeparation", { label: "separation", min: 0, max: 2, step: 0.05 });
  folder.addBinding(rootParams, "rootLSmooth", { label: "L smooth", min: 0, max: 1, step: 0.05 });
  folder.addBinding(rootParams, "rootLength", { label: "length", min: 0.2, max: 5, step: 0.05 });
  folder.addBinding(rootParams, "rootDownAngle", { label: "down angle (°)", min: 0, max: 90, step: 1 });
  folder.addBinding(rootParams, "rootDownCurve", { label: "down curve (°)", min: 0, max: 90, step: 1 });
  folder.addBinding(rootParams, "maxRoots", { label: "max roots", min: 0, max: 24, step: 1 });

  folder.on("change", () => {
    mainScene.setTreeOptions({ ...rootParams });
    rebuildScenePanels();
  });
}

// Global mesh resolution + the step-1 edge-walker view.
function buildMeshControls(): void {
  const folder = pane.addFolder({ title: "Debug" });

  const meshParams = { subdivisions: DEFAULT_TREE_OPTIONS.subdivisions };
  folder
    .addBinding(meshParams, "subdivisions", { min: 3, max: 48, step: 1 })
    .on("change", () => {
      mainScene.setTreeOptions({ subdivisions: meshParams.subdivisions });
      rebuildScenePanels();
    });

  const view = { surface: true, wireframe: false, edges: true, discs: true };
  folder
    .addBinding(view, "surface", { label: "mesh surface" })
    .on("change", (event) => mainScene.edgeWalker.setSurfaceVisible(event.value));
  folder
    .addBinding(view, "wireframe", { label: "wireframe" })
    .on("change", (event) => mainScene.edgeWalker.setSurfaceWireframe(event.value));
  folder
    .addBinding(view, "edges", { label: "edge walker" })
    .on("change", (event) => mainScene.edgeWalker.setEdgesVisible(event.value));
  folder
    .addBinding(view, "discs", { label: "show discs" })
    .on("change", (event) => setDiscsVisible(event.value));
  folder.addButton({ title: "Rebuild edges" }).on("click", () => mainScene.rebuildEdges());
}

function setDiscsVisible(visible: boolean): void {
  for (const { line } of mainScene.graph.getLineEntries()) {
    if (line.tube) {
      line.tube.visible = visible;
    }
  }
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
      folder.addBinding(line, "debugT", { min: 0, max: 1, step: 0.01 });
      folder.addBinding(line, "debugPointVisible");
      folder.addBinding(line, "debugLinePointsVisible");
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

function jointGroup(childLineId: string): "branch" | "root" | null {
  if (childLineId.startsWith("branch")) {
    return "branch";
  }
  if (childLineId.startsWith("root")) {
    return "root";
  }
  return null;
}

// Branching level encoded in the line id: `branch-0` / `root-0` = 1, `branch-0-1` = 2, …
function jointLevel(childLineId: string): number {
  return childLineId.split("-").length - 1;
}

// One slider per group + level that drives the lean clamp of every joint at that level. The
// constraint reads `maxLeanAngle` live each frame, so edits reshape all those forks at once.
function buildLeanAngleControls(): FolderApi | null {
  const seen = new Map<string, { group: string; level: number; angle: number }>();

  for (const { document, joint } of mainScene.graph.getJointEntries()) {
    const group = jointGroup(document.childLineId);

    if (!group) {
      continue;
    }

    const level = jointLevel(document.childLineId);
    const key = `${group}-${level}`;

    if (!seen.has(key)) {
      seen.set(key, { group, level, angle: joint.maxLeanAngle });
    }
  }

  if (seen.size === 0) {
    return null;
  }

  const folder = jointsPage.addFolder({ title: "Lean angles", expanded: true });
  const combos = [...seen.values()].sort(
    (a, b) => a.group.localeCompare(b.group) || a.level - b.level,
  );

  for (const combo of combos) {
    const state = { value: combo.angle };

    folder
      .addBinding(state, "value", {
        label: `${combo.group} L${combo.level} (°)`,
        min: 0,
        max: 90,
        step: 1,
      })
      .on("change", (event) => {
        for (const { document, joint } of mainScene.graph.getJointEntries()) {
          if (
            jointGroup(document.childLineId) === combo.group &&
            jointLevel(document.childLineId) === combo.level
          ) {
            joint.maxLeanAngle = event.value;
          }
        }
      });
  }

  return folder;
}

function buildJointsPage(): FolderApi[] {
  const folders: FolderApi[] = [];
  const leanFolder = buildLeanAngleControls();

  if (leanFolder) {
    folders.push(leanFolder);
  }

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

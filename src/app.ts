import "./style.css";
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FolderApi, Pane } from "tweakpane";
import { MainScene } from "./scene/main";
import { GraphLine } from "./scene/graph/line";
import type { LineModifier } from "./scene/graph/modifiers/modifier";
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

buildLineLayers();
buildJointsPage();

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

  addModifierEnvelopeControls(folder, modifier);
}

function modifierTypeName(modifier: LineModifier): string {
  if (modifier instanceof GnarlModifier) {
    return "Gnarl";
  }
  if (modifier instanceof TwistModifier) {
    return "Twist";
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

function buildLineLayers(): void {
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
      buildModifierLayers(folder, line);
    },
  };

  createLayers(linePage, {
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
  });
}

function buildJointsPage(): void {
  for (const { document } of mainScene.graph.getJointEntries()) {
    const folder = jointsPage.addFolder({ title: document.id });
    const jointView = {
      id: document.id,
      source: `${document.sourceLineId} @ ${document.sourceT.toFixed(2)}`,
      target: `${document.targetLineId}[${document.targetPointIndex}]`,
    };

    folder.addBinding(jointView, "id", { readonly: true });
    folder.addBinding(jointView, "source", { readonly: true });
    folder.addBinding(jointView, "target", { readonly: true });
  }
}

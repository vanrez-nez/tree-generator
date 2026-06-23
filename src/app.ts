import "./style.css";
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FolderApi, Pane } from "tweakpane";
import { MainScene } from "./scene/main";
import type { LineModifier } from "./scene/graph/modifiers/modifier";
import { GnarlModifier } from "./scene/graph/modifiers/gnarl";
import { SmoothModifier } from "./scene/graph/modifiers/smooth";
import { TwistModifier } from "./scene/graph/modifiers/twist";
import { addModifierEnvelopeControls } from "./tweak-pane/modifier-envelope";
import {
  StatsBladeApi,
  StatsPanePluginBundle,
} from "./tweak-pane/stats-blade";
import { createLayers, LayersPluginBundle } from "./tweak-pane/layers";

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
  pages: [{ title: "Line" }, { title: "Joints" }, { title: "Layers" }],
});
const [linePage, jointsPage, layersPage] = tab.pages;
let selectedLineFolder: FolderApi | null = null;

linePage
  .addBinding(mainScene, "selectedLineId", {
    label: "line",
    options: Object.fromEntries(
      mainScene.graph.getLineEntries().map(({ id }) => [id, id]),
    ),
  })
  .on("change", () => {
    rebuildSelectedLineFolder();
  });

rebuildSelectedLineFolder();
buildJointsPage();
buildLayersPage();

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

function rebuildSelectedLineFolder(): void {
  selectedLineFolder?.dispose();

  const line = mainScene.graph.getLineById(mainScene.selectedLineId);

  if (!line) {
    return;
  }

  selectedLineFolder = linePage.addFolder({ title: "Selected Line" });
  selectedLineFolder.addBinding(line, "pointCount", {
    readonly: true,
  });
  selectedLineFolder.addBinding(line, "thickness", {
    min: 1,
    max: 10,
    step: 1,
  });
  selectedLineFolder.addBinding(line, "debugT", {
    min: 0,
    max: 1,
    step: 0.01,
  });
  selectedLineFolder.addBinding(line, "debugPointVisible");
  selectedLineFolder.addBinding(line, "debugLinePointsVisible");

  for (const modifier of line.modifiers) {
    addModifierControls(selectedLineFolder, modifier);
  }
}

function addModifierControls(parentFolder: FolderApi, modifier: LineModifier): void {
  const folder = parentFolder.addFolder({ title: modifier.name });
  folder.addBinding(modifier, "enabled");

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

function buildLayersPage(): void {
  createLayers(layersPage, {
    types: [
      {
        name: "Smooth",
        createState: () => ({ strength: 0.5, iterations: 4 }),
        build: (folder, layer) => {
          folder.addBinding(layer.state, "strength", {
            min: 0,
            max: 1,
            step: 0.01,
          });
          folder.addBinding(layer.state, "iterations", {
            min: 1,
            max: 24,
            step: 1,
          });
        },
      },
      {
        name: "Gnarl",
        createState: () => ({ amount: 1, amplitude: 0.25 }),
        build: (folder, layer) => {
          folder.addBinding(layer.state, "amount", {
            min: 0,
            max: 2,
            step: 0.01,
          });
          folder.addBinding(layer.state, "amplitude", {
            min: 0,
            max: 0.75,
            step: 0.01,
          });
        },
      },
    ],
    onSelect: (layer) => {
      console.log("[layers] select", layer ? layer.id : null);
    },
    onVisibility: (layer) => {
      console.log("[layers] visibility", layer.id, layer.visible);
    },
    onReorder: (layers) => {
      console.log("[layers] reorder", layers.map((layer) => layer.id));
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

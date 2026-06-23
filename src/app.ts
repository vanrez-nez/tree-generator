import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Pane } from "tweakpane";
import { MainScene } from "./scene/main";
import {
  StatsBladeApi,
  StatsPanePluginBundle,
} from "./tweak-pane/stats-blade";

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
pane.registerPlugin(StatsPanePluginBundle);
const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
stats.setRenderer(renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL");

const lineFolder = pane.addFolder({ title: "Line" });
lineFolder.addBinding(mainScene.line, "pointCount", {
  readonly: true,
});
lineFolder.addBinding(mainScene.line, "segments", {
  min: 1,
  max: 128,
  step: 1,
});
lineFolder.addBinding(mainScene.line, "thickness", {
  min: 1,
  max: 10,
  step: 1,
});
lineFolder.addBinding(mainScene.line, "debugT", {
  min: 0,
  max: 1,
  step: 0.01,
});
lineFolder.addBinding(mainScene.line, "debugPointVisible");

const gnarlFolder = pane.addFolder({ title: "Gnarl" });
gnarlFolder.addBinding(mainScene.gnarlModifier, "enabled");
gnarlFolder.addBinding(mainScene.gnarlModifier.params, "seed", {
  min: 0,
  max: 100000,
  step: 1,
});
gnarlFolder.addBinding(mainScene.gnarlModifier.params, "amount", {
  min: 0,
  max: 2,
  step: 0.01,
});
gnarlFolder.addBinding(mainScene.gnarlModifier.params, "amplitude", {
  min: 0,
  max: 0.75,
  step: 0.01,
});
gnarlFolder.addBinding(mainScene.gnarlModifier.params, "cycles", {
  min: 0.1,
  max: 8,
  step: 0.1,
});

const twistFolder = pane.addFolder({ title: "Twist" });
twistFolder.addBinding(mainScene.twistModifier, "enabled");
twistFolder.addBinding(mainScene.twistModifier.params, "seed", {
  min: 0,
  max: 100000,
  step: 1,
});
twistFolder.addBinding(mainScene.twistModifier.params, "amount", {
  min: 0,
  max: 2,
  step: 0.01,
});
twistFolder.addBinding(mainScene.twistModifier.params, "radius", {
  min: 0,
  max: 0.5,
  step: 0.01,
});
twistFolder.addBinding(mainScene.twistModifier.params, "turns", {
  min: 0,
  max: 8,
  step: 0.1,
});

const smoothFolder = pane.addFolder({ title: "Smooth" });
smoothFolder.addBinding(mainScene.smoothModifier, "enabled");
smoothFolder.addBinding(mainScene.smoothModifier.params, "mode", {
  options: {
    Laplacian: "laplacian",
    Spline: "spline",
  },
});
smoothFolder.addBinding(mainScene.smoothModifier.params, "iterations", {
  min: 1,
  max: 24,
  step: 1,
});
smoothFolder.addBinding(mainScene.smoothModifier.params, "strength", {
  min: 0,
  max: 1,
  step: 0.01,
});
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

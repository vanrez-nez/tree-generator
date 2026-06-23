import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Pane } from "tweakpane";
import { MainScene } from "./scene/main";
import {
  StatsBladeApi,
  StatsPanePluginBundle,
} from "./tweak-pane/stats-blade";

const params = {
  color: "#8fd3ff",
};

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

const mainScene = new MainScene(params.color);

const pane = new Pane({ container: paneHost, title: "Settings" });
pane.registerPlugin(StatsPanePluginBundle);
const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
stats.setRenderer(renderer.capabilities.isWebGL2 ? "WebGL2" : "WebGL");

pane.addBinding(params, "color").on("change", () => {
  mainScene.setCubeColor(params.color);
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

  mainScene.update(timer.getDelta());
  controls.update();
  renderer.render(mainScene.scene, camera);
  stats.end();
  requestAnimationFrame(animate);
}

window.addEventListener("resize", resize);
resize();
animate();

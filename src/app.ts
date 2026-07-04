import "./style.css";
import * as THREE from "three";
import { WebGPURenderer, PMREMGenerator } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MainScene } from "./scene/main";
import { loadRendererConfig, setupTweakpane } from "./debug/tweakpane";

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

// Renderer config lives in the debug/tweakpane module (the Render tab owns it), but the renderer must be
// constructed with it before the pane exists — so load it here and hand the object to setupTweakpane.
const rendererConfig = loadRendererConfig();

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

// Build the entire Settings pane. Returns the handful of handles the render loop + DEV console still need.
const { stats, initFloor } = setupTweakpane({
  paneHost,
  renderer,
  mainScene,
  rendererConfig,
  resize,
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
}

// Resize on window resize. We deliberately do NOT use a ResizeObserver on the canvas: `renderer.setSize`
// writes the canvas backing-store attributes, which on Firefox perturb the canvas's laid-out content box, so
// observing that box feeds setSize back into the observer.
window.addEventListener("resize", () => resize());

// WebGPURenderer initialises its backend asynchronously (unlike WebGLRenderer). Wait for it before
// the first render, then drive the loop via setAnimationLoop (the WebGPU-friendly RAF).
await renderer.init();
mainScene.treeMaterial.setRenderer(renderer);
mainScene.floorMaterial.setRenderer(renderer);
await mainScene.treeMaterial.refresh();

// The visual floor is independent of the tree material; the pane owns visibility and tiling.
initFloor();

// Shared IBL environment: one RoomEnvironment PMREM cubemap drives image-based lighting for every tree
// (a single shader sample, no per-instance cost), giving soft directional fill + subtle reflections that
// a flat AmbientLight can't. This is the "fill" half of the fake/baked lighting rig (the baked per-vertex
// AO is the occlusion half); there are deliberately NO shadow maps. Built once after init.
try {
  const pmrem = new PMREMGenerator(renderer);
  mainScene.scene.environment = pmrem.fromScene(new RoomEnvironment()).texture;
  mainScene.scene.environmentIntensity = 0.1; // matches the Scene tab's default envIntensity
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
    __frame: () => {
      mainScene.update(0, camera, rendererSize);
      renderer.render(mainScene.scene, camera);
    },
  });
}

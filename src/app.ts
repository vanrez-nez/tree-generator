import "./style.css";
import * as THREE from "three";
import { WebGPURenderer, PMREMGenerator } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { MainScene } from "./scene/main";
import { bakeService } from "./scene/material/graph/bake-service";
import type { MaterialGraphController } from "./scene/material/graph/controller";
import { runTilingTest } from "./scene/material/graph/tiling-test";
import type { PbrSocket } from "./scene/material/graph/types";
import { createExport } from "./debug/export";
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

// Bake/export tooling (dev), bound to the renderer + scene it renders against. Consumed by the pane's
// Export/Bake buttons and by the DEV console handles below.
const exporter = createExport({ renderer, sceneCanvas, mainScene });

// Build the entire Settings pane. Returns the handful of handles the render loop + DEV console still need.
const { stats, refreshTexturePreview, initFloor, materialEditor, rebuildEditor } = setupTweakpane({
  app,
  paneHost,
  renderer,
  mainScene,
  rendererConfig,
  resize,
  exporter,
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
  refreshTexturePreview();
  controls.update();
  // Skip the frame render while a bake is compiling pipelines: `renderer.compileAsync` mutates shared
  // renderer state, so rendering during its await window corrupts the output (black screen / broken
  // geometry). The canvas holds its last frame for the ~sub-second compile; the DOM UI stays responsive.
  if (!bakeService.rendererBusy) renderer.render(mainScene.scene, camera);
  stats.end();
}

// Resize on window resize + on node-editor dock/undock (its onLayoutChange hook pads #app → the canvas
// reflows). We deliberately do NOT use a ResizeObserver on the canvas: `renderer.setSize` writes the canvas
// backing-store attributes, which on Firefox perturb the canvas's laid-out content box — so observing that
// box feeds setSize back into the observer, an infinite shrink loop that hard-freezes the page. A window /
// onLayoutChange trigger isn't watching the perturbed box, so there's no loop.
window.addEventListener("resize", () => resize());
// #app pads with a 0.15s transition when the editor docks; onLayoutChange fires at the START of that
// transition (pre-final size), so also resize when the padding transition finishes to capture the final box.
app.addEventListener("transitionend", (e) => {
  if ((e as TransitionEvent).propertyName.startsWith("padding")) resize();
});

// WebGPURenderer initialises its backend asynchronously (unlike WebGLRenderer). Wait for it before
// the first render, then drive the loop via setAnimationLoop (the WebGPU-friendly RAF).
await renderer.init();
// Offline baking needs the renderer — hand it to the one shared bake service now that it's initialised,
// then refresh both surfaces so they swap from the live startup fallback to the baked offline material.
bakeService.attachRenderer(renderer);
mainScene.treeSurface.refresh();

// The visual floor: load the chosen floor preset (independent of the tree's graph), refresh its surface,
// and apply visibility/tiling. Owned by the pane (floorState), so it runs via the returned handle.
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
    __editor: materialEditor,
    __openEditor: rebuildEditor,
    __bakeService: bakeService,
    // Back-compat shim for dev-console bake snippets: `__baker.readImageData(_renderer, graph, ch, size)`
    // now routes through the singleton service (the renderer arg is ignored — the service owns it).
    __baker: {
      readImageData: (_r: unknown, graph: MaterialGraphController, ch: PbrSocket, size?: number) =>
        bakeService.readImage(graph, ch, size),
    },
    __savePng: exporter.saveChannelToBake,
    __bakeConfig: exporter.bakeConfigToBake,
    __bakeMaterialTask: exporter.bakeMaterialTask,
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
        onTile: (type, img) => exporter.saveTilingComposite(type, img),
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

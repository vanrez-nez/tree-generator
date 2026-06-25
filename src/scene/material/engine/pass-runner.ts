import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

// Runs a fullscreen fragment pass into a render target using the APP renderer.
//
// Why the app renderer (not a private offscreen one): baked channels are bound DIRECTLY as textures
// on the tree's material, and WebGL textures can't cross contexts — so the bake must happen in the
// same context that renders the scene. The render target is saved/restored so the main render loop
// is undisturbed.
export class PassRunner {
  private readonly fsq = new FullScreenQuad();

  constructor(private readonly renderer: THREE.WebGLRenderer) {}

  render(material: THREE.Material, target: THREE.WebGLRenderTarget): void {
    const previous = this.renderer.getRenderTarget();
    this.fsq.material = material;
    this.renderer.setRenderTarget(target);
    this.fsq.render(this.renderer);
    this.renderer.setRenderTarget(previous);
  }

  // Read a render target's pixels back to CPU (for PNG export).
  readback(target: THREE.WebGLRenderTarget, buffer: Uint8Array, width: number, height: number): void {
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, buffer);
  }

  dispose(): void {
    this.fsq.dispose();
  }
}

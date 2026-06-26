import { QuadMesh, RenderTarget, MeshBasicNodeMaterial, type WebGPURenderer } from "three/webgpu";
import { vec3, sRGBTransferOETF } from "three/tsl";
import { compileSockets } from "./compiler";
import type { MaterialGraphController } from "./controller";
import type { MaterialValue, PbrSocket } from "./types";

// Colour-management convention (plan L5 / Phase 6): the graph works in LINEAR space, and a baked texture
// follows texture convention — colour channels are sRGB-encoded (display), data channels stay linear.
// Scalar-field channels render as linear grayscale; colour channels get the sRGB OETF; normal is already
// an encoded [0,1] vector (from normal-from-height) and stays linear/raw.
export const FIELD_CHANNELS: PbrSocket[] = ["roughness", "metallic", "ambientOcclusion"];
export const COLOR_CHANNELS: PbrSocket[] = ["baseColor", "emission"];

// Per-channel encoding into a renderable colorNode. Shared by the channel baker (preview/PNG) and the
// offline surface baker so both produce identical texels (and the offline RT's colorSpace lines up).
export function encodeChannel(node: MaterialValue, channel: PbrSocket): MaterialValue {
  if (FIELD_CHANNELS.includes(channel)) return vec3(node); // linear grayscale data
  if (COLOR_CHANNELS.includes(channel)) return sRGBTransferOETF(node); // sRGB-encode (display convention)
  return node; // normal / other: already-encoded vector data, leave linear
}

// A shared fullscreen-quad baker. Renders a colorNode into a render target. (Module-level singleton: bakes
// are synchronous, so reusing one quad/material across callers is safe.)
const bakeMaterial = new MeshBasicNodeMaterial();
const bakeQuad = new QuadMesh(bakeMaterial);
export function renderColorNodeToTarget(
  renderer: WebGPURenderer,
  colorNode: MaterialValue,
  rt: RenderTarget,
): void {
  bakeMaterial.colorNode = colorNode;
  bakeMaterial.needsUpdate = true;
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  bakeQuad.render(renderer);
  renderer.setRenderTarget(previous);
}

// Renders a single material-graph channel to a 2D image for the preview / PNG export. Compiles the graph
// with the offline (uv) backend so each channel is a function of uv, draws it on a fullscreen quad into a
// render target, and reads the pixels back.
export class ChannelBaker {
  private rt: RenderTarget | null = null;
  private rtSize = 0;

  private target(size: number): RenderTarget {
    if (!this.rt || this.rtSize !== size) {
      this.rt?.dispose();
      this.rt = new RenderTarget(size, size);
      this.rtSize = size;
    }
    return this.rt;
  }

  // Render the channel and read it back as top-down ImageData (null if the channel is unconnected).
  async readImageData(
    renderer: WebGPURenderer,
    controller: MaterialGraphController,
    channel: PbrSocket,
    size = 512,
  ): Promise<ImageData | null> {
    const { bundle } = compileSockets(controller.document, controller.getRegistry(), {
      backend: "offline",
    });
    // PBR channels are a subset of the bundle keys (ao has no Principled source → null, like Blender).
    const node = (bundle as Partial<Record<string, MaterialValue>>)[channel];
    if (!node) return null;

    const rt = this.target(size);
    renderColorNodeToTarget(renderer, encodeChannel(node, channel), rt);

    // WebGPU readback returns the typed array (RGBA8 bytes); no caller-supplied buffer. NOTE: `size`
    // must give 256-byte-aligned rows (i.e. a multiple of 64 px, since 64*4 = 256) — otherwise the
    // GPU copy's per-row padding isn't accounted for here and the image comes back row-scrambled. All
    // real callers use aligned sizes (preview 256, export 1024); keep test sizes aligned too.
    const buffer = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size)) as unknown as Uint8Array;

    // GPU readback is bottom-up; flip vertically into the ImageData buffer.
    const data = new Uint8ClampedArray(size * size * 4);
    const stride = size * 4;
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * stride;
      data.set(buffer.subarray(src, src + stride), y * stride);
    }
    return new ImageData(data, size, size);
  }

  async downloadPng(
    renderer: WebGPURenderer,
    controller: MaterialGraphController,
    channel: PbrSocket,
    filename: string,
    size = 1024,
  ): Promise<void> {
    const image = await this.readImageData(renderer, controller, channel, size);
    if (!image) return;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d")?.putImageData(image, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  dispose(): void {
    this.rt?.dispose();
  }
}

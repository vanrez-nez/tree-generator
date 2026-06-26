import { QuadMesh, RenderTarget, MeshBasicNodeMaterial, type WebGPURenderer } from "three/webgpu";
import { vec3, sRGBTransferOETF } from "three/tsl";
import { compileSockets } from "./compiler";
import type { MaterialGraphController } from "./controller";
import type { MaterialValue, PbrSocket } from "./types";

// Colour-management convention (plan L5 / Phase 6): the graph works in LINEAR space, and a baked PNG
// follows texture convention — colour channels are sRGB-encoded (display), data channels stay linear.
// Scalar-field channels render as linear grayscale; colour channels get the sRGB OETF; normal is encoded
// vector data and stays linear/raw.
const FIELD_CHANNELS: PbrSocket[] = ["roughness", "metallic", "ambientOcclusion"];
const COLOR_CHANNELS: PbrSocket[] = ["baseColor", "emission"];

// Renders a single material-graph channel to a 2D texture for the preview / PNG export. Compiles the
// graph with the baked (uv) backend so each channel is a function of uv, draws it on a fullscreen
// QuadMesh into a render target, and reads the pixels back (material-graph-plan.md, Phase 5).
export class ChannelBaker {
  private readonly material = new MeshBasicNodeMaterial();
  private readonly quad = new QuadMesh(this.material);
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
      backend: "baked",
    });
    // PBR channels are a subset of the bundle keys (ao has no Principled source → null, like Blender).
    const node = (bundle as Partial<Record<string, MaterialValue>>)[channel];
    if (!node) return null;

    this.material.colorNode = FIELD_CHANNELS.includes(channel)
      ? vec3(node) // linear grayscale data
      : COLOR_CHANNELS.includes(channel)
        ? sRGBTransferOETF(node) // sRGB-encode colour (texture/display convention)
        : node; // normal / other: encoded vector data, leave linear
    this.material.needsUpdate = true;

    const rt = this.target(size);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(rt);
    this.quad.render(renderer);
    renderer.setRenderTarget(previous);

    // WebGPU readback returns the typed array (RGBA8 bytes); no caller-supplied buffer.
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
    this.material.dispose();
  }
}

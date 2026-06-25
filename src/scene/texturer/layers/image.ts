import type { BlendMode, TextureLayer, TextureSize } from "../layer";
import { SAMPLE_TEXTURES } from "../document";

// Image layer — the first concrete texturer step (analog of a concrete modifier like SmoothModifier).
// Loads a bundled image and composites it onto the shared canvas, either stretched to fill or tiled
// with scale/offset. The image loads asynchronously, so the layer pings the mixer's `invalidate`
// hook on load (and on error) to trigger a re-build once the bitmap is ready.

export type ImageFit = "stretch" | "tile";

export type ImageLayerParams = {
  src: string; // bundled path served from public/, e.g. "/textures/bark.png"
  opacity: number; // 0..1
  blend: BlendMode;
  fit: ImageFit;
  scale: number; // tile only: multiplier on the image's natural size
  offsetX: number; // tile only: 0..1 fraction of width
  offsetY: number; // tile only: 0..1 fraction of height
};

export type ImageLayerOptions = Partial<ImageLayerParams> & {
  enabled?: boolean;
  invalidate?: () => void; // mixer-provided dirty hook, fired when the async load completes
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class ImageLayer implements TextureLayer<ImageLayerParams> {
  readonly name = "image";
  enabled: boolean;
  params: ImageLayerParams;

  private invalidate: () => void;
  private image: HTMLImageElement | null = null;
  private loadedSrc: string | null = null; // guards against re-issuing the same load each build

  constructor({
    enabled = true,
    src = SAMPLE_TEXTURES[0].path,
    opacity = 1,
    blend = "source-over",
    fit = "stretch",
    scale = 1,
    offsetX = 0,
    offsetY = 0,
    invalidate = () => {},
  }: ImageLayerOptions = {}) {
    this.enabled = enabled;
    this.invalidate = invalidate;
    this.params = { src, opacity, blend, fit, scale, offsetX, offsetY };
  }

  // The mixer wires its invalidate here for layers created by the UI (which can't pass it in).
  setInvalidate(invalidate: () => void): void {
    this.invalidate = invalidate;
  }

  apply(ctx: CanvasRenderingContext2D, size: TextureSize): void {
    this.ensureLoaded();
    const image = this.image;
    if (!image || !image.complete || image.naturalWidth === 0) {
      return; // not ready yet — onload will invalidate and we'll repaint then
    }

    ctx.save();
    ctx.globalAlpha = clamp01(this.params.opacity);
    ctx.globalCompositeOperation = this.params.blend;

    if (this.params.fit === "tile") {
      const pattern = ctx.createPattern(image, "repeat");
      if (pattern) {
        const scale = Math.max(0.001, this.params.scale);
        const tx = this.params.offsetX * size.width;
        const ty = this.params.offsetY * size.height;
        pattern.setTransform(new DOMMatrix([scale, 0, 0, scale, tx, ty]));
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, size.width, size.height);
      }
    } else {
      ctx.drawImage(image, 0, 0, size.width, size.height);
    }

    ctx.restore();
  }

  private ensureLoaded(): void {
    if (this.image && this.loadedSrc === this.params.src) {
      return;
    }
    this.loadedSrc = this.params.src;
    const image = new Image();
    image.onload = () => this.invalidate();
    image.onerror = () => {
      // Leave the image incomplete; apply() skips it. Bump anyway so a later valid src rebuilds.
      this.invalidate();
    };
    image.src = this.params.src;
    this.image = image;
  }
}

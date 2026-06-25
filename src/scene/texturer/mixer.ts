import * as THREE from "three";
import type { TextureLayer } from "./layer";
import type { TextureDocument, TextureLayerDocument } from "./document";
import { DEFAULT_TEXTURE_RESOLUTION } from "./document";
import { ImageLayer } from "./layers/image";

// Texture mixer — the texture-side analog of Graph (graph/graph.ts). It owns an ordered stack of
// layers, loads a document, composites every enabled layer onto one persistent offscreen canvas,
// and exposes the result as a single persistent THREE.CanvasTexture. MainScene polls
// `getSignature()` (a dirty-version counter) each frame and rebuilds when it changes — the same
// signature-poll pattern the mesher uses against `graph.getGeometrySignature()`.

// Deserialize a layer document into a live layer (analog of graph's `createModifier`). The mixer's
// `invalidate` is injected so async image loads can mark the mixer dirty.
function createLayer(
  document: TextureLayerDocument,
  invalidate: () => void,
): TextureLayer {
  // Single member today; the explicit return keeps control-flow analysis happy as the union grows.
  return new ImageLayer({ ...document.params, enabled: document.enabled, invalidate });
}

export class TextureMixer {
  private layers: TextureLayer[] = [];
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private width: number;
  private height: number;
  private version = 0;

  constructor(
    width = DEFAULT_TEXTURE_RESOLUTION,
    height = DEFAULT_TEXTURE_RESOLUTION,
  ) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) {
      throw new Error("TextureMixer: failed to acquire a 2D canvas context");
    }
    this.ctx = ctx;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
  }

  // Bound so it can be handed to layers and used as a callback without losing `this`.
  invalidate = (): void => {
    this.version = (this.version + 1) >>> 0;
  };

  loadDocument(document: TextureDocument): void {
    if (document.width) {
      this.resize(document.width, document.height ?? document.width);
    }
    this.layers = document.layers.map((layer) => createLayer(layer, this.invalidate));
    this.invalidate();
  }

  addLayer(layer: TextureLayer): void {
    // UI-created layers (via the blade's createState) don't get the invalidate hook at construction.
    if (hasSetInvalidate(layer)) {
      layer.setInvalidate(this.invalidate);
    }
    this.layers.push(layer);
    this.invalidate();
  }

  removeLayer(layer: TextureLayer): boolean {
    const index = this.layers.indexOf(layer);
    if (index < 0) {
      return false;
    }
    this.layers.splice(index, 1);
    this.invalidate();
    return true;
  }

  reorderLayers(ordered: TextureLayer[]): void {
    this.layers = ordered.slice();
    this.invalidate();
  }

  getLayerEntries(): { layer: TextureLayer }[] {
    return this.layers.map((layer) => ({ layer }));
  }

  // Repaint the canvas: reset to opaque white, then composite every enabled layer in stack order.
  // White is the neutral base for a color map (it multiplies the material color), so an empty mix
  // shows the material's own color rather than going black.
  build(): void {
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.fillStyle = "#ffffff";
    this.ctx.fillRect(0, 0, this.width, this.height);
    for (const layer of this.layers) {
      if (layer.enabled) {
        layer.apply(this.ctx, { width: this.width, height: this.height });
      }
    }
    this.texture.needsUpdate = true;
  }

  getTexture(): THREE.CanvasTexture {
    return this.texture;
  }

  getSignature(): number {
    return this.version;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.invalidate();
  }

  dispose(): void {
    this.texture.dispose();
  }
}

// Layers that can receive the mixer's invalidate hook after construction (e.g. ImageLayer).
function hasSetInvalidate(
  layer: TextureLayer,
): layer is TextureLayer & { setInvalidate(invalidate: () => void): void } {
  return (
    "setInvalidate" in layer &&
    typeof (layer as { setInvalidate?: unknown }).setInvalidate === "function"
  );
}

import * as THREE from "three";
import type { BakeContext } from "./engine/node";
import { PassRunner } from "./engine/pass-runner";
import { downloadChannelPng, renderChannelToImageData } from "./engine/export";
import { HeightNode } from "./nodes/height";
import { WarpNode } from "./nodes/warp";
import { SlopeBlurNode } from "./nodes/slope-blur";
import { CellsNode } from "./nodes/cells";
import { GradientMapNode } from "./nodes/gradient-map";
import { NormalNode } from "./nodes/normal";
import { AoNode } from "./nodes/ao";
import { RoughnessNode } from "./nodes/roughness";

// The authored material DAG + its "Material Output". A single shared HEIGHT field (FBM) drives every
// channel — basecolor (gradient map), normal (slope), AO (cavity) — the coherent-derivation
// principle. Owns the PassRunner (bound to the app renderer) and bakes lazily: `signature()` changes
// only when some node's params change, so MainScene's poll re-bakes on demand.

export const MATERIAL_RESOLUTION = 1024;

export type MaterialChannels = {
  basecolor: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  roughness: THREE.Texture;
};

export class MaterialGraph {
  // Shared substrate: a height field — warped, slope-blurred (eroded), then split into plates by the
  // JFA cell structure. Every channel derives from this same field (coherent). Dependency order.
  readonly height = new HeightNode();
  readonly warp = new WarpNode(this.height);
  readonly slopeBlur = new SlopeBlurNode(this.warp);
  readonly cells = new CellsNode(this.slopeBlur);
  // Output nodes by channel — public so the UI can edit their params.
  readonly basecolor = new GradientMapNode(this.cells);
  readonly normal = new NormalNode(this.cells);
  readonly ao = new AoNode(this.cells);
  readonly roughness = new RoughnessNode(this.cells);

  private readonly runner: PassRunner;
  private readonly width = MATERIAL_RESOLUTION;
  private readonly height_ = MATERIAL_RESOLUTION;

  constructor(renderer: THREE.WebGLRenderer) {
    this.runner = new PassRunner(renderer);
  }

  private ctx(): BakeContext {
    return { runner: this.runner, width: this.width, height: this.height_ };
  }

  // Aggregate signature across all channel outputs (each folds in the shared height chain).
  signature(): string {
    return [
      this.basecolor.signature(),
      this.normal.signature(),
      this.ao.signature(),
      this.roughness.signature(),
    ].join("|");
  }

  // Evaluate every channel (lazy/cached per node; the shared chain bakes once) and return textures.
  bake(): MaterialChannels {
    const ctx = this.ctx();
    return {
      basecolor: this.basecolor.resolve(ctx),
      normal: this.normal.resolve(ctx),
      ao: this.ao.resolve(ctx),
      roughness: this.roughness.resolve(ctx),
    };
  }

  // The PBR maps to bind onto the surface. A disabled output node drops its channel (null), so the
  // material falls back to its default (flat normal, no AO, uniform roughness, base color). Chain
  // nodes (warp/slopeBlur/cells) instead pass through when disabled — handled in `MaterialNode`.
  bakeMaps(): {
    map: THREE.Texture | null;
    normalMap: THREE.Texture | null;
    aoMap: THREE.Texture | null;
    roughnessMap: THREE.Texture | null;
  } {
    const channels = this.bake();
    return {
      map: this.basecolor.enabled ? channels.basecolor : null,
      normalMap: this.normal.enabled ? channels.normal : null,
      aoMap: this.ao.enabled ? channels.ao : null,
      roughnessMap: this.roughness.enabled ? channels.roughness : null,
    };
  }

  // Bake then download one channel as a PNG (for use in other tools/engines).
  exportChannel(name: keyof MaterialChannels): void {
    const channels = this.bake();
    downloadChannelPng(this.runner, channels[name], this.width, this.height_, `bark-${name}.png`);
  }

  // Bake then read one channel back as ImageData (top-down) for the 2D texture preview.
  readChannelImageData(name: keyof MaterialChannels): ImageData {
    const channels = this.bake();
    return renderChannelToImageData(this.runner, channels[name], this.width, this.height_);
  }

  dispose(): void {
    this.basecolor.dispose();
    this.normal.dispose();
    this.ao.dispose();
    this.roughness.dispose();
    this.cells.dispose();
    this.slopeBlur.dispose();
    this.warp.dispose();
    this.height.dispose();
    this.runner.dispose();
  }
}

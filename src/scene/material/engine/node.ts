import * as THREE from "three";
import type { PassRunner } from "./pass-runner";
import { createColorTarget, createDataTarget } from "./targets";

// Base node for the material DAG (the texture-side analog of a graph modifier). Each node is a pure
// function `out = f(inputs, params, res)` that renders into its own cached render target.
//
// Dirty-propagation + caching are signature-driven: a node's `signature()` folds in its own params
// AND all input signatures, so any upstream change invalidates this node too. `resolve()` re-bakes
// only when the signature changed and returns the cached output texture. Wiring is by object
// reference (code-authored DAG, acyclic by construction); a visual editor + cycle check come later.

export type NodeKind = "color" | "data"; // sRGB color output vs linear higher-precision data buffer

export type BakeContext = {
  runner: PassRunner;
  width: number;
  height: number;
};

export abstract class MaterialNode {
  abstract readonly kind: NodeKind;

  private target: THREE.WebGLRenderTarget | null = null;
  private lastSignature: string | null = null;

  // Subclasses encode their own params here; inputs are folded in by `signature()`.
  protected abstract paramSignature(): string;
  // Upstream nodes feeding this one (empty for generators).
  protected inputs(): MaterialNode[] {
    return [];
  }
  // Render this node's output into `target` (created/sized by resolve). Inputs are already baked;
  // read them via `input.resolve(ctx)` (memoized — returns the cached texture).
  protected abstract render(ctx: BakeContext, target: THREE.WebGLRenderTarget): void;

  signature(): string {
    const inputs = this.inputs()
      .map((node) => node.signature())
      .join(",");
    return `${this.paramSignature()}[${inputs}]`;
  }

  // Lazily (re)bake when the signature changed; returns the cached output texture.
  resolve(ctx: BakeContext): THREE.Texture {
    const sig = this.signature();
    if (this.target && sig === this.lastSignature) {
      return this.target.texture;
    }
    for (const input of this.inputs()) {
      input.resolve(ctx);
    }
    if (!this.target) {
      this.target =
        this.kind === "color"
          ? createColorTarget(ctx.width, ctx.height)
          : createDataTarget(ctx.width, ctx.height);
    }
    this.render(ctx, this.target);
    this.lastSignature = sig;
    return this.target.texture;
  }

  dispose(): void {
    this.target?.dispose();
    this.target = null;
    this.lastSignature = null;
  }
}

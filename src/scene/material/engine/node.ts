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

  // When false the node is bypassed: chain nodes (with inputs) pass their first input through
  // unchanged; generators/outputs without inputs ignore this (a root can't be bypassed, and a
  // disabled output channel is dropped by MaterialGraph, not here). Folded into `signature()` so
  // toggling triggers a re-bake.
  enabled = true;

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
    return `${this.enabled ? "e1" : "e0"}${this.paramSignature()}[${inputs}]`;
  }

  // Lazily (re)bake when the signature changed; returns the cached output texture.
  resolve(ctx: BakeContext): THREE.Texture {
    // Bypassed chain node: pass the first input through unchanged (no own render/target needed).
    const ins = this.inputs();
    if (!this.enabled && ins.length > 0) {
      return ins[0].resolve(ctx);
    }
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

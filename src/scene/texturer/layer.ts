// Texturer base contract — the texture-side analog of LineModifier (graph/modifiers/modifier.ts).
//
// A texture is built by layering configurable steps, just like a graph line is shaped by layering
// modifiers. Each layer draws onto a single shared 2D canvas context in stack order; the mixer
// (mixer.ts) clears the canvas, then calls every enabled layer's `apply` in turn. Cross-cutting
// state is just `enabled` (driven by the layers blade's eye toggle) — everything else, including
// per-layer compositing (opacity + blend), lives in each layer's own `params`, mirroring how each
// modifier owns its params.

// Subset of the DOM GlobalCompositeOperation we expose as blend modes. Values are spelled exactly
// as the canvas enum so they can be assigned straight to ctx.globalCompositeOperation.
export type BlendMode =
  | "source-over"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn";

export type TextureSize = { width: number; height: number };

export type TextureLayer<TParams extends object = Record<string, unknown>> = {
  readonly name: string;
  enabled: boolean;
  params: TParams;
  // Composite this layer onto the shared context. Implementations should wrap their draw in
  // ctx.save()/ctx.restore() and honor their own opacity (ctx.globalAlpha) and blend
  // (ctx.globalCompositeOperation).
  apply(ctx: CanvasRenderingContext2D, size: TextureSize): void;
};

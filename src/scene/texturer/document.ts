// Serialized description of a texture mix — the texture-side analog of GraphDocument
// (graph/document.ts). A document is a flat, ordered list of layers, each a type-discriminated
// record with optional `enabled` + partial `params`; the mixer's `createLayer` factory turns each
// into a live TextureLayer (mirroring how `createModifier` deserializes ModifierDocuments).

import type { ImageLayerParams } from "./layers/image";

export type ImageLayerDocument = {
  type: "image";
  enabled?: boolean;
  params?: Partial<ImageLayerParams>;
};

// Union grows as more layer types are added (noise, gradient, …).
export type TextureLayerDocument = ImageLayerDocument;

export type TextureDocument = {
  layers: TextureLayerDocument[];
  width?: number;
  height?: number;
};

// Square so the cylindrical UVs (which wrap S around the trunk and grow T along it) map evenly.
export const DEFAULT_TEXTURE_RESOLUTION = 1024;

// Bundled sample textures, served from public/ at the site root (Vite). Extend this list to offer
// more options in the Image layer's `src` dropdown.
export const SAMPLE_TEXTURES = [
  { label: "Bark", path: "/textures/bark.png" },
] as const;

export const DEFAULT_TEXTURE_DOCUMENT: TextureDocument = {
  width: DEFAULT_TEXTURE_RESOLUTION,
  height: DEFAULT_TEXTURE_RESOLUTION,
  layers: [{ type: "image", enabled: true, params: { src: SAMPLE_TEXTURES[0].path } }],
};

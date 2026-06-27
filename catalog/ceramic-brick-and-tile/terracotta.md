# Terracotta

## Material Brief

- **Visual Description:** matte fired clay surface in warm orange, burnt sienna, and red-brown tones, typically #8f3f1f to #d47a3d. The surface should read hard and ceramic, with fine dark pin pores, pale clay dust in shallow recesses, soft firing clouds, and occasional lighter worn edges. Avoid brick joints, grout, glaze shine, or large stone aggregate.
- **Procedural Identity:** use a broad warm clay color ramp with low-frequency firing blotches, dense fine pore speckles, sparse darker mineral flecks, and chipped edge masks that reveal lighter dry clay. Keep the pattern continuous rather than divided into blocks.
- **Typical Channels:** non-metallic; base color dominated by clay oranges and red-browns; roughness 0.75-0.95 with slightly smoother worn edges; low to medium pore normal; shallow height for chips and pits; AO mostly inside pores, scratches, and chipped recesses; no emission.

## Render Tasks

### terracotta-smooth-vessel - Smooth Vessel Terracotta

- **Status:** Planned
- **Goal:** Generate a continuous fired-clay ceramic surface suitable for a pot, vase, or sculpture body.
- **Material Target:** smooth orange-red terracotta with subtle firing clouds, very fine pores, faint circular or hand-smoothed rub marks, and lighter worn high spots. The surface must remain continuous, with no tile grid, mortar, grout, or glaze shine.
- **Procedural Requirements:** use broad clay color variation, low-contrast pore noise, sparse mineral flecks, faint directional smoothing marks, and shallow edge-wear masks. Height should be restrained and mostly driven by pores and small chips.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, FBM, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/terracotta/terracotta-smooth-vessel.json`; bake folder `bake/materials/ceramic-brick-and-tile/terracotta/terracotta-smooth-vessel/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### terracotta-rough-outdoor - Rough Outdoor Terracotta

- **Status:** Planned
- **Goal:** Generate weather-exposed matte terracotta with stronger pores, dust, and small chips.
- **Material Target:** rough fired clay in burnt orange and brown-red, with dense dark pin pores, pale dust in recesses, random small pits, and chipped lighter clay edges. It should read dry, abrasive, and outdoor-worn rather than smooth vessel ceramic.
- **Procedural Requirements:** increase pore density and height contrast, add dusty cavity masks, stronger chipped-edge masks, low-frequency firing blotches, and occasional darker mineral flecks. Roughness should remain high with only slight variation on worn high points.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, Voronoi, ColorRamp, Blend, Clamp, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/terracotta/terracotta-rough-outdoor.json`; bake folder `bake/materials/ceramic-brick-and-tile/terracotta/terracotta-rough-outdoor/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### terracotta-sun-faded - Sun-Faded Terracotta

- **Status:** Planned
- **Goal:** Generate faded terracotta where sunlight has bleached high areas and reduced saturation.
- **Material Target:** pale orange, dusty salmon, and muted red-brown terracotta with desaturated raised zones, warmer color in protected recesses, and subtle clay pores. The result should feel dry and sun-baked, not dirty or smoke-stained.
- **Procedural Requirements:** use a height-linked fade mask, broad low-frequency color desaturation, pale dust overlays on high points, fine pores, and minimal chip damage. Preserve the continuous fired-clay identity.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, FBM, ColorRamp, Hue/Saturation/Value, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/terracotta/terracotta-sun-faded.json`; bake folder `bake/materials/ceramic-brick-and-tile/terracotta/terracotta-sun-faded/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### terracotta-smoke-darkened - Smoke-Darkened Terracotta

- **Status:** Planned
- **Goal:** Generate fired clay darkened by smoke, soot, or kiln staining.
- **Material Target:** orange-red clay partially obscured by brown-gray and charcoal smoke stains, with darker clouds collecting in pits and recesses. The surface should still show terracotta pores and clay warmth under the staining.
- **Procedural Requirements:** combine a warm terracotta base with soft smoke masks, cavity-darkening, uneven soot blooms, fine pore normal, and sparse lighter chips that cut through the dark layer. Avoid making the surface read as brick or charred wood.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, FBM, ColorRamp, Blend, Bright/Contrast, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/terracotta/terracotta-smoke-darkened.json`; bake folder `bake/materials/ceramic-brick-and-tile/terracotta/terracotta-smoke-darkened/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

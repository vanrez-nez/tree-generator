# Mosaic Tile

## Material Brief

- **Visual Description:** dense field of small ceramic or stone tesserae separated by visible grout. Pieces can be square, rectangular, triangular, or irregular hand-cut shapes, typically 5-40 mm visually, with varied colors such as white, turquoise, cobalt, ochre, terracotta, black, or muted stone tones. Each piece should have its own bevel, slight height offset, color variation, and occasional chipped corner, while grout remains continuous between pieces.
- **Procedural Identity:** generate a small-cell tile layout, grout network mask, per-piece hue/value/roughness jitter, bevel masks around every tessera, random missing chips, and dirt accumulation in grout. Keep scale much smaller than brick or floor tile and make individual pieces visually distinct.
- **Typical Channels:** non-metallic; base color is per-piece ceramic/stone color plus gray, cream, or dark grout; roughness varies by piece, 0.12-0.45 for glossy glaze and 0.55-0.9 for matte stone or worn ceramic; medium height with raised tesserae and recessed grout; AO strong in grout channels and chipped corners; no emission.

## Render Tasks

### mosaic-tile-square-bathroom - Regular Square Bathroom Mosaic

- **Status:** Planned
- **Goal:** Generate a clean grid of small square glossy bathroom tiles.
- **Material Target:** small square ceramic tiles in white, pale blue, mint, gray, or black, separated by clean light grout. Tiles should have uniform size, slight bevels, glossy faces, and minimal chips.
- **Procedural Requirements:** use a small aligned square grid, consistent grout width, bevel masks, subtle per-tile color/roughness jitter, low height tile faces, and AO in grout channels.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-square-bathroom.json`; bake folder `bake/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-square-bathroom/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### mosaic-tile-hand-cut-mediterranean - Irregular Hand-Cut Mediterranean Mosaic

- **Status:** Planned
- **Goal:** Generate irregular hand-cut tesserae with warm Mediterranean colors.
- **Material Target:** uneven small ceramic pieces in cobalt, turquoise, white, ochre, terracotta, and black, separated by cream grout. Pieces should be irregular polygons with visible bevels and handmade placement.
- **Procedural Requirements:** generate irregular small-cell shapes, grout network masks, strong per-piece hue variation, chipped corners, varied height offsets, and dirt in grout. Avoid regular square repetition.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Tileable Warp, Tileable Noise, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-hand-cut-mediterranean.json`; bake folder `bake/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-hand-cut-mediterranean/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### mosaic-tile-mixed-ceramic-stone - Mixed Ceramic And Stone Tesserae

- **Status:** Planned
- **Goal:** Generate a mosaic mixing glossy ceramic pieces with matte stone pieces.
- **Material Target:** small tesserae where some pieces are colored glossy ceramic and others are beige, gray, or muted stone. Grout is visible, and roughness varies clearly per piece.
- **Procedural Requirements:** create small cells with a material-class mask, separate color ramps for ceramic and stone, roughness variation by class, beveled edges, slight height offsets, and grout AO.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Tileable Noise, ColorRamp, Blend, Split/Combine Channels, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-mixed-ceramic-stone.json`; bake folder `bake/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-mixed-ceramic-stone/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### mosaic-tile-high-gloss-colorful - High-Gloss Colorful Mosaic

- **Status:** Planned
- **Goal:** Generate a saturated glossy mosaic with strong per-tile color variety.
- **Material Target:** small glossy tiles in bright cobalt, teal, yellow, red, white, and black with dark or light grout. Faces should be shiny and clean, with strong color separation and crisp bevels.
- **Procedural Requirements:** use high-saturation per-tile color assignment, low roughness tile faces, grout masks with higher roughness, bevel height, slight glaze waviness, and minimal dirt.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Checker, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-high-gloss-colorful.json`; bake folder `bake/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-high-gloss-colorful/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### mosaic-tile-worn-outdoor - Worn Outdoor Mosaic

- **Status:** Planned
- **Goal:** Generate weathered mosaic tile with dirty grout and chipped pieces.
- **Material Target:** small muted ceramic or stone pieces with worn edges, chipped corners, dusty surfaces, dark dirty grout, and uneven height. Colors should be less saturated than indoor mosaic.
- **Procedural Requirements:** add dirt masks in grout, chipped-piece masks, desaturated per-piece colors, roughness increase on worn pieces, small height offsets, and stronger AO around broken edges.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Tileable Noise, FBM, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-worn-outdoor.json`; bake folder `bake/materials/ceramic-brick-and-tile/mosaic-tile/mosaic-tile-worn-outdoor/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

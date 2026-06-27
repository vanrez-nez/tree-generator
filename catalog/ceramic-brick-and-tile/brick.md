# Brick

## Material Brief

- **Visual Description:** repeated fired-clay masonry blocks laid in a clear rectangular bond pattern with recessed mortar joints. Bricks range from red-orange and russet to brown, burgundy, or dark purple, with sandy pores, kiln color variation, chipped corners, and darker dirty grooves between units. Each brick should remain legible as an individual block, not a continuous clay slab.
- **Procedural Identity:** generate a staggered brick grid, mortar mask, per-brick hue/value jitter, subtle brick-face bowing, edge bevel masks, chipped-corner damage, fine sandy pores, and darker contact dirt along mortar seams. Maintain consistent block proportions and avoid tiny mosaic-scale pieces.
- **Typical Channels:** non-metallic; base color mixes clay hues with pale gray, tan, or dark mortar; roughness 0.8-1.0 on brick and mortar; medium height with raised brick faces and recessed joints; normal emphasizes bevels, pores, and chips; AO strong in mortar grooves and under chipped edges; no emission.

## Render Tasks

### brick-running-bond-red - Running Bond Red Brick

- **Status:** Planned
- **Goal:** Generate classic red brickwork in a staggered running bond.
- **Material Target:** red-orange fired-clay bricks with half-brick row offsets, pale gray mortar, sandy pores, subtle chipped corners, and darker dirt in recessed joints. Each brick should have mild hue/value variation while the wall stays orderly.
- **Procedural Requirements:** generate a staggered rectangular brick grid, mortar groove mask, per-brick color jitter, beveled brick edges, small chip masks, fine pore noise, and AO along all mortar seams.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Voronoi, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/brick/brick-running-bond-red.json`; bake folder `bake/materials/ceramic-brick-and-tile/brick/brick-running-bond-red/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### brick-stacked-modern - Stacked Bond Modern Brick

- **Status:** Planned
- **Goal:** Generate clean modern brickwork with vertically aligned joints.
- **Material Target:** uniform rectangular bricks in a stacked grid, crisp straight mortar lines, controlled red-brown or neutral clay colors, minimal chips, and shallow pores. The layout should feel manufactured and precise.
- **Procedural Requirements:** use an aligned grid rather than row offsets, keep mortar width consistent, use restrained per-brick color jitter, low chip density, crisp bevels, and clean high-roughness brick faces.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Tileable Noise, ColorRamp, Blend, Clamp, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/brick/brick-stacked-modern.json`; bake folder `bake/materials/ceramic-brick-and-tile/brick/brick-stacked-modern/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### brick-overfired-purple - Dark Overfired Purple Brick

- **Status:** Planned
- **Goal:** Generate dark overfired brickwork with purple, burgundy, and brown-black kiln variation.
- **Material Target:** masonry blocks with deep burgundy, dark purple, black-brown, and muted red patches, plus dark mortar grooves. Bricks should look harder and more kiln-burned than normal red brick.
- **Procedural Requirements:** combine a brick grid with strong per-brick hue variation, dark overfired cloud masks, localized blackened edges, fine pores, and darker AO in mortar grooves. Keep chips visible but not dominant.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Tileable Noise, FBM, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/brick/brick-overfired-purple.json`; bake folder `bake/materials/ceramic-brick-and-tile/brick/brick-overfired-purple/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### brick-dry-clean-pale-mortar - Dry Clean Brick With Pale Mortar

- **Status:** Planned
- **Goal:** Generate clean dry brickwork where pale mortar is a strong visual separator.
- **Material Target:** warm red and orange bricks divided by cream or pale gray mortar, with dry dusty faces, low staining, and only light corner wear. The mortar should be clearly recessed and matte.
- **Procedural Requirements:** emphasize high-value mortar, clean joint masks, subtle per-brick variation, pale dust overlays, minimal dirt, fine pore normal, and strong AO only inside the recessed joint boundaries.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/brick/brick-dry-clean-pale-mortar.json`; bake folder `bake/materials/ceramic-brick-and-tile/brick/brick-dry-clean-pale-mortar/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### brick-rough-handmade - Rough Handmade Brick

- **Status:** Planned
- **Goal:** Generate handmade brickwork with warped edges and strong individual block variation.
- **Material Target:** irregular fired-clay bricks with uneven dimensions, bowed faces, wavy mortar widths, strong red/orange/brown per-brick shifts, sandy texture, and chipped rough corners.
- **Procedural Requirements:** distort brick cell boundaries, vary brick height/width subtly, add bowed face height, dense pore noise, chipped corners, uneven mortar, and per-block color variation. The result should feel handmade, not clean modular tile.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Tileable Warp, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/brick/brick-rough-handmade.json`; bake folder `bake/materials/ceramic-brick-and-tile/brick/brick-rough-handmade/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

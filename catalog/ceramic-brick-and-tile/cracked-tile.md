# Cracked Tile

## Material Brief

- **Visual Description:** larger ceramic or stone tile surface damaged by sharp fractures, broken glaze, missing chips, and dirt-darkened breaks. The base may be white, cream, gray, black, blue, green, or terracotta, but the defining feature is a readable tile grid crossed by irregular crack lines and exposed dull underbody material. Cracks should be narrow and angular, with occasional wider missing fragments where corners or impact points have broken away.
- **Procedural Identity:** generate a large tile grid with bevels and grout, then overlay a secondary crack graph that can cross tile faces but should be clipped or dirtier near grout seams and impact centers. Add exposed-body masks along crack edges, dark dirt AO inside fractures, lifted chip lips, and roughness contrast between intact glazed faces and broken ceramic interiors.
- **Typical Channels:** non-metallic; base color combines intact tile/glaze, grout, dark crack dirt, and dull exposed ceramic or stone body; roughness low to medium on intact glaze and 0.75-1.0 inside exposed chips and cracks; strong normal/height for crack cuts, chipped lips, bevels, and grout recesses; AO strongest in fracture interiors, missing pieces, and tile seams; no emission.

## Render Tasks

### cracked-tile-hairline-glossy-floor - Hairline-Cracked Glossy Floor Tile

- **Status:** Planned
- **Goal:** Generate glossy floor tile with fine hairline cracks but mostly intact glaze.
- **Material Target:** large white, cream, gray, or dark glossy tiles with narrow angular crack lines, clean grout, and only small chips. The intact tile faces should remain reflective compared to the crack interiors.
- **Procedural Requirements:** create a large tile grid with bevels, overlay a thin crack graph, darken crack interiors, keep crack height shallow, maintain low roughness on intact glaze, and add AO inside cracks and grout.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Voronoi, Tileable Noise, ColorRamp, Blend, Invert, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-hairline-glossy-floor.json`; bake folder `bake/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-hairline-glossy-floor/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### cracked-tile-broken-old-wall - Broken Old Wall Tile

- **Status:** Planned
- **Goal:** Generate old wall tile with missing corners, damaged grout, and broken glaze.
- **Material Target:** larger wall tiles in cream, pale blue, green, or white, with broken corners, chipped edges, dirty grout, and exposed dull ceramic body around missing pieces. The surface should feel aged and used, not freshly cracked.
- **Procedural Requirements:** use tile grid and grout masks, add corner chip masks, exposed-body color, dirty grout AO, moderate crack lines, raised chip lips, and roughness contrast between glaze and exposed ceramic.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Voronoi, Tileable Noise, ColorRamp, Blend, Clamp, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-broken-old-wall.json`; bake folder `bake/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-broken-old-wall/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### cracked-tile-dirty-stoneware - Dirty Cracked Stoneware Tile

- **Status:** Planned
- **Goal:** Generate muted stoneware tile with dirt-filled cracks and matte worn glaze.
- **Material Target:** gray, tan, brown, or muted terracotta stoneware tiles with visible cracks, dark grime in fractures, worn matte faces, and dusty grout. It should feel heavier and less glossy than ceramic floor tile.
- **Procedural Requirements:** use low-saturation tile colors, large tile grid, crack graph, dark dirt masks inside cracks and grout, high roughness worn faces, exposed body along chips, and medium normal for fractures.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Voronoi, Tileable Noise, FBM, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-dirty-stoneware.json`; bake folder `bake/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-dirty-stoneware/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### cracked-tile-impact-radial - Impact-Damaged Tile

- **Status:** Planned
- **Goal:** Generate a tile surface damaged by a visible impact point with radial fractures.
- **Material Target:** large tile or tiled surface with one or more impact centers, starburst crack lines, missing chips near the impact, darker dirt in the fracture network, and exposed dull ceramic body around the break.
- **Procedural Requirements:** combine tile grid with radial crack masks, impact-center chip masks, exposed-body color, raised/lifted crack lips, strong AO in missing fragments, and roughness contrast between intact and broken areas.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Gradient, Tileable Noise, ColorRamp, Blend, Vector Math, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-impact-radial.json`; bake folder `bake/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-impact-radial/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### cracked-tile-matte-quarry - Matte Cracked Quarry Tile

- **Status:** Planned
- **Goal:** Generate matte quarry tile with dusty exposed body and cracks.
- **Material Target:** red-brown, terracotta, or dark clay quarry tiles with matte faces, sharp cracks, dusty exposed interiors, worn bevels, and dirty grout. It should be rougher and less glossy than glazed ceramic.
- **Procedural Requirements:** use a large tile grid, warm clay color ramp, crack graph, dusty exposed-body masks, high roughness, chip and bevel height, dark grout AO, and fine pore noise.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Voronoi, Tileable Noise, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-matte-quarry.json`; bake folder `bake/materials/ceramic-brick-and-tile/cracked-tile/cracked-tile-matte-quarry/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

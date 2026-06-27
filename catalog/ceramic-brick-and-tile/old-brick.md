# Old Brick

## Material Brief

- **Visual Description:** aged masonry made of worn fired-clay bricks with faded red, salmon, brown, gray, and soot-black discoloration. Mortar joints are uneven, cracked, dusty, and recessed; brick faces have eroded corners, broken edges, lime efflorescence, dark water stains, and dirt collected in cavities. The result should look older, less uniform, and more damaged than clean brickwork.
- **Procedural Identity:** start with a staggered brick grid and add age masks: desaturated per-brick color, irregular mortar width, chipped and rounded edge masks, white lime deposit streaks, soot/dirt gradients, crack lines crossing individual bricks, and strong cavity dirt in joints. Damage should cluster around edges, lower recesses, and random impact spots.
- **Typical Channels:** non-metallic; base color includes faded clay, gray dust, white mineral deposits, black soot, and dirty mortar; roughness 0.85-1.0 with no glossy glaze; stronger height variation than clean brick from eroded faces, broken corners, and rough mortar; AO very strong in joints, cracks, chips, and missing mortar pockets; no emission.

## Render Tasks

### old-brick-soot-stained-chimney - Soot-Stained Chimney Brick

- **Status:** Planned
- **Goal:** Generate old brickwork darkened by soot and heat staining.
- **Material Target:** faded red and brown bricks with black-gray soot clouds, darkest near mortar grooves and imagined vent streaks. Mortar is rough, dirty, and recessed, with small chips and heat-darkened edges.
- **Procedural Requirements:** use a staggered brick grid, soot gradient masks, dark cavity dirt, desaturated brick colors, rough mortar, chipped edges, and fine pore noise. Soot should overlay brick identity rather than fully flatten it.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Tileable Noise, FBM, ColorRamp, Blend, Bright/Contrast, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/old-brick/old-brick-soot-stained-chimney.json`; bake folder `bake/materials/ceramic-brick-and-tile/old-brick/old-brick-soot-stained-chimney/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### old-brick-sun-bleached-wall - Pale Sun-Bleached Brick Wall

- **Status:** Planned
- **Goal:** Generate old exterior brickwork faded by long sun exposure.
- **Material Target:** pale salmon, dusty orange, beige-red, and gray-brown bricks with low saturation, chalky dust, and softened worn edges. Mortar should be light and dry, with moderate recess dirt.
- **Procedural Requirements:** build a brick grid with desaturation masks, pale dust overlays, low-frequency sun fade, softened chip masks, fine pores, and reduced dark staining.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Tileable Noise, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/old-brick/old-brick-sun-bleached-wall.json`; bake folder `bake/materials/ceramic-brick-and-tile/old-brick/old-brick-sun-bleached-wall/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### old-brick-damp-lower-stains - Damp Old Brick

- **Status:** Planned
- **Goal:** Generate aged brickwork with dark damp staining and dirty lower areas.
- **Material Target:** old red-brown bricks with dark wet-looking stains collecting in lower bands, mortar grooves, cracks, and damaged pockets. The surface should remain mostly rough but have lower roughness in damp dark areas.
- **Procedural Requirements:** use a brick grid plus vertical damp gradients, dark cavity masks, rough mortar, chipped edges, water streaks, and roughness masks that make damp zones smoother than dry dusty zones.
- **Planned Nodes:** Texture Coordinate, Mapping, Gradient, Checker, Tileable Noise, FBM, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/old-brick/old-brick-damp-lower-stains.json`; bake folder `bake/materials/ceramic-brick-and-tile/old-brick/old-brick-damp-lower-stains/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### old-brick-crumbling - Crumbling Brick

- **Status:** Planned
- **Goal:** Generate heavily damaged brickwork with missing mortar and large chips.
- **Material Target:** eroded old bricks with broken corners, missing chunks, rough exposed interiors, irregular mortar gaps, and deep dark cavities. The wall should look structurally worn and gritty.
- **Procedural Requirements:** create strong chip and missing-corner masks, uneven mortar removal, deep height variation, exposed rough brick body, strong AO cavities, desaturated brick color, and dusty deposits on broken surfaces.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Checker, Tileable Noise, ColorRamp, Blend, Clamp, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/old-brick/old-brick-crumbling.json`; bake folder `bake/materials/ceramic-brick-and-tile/old-brick/old-brick-crumbling/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### old-brick-white-limed - White-Limed Brick

- **Status:** Planned
- **Goal:** Generate old brickwork with heavy white lime and efflorescence deposits.
- **Material Target:** faded brick partly covered by chalky white mineral bloom, pale lime streaks, and powder caught in mortar and cavities. Red clay should remain visible under broken or thin deposit areas.
- **Procedural Requirements:** overlay white deposit masks on a brick grid, concentrate lime in joints and downward streaks, add powdery roughness, preserve exposed brick color patches, and include small chips and dark cavity AO.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Gradient, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/old-brick/old-brick-white-limed.json`; bake folder `bake/materials/ceramic-brick-and-tile/old-brick/old-brick-white-limed/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

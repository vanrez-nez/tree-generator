# Roof Tile

## Material Brief

- **Visual Description:** repeated roofing units made from fired clay, usually orange, terracotta red, brown, or weathered ochre. Tiles may be curved barrel forms, S-shaped pantiles, or flat overlapping slabs, but they should read as rows with visible overlap shadows, raised ridges, dusty high points, darker underlaps, and rain-washed dirt streaks. Avoid vertical wall-brick mortar grids and tiny mosaic pieces.
- **Procedural Identity:** generate row-based tile repetition, overlap masks, curved ridge height fields or flat-slab bevels, dark AO under each tile lip, per-tile clay color variation, dust accumulation on ridges, and vertical dirt streaks following water flow. The layout should have a strong directional rhythm from rows and overlaps.
- **Typical Channels:** non-metallic; base color from terracotta orange-reds with brown dirt and pale dust; roughness 0.75-0.95, slightly smoother on worn ridges; strong patterned height for tile lips and curved ridges; AO deep below overlaps and in dirt-filled seams; no emission.

## Render Tasks

### roof-tile-barrel - Barrel Roof Tile

- **Status:** Planned
- **Goal:** Generate alternating curved barrel roof tiles with strong row rhythm.
- **Material Target:** terracotta barrel tiles alternating convex and concave channels, with dark overlap shadows, dusty ridges, and orange-red per-tile variation. The surface should read as roof rows, not wall brick.
- **Procedural Requirements:** create repeated curved ridge height fields, row overlap masks, dark AO under tile lips, clay color jitter per tile, dust on convex high points, and rain-direction dirt in troughs.
- **Planned Nodes:** Texture Coordinate, Mapping, Wave, Checker, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/roof-tile/roof-tile-barrel.json`; bake folder `bake/materials/ceramic-brick-and-tile/roof-tile/roof-tile-barrel/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### roof-tile-flat-shingle - Flat Shingle-Like Clay Tile

- **Status:** Planned
- **Goal:** Generate flat overlapping clay roof slabs with clear lips and row shadows.
- **Material Target:** flat terracotta roof tiles arranged in horizontal rows, with each slab slightly raised over the one below. Edges should be crisp but worn, with dusty orange-brown high areas and darker underlaps.
- **Procedural Requirements:** use row-based rectangular repetition, overlap/lip height masks, bevels, per-tile clay color variation, dirt below overlaps, and shallow pore noise. Keep ridges flatter than barrel tiles.
- **Planned Nodes:** Texture Coordinate, Mapping, Checker, Tileable Noise, ColorRamp, Blend, Clamp, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/roof-tile/roof-tile-flat-shingle.json`; bake folder `bake/materials/ceramic-brick-and-tile/roof-tile/roof-tile-flat-shingle/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### roof-tile-mossy-dusty-old - Mossy Or Dusty Old Roof Tile

- **Status:** Planned
- **Goal:** Generate old roof tile with dust, grime, and optional moss-like staining baked into the surface.
- **Material Target:** weathered terracotta roof rows with dusty ridges, dark dirty overlaps, green-brown mossy stains in protected seams, and faded orange-brown tile faces.
- **Procedural Requirements:** combine roof tile repetition with dirt masks under overlaps, moss/stain masks in seams and troughs, faded clay color, high roughness dust, and medium normal from ridges and pitting.
- **Planned Nodes:** Texture Coordinate, Mapping, Wave, Checker, Tileable Noise, FBM, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/roof-tile/roof-tile-mossy-dusty-old.json`; bake folder `bake/materials/ceramic-brick-and-tile/roof-tile/roof-tile-mossy-dusty-old/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### roof-tile-clean-new - Clean New Terracotta Roof

- **Status:** Planned
- **Goal:** Generate crisp new terracotta roof tile with strong form and minimal staining.
- **Material Target:** saturated orange-red roof tiles with clean row repetition, crisp ridges or lips, low dirt, consistent clay color, and small fine pores. It should look newly installed and orderly.
- **Procedural Requirements:** maintain regular tile spacing, clean edge bevels, subtle per-tile color variation, low pore normal, high roughness clay, and minimal AO except below overlaps.
- **Planned Nodes:** Texture Coordinate, Mapping, Wave, Checker, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/roof-tile/roof-tile-clean-new.json`; bake folder `bake/materials/ceramic-brick-and-tile/roof-tile/roof-tile-clean-new/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### roof-tile-sun-faded - Sun-Faded Roof Tile

- **Status:** Planned
- **Goal:** Generate roof tiles bleached by sun exposure with pale high points.
- **Material Target:** faded orange and pale terracotta roof rows with lighter ridges, warmer color in underlaps, dusty high points, and mild rain streaks. It should be dry and sun-worn rather than mossy or damp.
- **Procedural Requirements:** use height-linked fade masks, row overlap shadows, dust overlays on ridges, subtle water streaks, per-tile color desaturation, and medium patterned height.
- **Planned Nodes:** Texture Coordinate, Mapping, Wave, Checker, Gradient, Tileable Noise, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/roof-tile/roof-tile-sun-faded.json`; bake folder `bake/materials/ceramic-brick-and-tile/roof-tile/roof-tile-sun-faded/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

# Glazed Ceramic

## Material Brief

- **Visual Description:** colored ceramic coated by a glossy translucent-looking glaze, in saturated or muted hues such as cobalt blue, jade green, cream, black, ochre, or deep red. The surface should look hard and smooth, with subtle glaze thickness changes, darker pooling in shallow cracks, tiny pinholes, and occasional chips exposing a dull beige or red clay body. Avoid regular tile grout unless generating a tiled variant.
- **Procedural Identity:** generate a smooth base color layer, a separate glossy glaze mask, fine crackle-line graph, sparse pinhole dots, darker glaze pooling along crack intersections, and exposed-clay chip masks on edges or impact spots. Keep relief restrained except where chips cut through the glaze.
- **Typical Channels:** non-metallic; base color from glaze hue plus dull clay chip color; roughness 0.08-0.35 on intact glaze and 0.65-0.9 on exposed clay; low normal for glaze waviness, sharper normal/height in cracks and chips; AO in crackle lines, pinholes, and broken edges; no emission.

## Render Tasks

### glazed-ceramic-single-color - Single-Color Glossy Glaze

- **Status:** Planned
- **Goal:** Generate a clean glossy ceramic glaze in one dominant color.
- **Material Target:** smooth cobalt, jade, cream, black, ochre, or deep red ceramic with subtle glaze thickness clouds, tiny pinholes, and a wet-looking glossy finish. It should not include tile grout, heavy crackle, or exposed clay damage.
- **Procedural Requirements:** use one controlled glaze hue, broad low-frequency glaze pooling, very low relief waviness, sparse pinholes, and a mostly uniform low roughness mask. Keep color variation visible but restrained.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, FBM, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-single-color.json`; bake folder `bake/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-single-color/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### glazed-ceramic-crackle - Crackle-Glaze Ceramic

- **Status:** Planned
- **Goal:** Generate glossy ceramic with dense hairline crazing in the glaze.
- **Material Target:** colored glaze crossed by thin irregular crackle lines, with darker glaze or dirt pooling along cracks and slightly clearer color on unbroken islands. The ceramic body should remain mostly intact, with little to no large chipping.
- **Procedural Requirements:** build a fine crack graph, use dark crack-line masks, add roughness contrast inside cracks, keep glaze islands glossy, and add subtle pinholes. Cracks should be hairline-scale, not large broken tile fractures.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Tileable Noise, ColorRamp, Blend, Invert, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-crackle.json`; bake folder `bake/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-crackle/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### glazed-ceramic-hand-painted - Hand-Painted Glaze

- **Status:** Planned
- **Goal:** Generate a hand-applied glaze with soft color blooms and brush-like variation.
- **Material Target:** glossy ceramic where two or more glaze colors softly blend, pool, or feather into each other. Edges should feel hand-painted or dipped, with cloudy blooms rather than hard graphic stripes.
- **Procedural Requirements:** use soft masks for glaze color transitions, broad uneven color clouds, faint directional brush or drip structure, low normal waviness, and glossy roughness with darker pooling in thicker areas.
- **Planned Nodes:** Texture Coordinate, Mapping, Gradient, Tileable Noise, FBM, ColorRamp, Blend, Hue/Saturation/Value, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-hand-painted.json`; bake folder `bake/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-hand-painted/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### glazed-ceramic-chipped-utilitarian - Chipped Utilitarian Ceramic

- **Status:** Planned
- **Goal:** Generate glossy ceramic with practical wear and exposed clay chips.
- **Material Target:** durable colored glaze with small impact chips, worn rims or edges, dull beige/red clay exposed under the glaze, and dirt gathered in broken spots. It should feel used but not fully shattered.
- **Procedural Requirements:** combine a glossy glaze mask with edge/impact chip masks, exposed-clay color, high roughness on chips, dark AO inside broken edges, sparse pinholes, and restrained crackle.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, Voronoi, ColorRamp, Blend, Clamp, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-chipped-utilitarian.json`; bake folder `bake/materials/ceramic-brick-and-tile/glazed-ceramic/glazed-ceramic-chipped-utilitarian/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

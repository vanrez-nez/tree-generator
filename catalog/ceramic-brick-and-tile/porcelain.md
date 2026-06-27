# Porcelain

## Material Brief

- **Visual Description:** very clean white, ivory, or blue-white ceramic, usually #f2f1ea to #ffffff, with a dense smooth body and subtle pale gray or blue glaze clouding. The material should feel refined, thin, and hard, with almost no visible pores, no sandy clay grain, and only faint polishing marks or hairline glaze variation. Avoid saturated glaze colors, mortar, grout, and heavy chips unless explicitly generating damaged porcelain.
- **Procedural Identity:** build a near-white base with very low-contrast cloudy glaze noise, sparse ultra-fine speckles, faint polishing streaks, and optional hairline crazing at very low opacity. Keep height nearly flat so the identity comes from smoothness, brightness, and restrained glaze variation.
- **Typical Channels:** non-metallic; base color high value and low saturation; roughness 0.12-0.45 depending polish; very low normal with optional microscopic speckles or fine crazing; minimal AO except inside rare hairline cracks; no emission.

## Render Tasks

### porcelain-blue-white - Blue-White Porcelain

- **Status:** Planned
- **Goal:** Generate cool white porcelain with subtle blue shadow tint and restrained glaze clouding.
- **Material Target:** bright white to blue-white ceramic with faint cool gray-blue clouds, almost no pores, and very smooth low relief. The material should feel clean, hard, and refined.
- **Procedural Requirements:** use a high-value near-white base, low-opacity blue-gray cloud masks, tiny sparse speckles, and very low normal. Roughness should be low to medium with broad smooth variation.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, FBM, ColorRamp, Blend, Bright/Contrast, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/porcelain/porcelain-blue-white.json`; bake folder `bake/materials/ceramic-brick-and-tile/porcelain/porcelain-blue-white/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### porcelain-warm-ivory - Warm Ivory Porcelain

- **Status:** Planned
- **Goal:** Generate cream-toned porcelain with warm glaze clouds.
- **Material Target:** ivory, cream, and warm off-white ceramic with subtle cloudy glaze variation and a polished but not mirror-like finish. It should avoid saturated colors and visible clay grain.
- **Procedural Requirements:** build warm high-value base color, soft cream/yellow-gray glaze clouds, faint polishing streaks, minimal speckling, and nearly flat normal. Keep AO almost absent except in rare hairlines.
- **Planned Nodes:** Texture Coordinate, Mapping, Tileable Noise, Gradient, ColorRamp, Blend, Hue/Saturation/Value, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/porcelain/porcelain-warm-ivory.json`; bake folder `bake/materials/ceramic-brick-and-tile/porcelain/porcelain-warm-ivory/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### porcelain-antique-crazed - Lightly Crazed Antique Porcelain

- **Status:** Planned
- **Goal:** Generate old porcelain with faint glaze crazing and subtle discoloration.
- **Material Target:** off-white porcelain with thin tan-gray hairline crazing, slight yellowing in crack intersections, and soft cloudy glaze. It should read antique and delicate, not broken tile.
- **Procedural Requirements:** overlay a very fine crackle graph at low contrast, tint crack interiors tan-gray, add sparse age speckles, keep the underlying porcelain glossy, and keep height/normal subtle.
- **Planned Nodes:** Texture Coordinate, Mapping, Voronoi, Tileable Noise, ColorRamp, Blend, Invert, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/porcelain/porcelain-antique-crazed.json`; bake folder `bake/materials/ceramic-brick-and-tile/porcelain/porcelain-antique-crazed/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

### porcelain-polished - Polished Porcelain

- **Status:** Planned
- **Goal:** Generate polished porcelain with broad roughness bands and minimal visible pattern.
- **Material Target:** clean white porcelain with faint broad highlight-like bands encoded through roughness variation, very subtle gray clouding, and almost no height detail.
- **Procedural Requirements:** emphasize low roughness, broad smooth masks, low-contrast color variation, and microscopic normal only. Avoid cracks, chips, grit, grout, and visible pores.
- **Planned Nodes:** Texture Coordinate, Mapping, Gradient, Tileable Noise, ColorRamp, Blend, Levels, Normal From Height, Principled BSDF, Material Output.
- **Nodes Used:** Pending until generated.
- **Produced Files:** None yet.
- **Current Node Graph Render:** Not generated.
- **Output Contract:** config `configs/materials/ceramic-brick-and-tile/porcelain/porcelain-polished.json`; bake folder `bake/materials/ceramic-brick-and-tile/porcelain/porcelain-polished/`; expected files `config.json`, `baseColor.ours.png`, `roughness.ours.png`, `normal.ours.png`, `metallic.ours.png`, `ambientOcclusion.ours.png`, optional `preview.png`.

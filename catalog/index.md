# Procedural Material Catalog

## Purpose

This catalog defines procedural single-surface materials for a game material generator. Each entry describes a material that can be represented as baked PBR-style channels: base color, roughness, metallic, normal/height, ambient occlusion, and emission where relevant.

The category structure follows common material-library splits seen in Poly Haven, ambientCG, Adobe Substance 3D assets, and Quixel Megascans: terrain/ground, rock/stone, wood, fabric, metal, concrete, brick/tile, asphalt, snow, bark, leather, plastic, and related surface classes.

References:

- Poly Haven texture categories: https://polyhaven.com/textures/
- ambientCG category list: https://ambientcg.com/list
- Adobe Substance 3D Community Assets: https://substance3d.adobe.com/community-assets
- Quixel Megascans surfaces: https://quixel.com/megascans/?category=surface

## Scope Rules

- Include materials that can be captured as one static surface.
- Include fluids only when they can be represented as a single baked image with no motion, refraction, caustics, or view-dependent response.
- Exclude animated water, flowing lava, fire, volumetric fog, glass refraction, holograms that depend on viewing angle, and materials whose identity depends on multiple separate objects.
- Use proximity wording when helpful: "looks like marble, but..." then state the precise visual difference.
- Prefer procedural cues: grain direction, pore scale, vein width, crack frequency, scratch orientation, oxidation masks, weave spacing, chip pattern, height contrast, and color range.

## Reference Image Geometry Rule

Reference images are visual targets for procedural texture generation, not object-construction targets. Choose the reference framing based on whether the material's recognizable form can be represented by a tileable base color, roughness, normal/height, and AO bake.

- Use flat material references when the real-world object shape would require large geometry that a normal or height map cannot believably carry. Roof tiles, vessel terracotta, curved shingles, corrugated forms, thick molded pieces, raised trim, and any surface whose identity depends on deep silhouette or stacked construction should be referenced as the underlying ceramic, clay, glaze, weathering, wear, pores, staining, and color variation, not as the assembled object.
- Use composed object-pattern references only when the object layout itself is a plausible tileable surface that the graph can represent with masks, height, bevels, and normals. Brick bonds, mosaic tesserae, floor tile grids, cracked tile fields, and shallow grout layouts can include the repeated units because those forms can be baked into a plane and still read correctly.
- When in doubt, flatten the reference toward the material layer. Avoid prompts that ask for visible construction, perspective, stacked pieces, curved profiles, or large cast shadows unless that geometry is intentionally part of the procedural plane task.
- Task prompts should state this decision explicitly: either "flat material reference, no object geometry" or "tileable composed surface with shallow procedural relief." This prevents the graph from matching an image whose apparent form cannot be reproduced by the available channels.

## Reference Image Lighting Rule

Reference images should use diffuse lighting that reveals material properties without baking hard light artifacts into the texture target. Lighting is allowed and useful because it can communicate gloss, roughness, pore depth, and glaze character, but it must not dominate the image.

- Use broad, soft, diffuse studio lighting for every reference. The material may show gentle gloss response, soft sheen, and broad value changes that help judge roughness.
- Avoid hard light reflections, sharp specular streaks, bright window-shaped highlights, ring-light circles, point-light hotspots, caustic-like shapes, and strong directional shadows. These read as part of the texture when the graph tries to match the reference.
- Glossy materials such as porcelain and glazed ceramic should show their finish through soft, low-contrast reflection gradients and subtle sheen, not through crisp white highlight bands or reflected scene shapes.
- Task prompts should state "diffuse lighting only, no hard reflections" whenever the material is glossy, polished, glazed, wet-looking, or otherwise likely to produce strong highlights.

## Description Format

Each material entry uses:

- **Material Brief:** shared material identity for the family: visual description, procedural identity, and typical PBR channels.
- **Render Tasks:** a backlog of specific procedural material generation jobs. Each task defines a distinct target, planned graph approach, nodes used, produced files, current node graph render, tileability proof, and output contract.

Use [Reference Texture Generation Workflow](./reference-texture-generation.md) for the step-by-step prompt format, file structure, file formats, and task structure required when creating or updating `reference.png` assets.

Each render task must produce a tileable material. Completion requires a task output folder containing the graph `preset.json`, baked channel PNGs, a seamless tiled proof bake, and a 512x512 standard material demo render showing the material on a sphere with a plane below.

Use the app dev helper `__bakeMaterialTask(preset, outputFolder, channelSize)` for these outputs so every task reuses the same channel bake, tileability proof, and sphere-plus-plane preview setup.

## Categories

- [Ceramic, Brick, and Tile](./ceramic-brick-and-tile/)
- [Concrete, Plaster, and Masonry](./concrete-plaster-and-masonry/)
- [Earth and Ground](./earth-and-ground/)
- [Metal](./metal/)
- [Organic and Creature Surface](./organic-and-creature-surface/)
- [Stone and Mineral](./stone-and-mineral/)
- [Stylized and Non-Realistic](./stylized-and-non-realistic/)
- [Synthetic and Manufactured](./synthetic-and-manufactured/)
- [Textile and Leather](./textile-and-leather/)
- [Wood and Bark](./wood-and-bark/)

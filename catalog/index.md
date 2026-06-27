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

## Description Format

Each material entry uses:

- **Material Brief:** shared material identity for the family: visual description, procedural identity, and typical PBR channels.
- **Render Tasks:** a backlog of specific procedural material generation jobs. Each task defines a distinct target, planned graph approach, nodes used, produced files, current node graph render, and output contract.

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

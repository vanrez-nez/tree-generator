# Building a Minimal Substance Designer — Catalog + Pipeline

> Scope: an **offline node-graph texture authoring tool** that evaluates a DAG of
> image operators and **bakes** PBR channel maps. This is the powerful model.
> The "live in-shader" model is a different product — noted at the end.

---

## 1. The mental model (reduce before you build)

Substance Designer is **one idea repeated**:

> A directed acyclic graph of *image operators*. Each node is a pure function
> `out_buffers = f(in_buffers, params, seed, resolution)`. The leaf node assembles
> several grayscale/color buffers into a **coherent PBR material**.

Three consequences fall out of "pure function" and you should design around them from line one:

- **Caching** — outputs are deterministic, so every node output can be cached and reused.
- **Reproducibility** — same graph + same master seed → bit-identical result, always.
- **Dirty propagation** — changing a param invalidates only that node and its transitive descendants.

Everything else in this document is downstream of taking that contract seriously.

---

## 2. The data model — the part people get wrong first

Before any node, nail the buffer type. This is where hobby clones quietly die.

| Decision | Cheap/naive choice | What it costs you | Recommendation |
|---|---|---|---|
| **Grayscale precision** | `R8` | 256 height levels → visibly staircased normals & AO | `R16F` minimum, `R32F` for anything you accumulate into (sims, distance) |
| **Color precision** | `RGBA8` | banding in gradients, clipped HDR-ish ramps | `RGBA8` fine for basecolor; `RGBA16F` for height-derived or HDR |
| **Wrap mode** | `CLAMP` | seams everywhere; materials don't tile | `REPEAT` everywhere, non-negotiable |
| **Param units** | mix px and UV ad hoc | material changes appearance when you change output res | pick ONE convention and enforce (see §5) |

The height-precision point is the single highest-leverage thing here. **8-bit height → garbage normals**, and it's invisible until you light the surface at a grazing angle. Author height at `R16F`/`R32F`, quantize *only* on final export if you must.

**Tiling is an invariant, not a node.** Every generator must be seamless, every sampler must wrap, every noise hash must repeat at its lattice period. Retrofitting tiling later is miserable because it touches every operator. Design it in.

```glsl
// tiling-aware value-noise lattice hash: wrap integer cell coords at `period`
vec2 hash2(ivec2 c, int period) {
    c = ivec2(mod(vec2(c), float(period)));      // <-- the line that makes it tile
    uint h = uint(c.x) * 374761393u + uint(c.y) * 668265263u;
    h = (h ^ (h >> 13)) * 1274126177u;
    return vec2(float(h & 0xFFFFu), float((h >> 16) & 0xFFFFu)) / 65535.0;
}
```

---

## 3. The full node catalog

Organized by the only taxonomy that matters: **what arity the operator has and what layer it lives in.** Generators have no image input. Filters transform fields. Structure nodes create discrete regions. Conversion nodes carry PBR *semantics*. The `★` marks the **minimal spanning set** (§4).

### 3.1 Generators (0 inputs → 1 field)

**Stochastic base fields**
| Node | What it is | Primary use |
|---|---|---|
| White noise | per-pixel uniform random | dither, base for stylized grain, seed for scatter |
| Value noise | interpolated lattice randoms | cheap smooth field |
| ★ Gradient noise (Perlin/Simplex) | interpolated random *gradients* | the smooth substrate for most "natural" looks |
| ★ Cellular / Worley / Voronoi | distance-to-feature-points; F1, F2, F2−F1, cell-ID | stone, cracks, scales, the basis for region work |
| Gabor noise | sparse sum of Gaussian×sinusoid kernels | *spectral & directional* control (wood, brushed metal) |
| Blue noise | well-distributed point set (usually precomputed) | high-quality dither, even scatter seeding |

**Fractal operators** (apply over a base field — implement as a *mode* on the noise node, not separate nodes)
| Mode | Operation | Look |
|---|---|---|
| ★ FBM | Σ noise(2ⁱp)·2⁻ⁱ | clouds, organic |
| Turbulence | Σ \|noise(2ⁱp)\|·2⁻ⁱ | wispy, flame-like |
| Ridged multifractal | Σ (1−\|noise\|)²·… | mountain ridges, veins |
| Billow | Σ \|noise\|, inverted | puffy, lumpy |

**Geometric / parametric**
| Node | Notes |
|---|---|
| ★ Shape (SDF primitives) | disc, square, triangle, gradient, pyramid, cone, paraboloid, gaussian — the SDF toolbox |
| ★ Gradient | linear / radial / angular / diamond ramps |
| Brick / Tile generator | parametric wall — huge for man-made materials |
| Checker / Stripes / Weave | regular patterns |
| Polygon / Star / N-gon | shape primitives |

**Scatter**
| Node | Notes |
|---|---|
| ★ Tile Sampler | grid scatter with **per-cell** randomized pos/rot/scale/value — *the workhorse* |
| Splatter | free scatter of an input pattern N times |

### 3.2 Filters (1+ inputs → 1 field)

**Value remap (cheap, used constantly)**
| Node | What it does |
|---|---|
| ★ Levels | in-black/white/gamma → out-black/white |
| ★ Curve | arbitrary spline remap |
| ★ Histogram Scan | sliding threshold band → contrast/selection control |
| Histogram Range / Shift | reposition the value distribution |
| Quantize / Posterize | discrete steps |
| Auto Levels | normalize via histogram |

**Spatial**
| Node | Notes | Cost |
|---|---|---|
| Blur (Gaussian) | separable | 2 passes |
| ★ Slope Blur | blur *along* a guide field's gradient | the #1 weathering operator |
| Directional Blur | anisotropic smear | 1–2 passes |
| Sharpen / Emboss / Edge Detect | convolution-ish | 1 pass |
| ★ Transform 2D | affine + tiling | 1 pass |
| ★ Directional / Vector Warp | displace samples by guide / RG vector | 1 pass |
| Mirror / Symmetry | kaleidoscope | 1 pass |
| **Distance** | mask → distance field | **multi-pass (JFA)** |

**Compositing**
| Node | Notes |
|---|---|
| ★ Blend | modes (add/mul/screen/overlay/max/min/…) + opacity + **mask** — the central node, you'll use it more than all others combined |
| ★ Gradient Map | grayscale → color via ramp |
| Channel Shuffle / Split / Merge | move data between RGBA slots |
| Math | per-pixel arithmetic, dot, abs, clamp |

**Segmentation (the high-value, hard tier)**
| Node | Notes |
|---|---|
| ★ Flood Fill | label connected regions → unique cell IDs |
| Flood Fill to Random Gray/Color/BBox/Position | per-cell variation driven by the labels above |

**Simulation (iterative)**
| Node | Notes |
|---|---|
| Reaction-Diffusion (Gray-Scott) | Turing patterns; spots/stripes/coral — many ping-pong iterations |
| Hydraulic / Thermal Erosion | weathered terrain/rock; iterative sim (you're already doing erosion baking) |

### 3.3 Conversion / PBR (semantic nodes)

These are where "image" becomes "material." Quality here separates pro from hobby far more than noise choice does.

| Node | Notes |
|---|---|
| ★ Normal (from height) | Sobel/central-difference on height → tangent-space normal |
| ★ Curvature | from normal or height; drives edge wear masks |
| ★ Ambient Occlusion (from height) | cavity darkening; cheap versions look bad — this is a quality cliff |
| Bevel | distance-field → rounded edge height + normal |
| Normal Combine / Blend | layer detail normals |
| Normal → Height | Poisson solve — iterative, skip for MVP |
| ★ Material Output | collects basecolor, normal, height, roughness, metallic, AO, (emissive, opacity) |

### 3.4 Utility

Input/Output pins (expose graph params), Bitmap import, SVG import, Color/Value/Gradient params.

---

## 4. The minimal spanning set (build this first)

The `★` nodes — about **17 of them** — span ~90% of what people actually make. The compression principle from before, made concrete:

- **2 base fields**: Gradient noise (with FBM mode) + Cellular
- **2 shape sources**: Shape (SDF) + Gradient
- **1 structure system**: Tile Sampler + Flood Fill (these two are a unit — see §6)
- **value remap**: Levels, Curve, Histogram Scan
- **spatial**: Transform 2D, Directional Warp, Slope Blur
- **composite**: Blend, Gradient Map
- **PBR**: Normal, Curvature, AO, Material Output

A tool with exactly these, done well, **beats a 60-node tool that fumbles flood-fill and PBR coherence.** Most clones invert that ratio — twelve noises, no flood fill, flat materials.

---

## 5. The evaluation engine

### Node contract
A node is a small **program of GPU passes** over scratch buffers, not a single fragment shader. Drop the "one node = one shader" assumption early — it's the most common architectural mistake here. Separable blur is 2 passes, distance is `log n` passes (JFA), histogram is a reduction, reaction-diffusion is `k` ping-pong iterations. The engine must own a **scratch-buffer pool + ping-pong**, and a node declares how many passes it needs.

### Evaluation loop
```
1. Build DAG from connections; reject cycles.
2. Topological sort.
3. To realize a requested output: walk its dependency cone, evaluate
   uncached nodes in topo order.
4. Each node runs its multi-pass program, writes to its cached output FBO(s).
5. On param/connection change: mark node + transitive descendants dirty;
   re-evaluate lazily on next request.
```

### Resolution policy — decide now, enforce forever
Substance *pretends* to be resolution-independent; it isn't, because noise is sampled at buffer resolution and blur/warp radii are in pixels. Pick a convention:

- **Positions & sizes** → normalized `[0,1]` UV space (resolution-independent).
- **Pixel-radius things** (blur, warp intensity) → expressed as **fraction of resolution**, converted to px at eval time.

If you mix raw pixels and UV across nodes, a graph authored at 1K will look different baked at 4K. That bug is diffuse and maddening. One convention, enforced at the param layer.

### Seed policy
Hierarchical, deterministic, no global RNG state:
```
node_seed     = hash(node_id, master_seed)
instance_seed = hash(node_seed, instance_index)   // for scatter
```
Reseeding the whole graph = change `master_seed`. Reseeding one node = perturb its `node_id` salt.

### Caching & memory — the silent scaling wall
Every cached node output is a full-res buffer. At 2K `RGBA16F` that's ~32 MB **each**. A 40-node graph at 4K will exhaust VRAM. Two strategies:

- **Streaming eval**: reference-count buffers; free a node's output as soon as all its consumers have run within a single evaluation. Minimal memory, recompute on edit.
- **LRU cache**: keep recently-touched outputs for interactive editing; evict + recompute under pressure.

Real tools do both: stream during bake, LRU during editing.

---

## 6. Where it actually gets hard (the blind-spots section)

The catalog makes this look like a pile of fragment shaders. Three things are genuinely hard, and they're exactly the things that make materials *not* look procedural:

1. **Flood fill / connected components — the boss fight.** This is what gives every brick a slightly different color, every stone a different roughness. It's the difference between "a material" and "an obviously tiled texture." It's *hard on a GPU* (label propagation isn't a one-pass operation). Options: Jump-Flooding-based labeling, or CPU readback + union-find for small graphs. **If you implement nothing else from the hard tier, implement this** — Tile Sampler without per-cell variation is a toy.

2. **Distance transform (JFA).** Multi-pass, needed by flood fill, bevel, and any "distance from edge" mask. Once you have a correct JFA pass, several nodes fall out of it cheaply.

3. **AO / curvature quality.** The cheap central-difference versions look flat and wrong. This is a quality cliff: the same material with good vs. naive AO reads as pro vs. hobby. Budget real effort here — it's higher-leverage than adding your 6th noise type.

Secondary traps: **histogram ops need reduction passes** (or careful approximation); **normal→height is an iterative Poisson solve** (skip in MVP); **sims (reaction-diffusion, erosion) need iteration budgeting + ping-pong** and break the one-pass model entirely.

---

## 7. Build order (fastest path to a result you'd show someone)

| Phase | Deliverable | You can now make |
|---|---|---|
| 0 | Buffer (`R16F`) + single node renders to FBO + 2D preview | a noise on screen |
| 1 | DAG + topo eval + dirty + cache; hardcode 3 nodes | noise → levels → preview |
| 2 | Generators (gradient+FBM, cellular, shape, gradient) + remap (levels, curve, histogram scan) + **Blend** | organic blended grayscale |
| 3 | Spatial: Transform 2D, Directional Warp, **Slope Blur** | weathered, marbled, flowing looks |
| 4 | **Tile Sampler + Flood Fill + Distance/JFA** | brick/stone **with per-cell variation** |
| 5 | PBR: Normal, Curvature, AO, Material Output + 3D lit preview | an actual **material** |
| 6 | Polish: Gradient Map, channel ops, more shapes, sims | breadth |

Phase 4 is the hump. Everything before it is a weekend; Phase 4 is where you find out if you're building Substance or a noise viewer.

---

## 8. The one strategic warning

The temptation is to measure progress in node count. **The product value isn't nodes — it's three things:**

1. **Flood-fill-driven per-cell variation** (non-repetition)
2. **Slope-blur / warp weathering** (organic break-up of regularity)
3. **Coherent PBR derivation from shared masks** (height→normal→curvature→AO→roughness→basecolor all driven by the *same* underlying masks, never authored independently)

A clone that nails these three with 12 nodes is a real tool. A clone with 60 nodes that derives each PBR channel independently produces flat, lifeless materials and you won't know why. The "commercial secret sauce" you mentioned is overwhelmingly clever **composition graphs and masking discipline** over a small operator set — not proprietary noise math.

---

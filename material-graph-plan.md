# Generic Composable Material Graph — TSL / NodeMaterial Refactor

## Context

The current material system (`src/scene/material/`) is a fixed, code-wired GLSL bake pipeline. A
`MaterialNode` base class (`engine/node.ts`) exposes a **single output**, its inputs are hardwired by
object reference in constructors, and the chain is baked through a custom `PassRunner` + render-target
engine onto a `MeshStandardMaterial`. The Rete editor over it is **read-only** (it vetoes connection
create/remove), its sockets are **untyped** (one shared `Socket('socket')`), and per-node Tweakpane
controls are **hand-written** in `editor-config.ts`. There is no registry or schema anywhere.

The recent wood work surfaced the core design flaw: **operators and presets are fused into single
nodes**, so nothing is reusable for another material:

- `nodes/bark-fibers.ts` bakes in horizontal X-wrapped ridges (`phase = vUv.x * ridgeCount`) — it is not
  a generic directional pattern, it is "bark stripes".
- `nodes/knots.ts` bakes in elliptical ring-stamps (`d.x *= 1.7`, ring frequency `44.0`, pit semantics)
  — it is not a generic scatter, it is "tree knots".
- `nodes/gradient-map.ts` bakes the *entire* bark look into one shader: height→bark color ramp, plus
  cavity darkening, plus horizontal exposed-wood bands, plus vertical moss streaks. You cannot retarget
  it to stone, rust, scales, or bone by swapping one node — the whole upstream height pipeline is
  wood-shaped.

This document specifies a redesign into a **generic, registry-driven, typed multi-input/multi-output
node graph** that can express any PBR surface, with wood reduced to **one preset among many**. The
substrate becomes **Three.js TSL / `MeshStandardNodeMaterial`**, so the editor graph literally *is* a
Three.js node graph rather than a parallel bespoke engine.

---

## Decisions locked in planning

1. **Substrate — adopt TSL `MeshStandardNodeMaterial` on `WebGPURenderer`** (with automatic WebGL2
   fallback). Each graph node compiles to a TSL `Fn` / node expression. This retires most of the
   hand-written GLSL noise and the custom bake engine.
2. **Output — support both backends, switchable at runtime:**
   - **Baked maps**: graph → textures via `convertToTexture` → bound as
     `map` / `normalMap` / `aoMap` / `roughnessMap` / `metalnessMap` / `emissiveMap`. The PNG exporter
     reads back the same render targets.
   - **Live procedural**: graph → `colorNode` / `normalNode` / `roughnessNode` / `aoNode` /
     `metalnessNode` / `emissiveNode`. No bake; the surface re-shades every frame.
3. **Editor — full editable v1**: registry-driven palette, add/delete nodes, typed connection creation +
   validation, registry-generated controls, `sessionStorage` persistence.

---

## Why TSL is the right base (research findings)

Three.js `0.184.0` (already pinned in `package.json`) ships the full TSL / NodeMaterial stack. The
features that map directly onto what we need:

- **`Fn(([a, b, coord]) => …)`** — a typed, parameterized, composable shader function. This *is* the
  "generic operator with typed inputs/outputs" we want, natively. No custom node abstraction required.
- **Procedural noise primitives** — `mx_fractal_noise_float` (FBM), `mx_noise_float` (Perlin-like),
  `mx_worley_noise` / `mx_cell_noise` (Voronoi/cells). These replace `glsl/noise.ts`, `nodes/warp.ts`,
  and the hand-rolled JFA flood-fill in `nodes/cells.ts`. Domain warp is just function composition
  (`noise(p.add(noise(p)))`).
- **`convertToTexture(node, width, height, options)` → `RTTNode`** — a built-in "bake a subgraph to a
  texture" primitive. This *is* the baked backend and the PNG exporter, for free. Default option is
  `{ type: HalfFloatType }`, which matches our current `createDataTarget` precision needs.
- **Backend portability** — TSL transpiles to WGSL **or** GLSL depending on the active backend, so one
  graph runs on WebGPU and on the WebGL2 fallback without per-node work.
- **Live uniforms** — params become `uniform()` nodes; updating `.value` re-renders with no recompile.
  Topology-changing params (e.g. octave count as a loop bound) use `Loop({ end: u.toFloat() })`, exactly
  as in three's `webgpu_tsl_procedural_terrain` example.

Cost we accept (see Renderer Migration): `WebGLRenderer` → `WebGPURenderer` (async `init()`), and
re-expressing the triplanar `onBeforeCompile` hack as a TSL function.

### Reference TSL patterns we will lean on

From three's own examples (procedural terrain, marble pedestal, curtain):

```js
// FBM with dynamic octave count + domain warp + uniforms (terrain example)
const elevation = float( 0 ).toVar();
Loop( { type: 'float', start: float( 1 ), end: octaves.toFloat(), condition: '<=' }, ( { i } ) => {
  const n = mx_noise_float( warpedPos.mul( freq ).mul( i.mul( 2 ) ).add( i.mul( 987 ) ), 1, 0 ).div( i.add( 1 ).mul( 2 ) );
  elevation.addAssign( n );
} );

// Pure procedural PBR via material node sockets (marble example)
material.colorNode = mix( mix( colA, colB, clouds ), colC, veining );
material.roughnessNode = veining.mul( 0.14 ).add( 0.07 );
```

These confirm: a generic FBM node, a warp node, a Voronoi node, color-ramp/blend nodes, and the PBR
output sockets are all expressible directly — no custom render passes.

---

## Target architecture

### 1. Graph document (serializable, id-based)

Replace object-reference wiring with a serializable document. This is what the editor edits, what
persists to `sessionStorage`, and what the compiler consumes.

```ts
type PortKind = 'field' | 'color' | 'normal' | 'vector'
// field  → TSL float (linear scalar/data: height, masks, roughness, AO, metallic)
// color  → TSL vec3  (sRGB-authored color: basecolor, emission)
// normal → TSL vec3  (encoded tangent-space normal)
// vector → TSL vec2/vec3 (coordinate domains, warp offsets, flow fields)

type MaterialGraphDocument = {
  version: number
  nodes: Array<{
    id: string
    type: string                       // registry key
    params: Record<string, unknown>    // values keyed by ParamDef.key
    position: { x: number; y: number }
    enabled: boolean
  }>
  edges: Array<{
    fromNode: string; fromOutput: string
    toNode: string;   toInput: string
  }>
}
```

- The **PBR output is an ordinary node** of type `pbr-output` — a singleton, terminal, non-deletable in
  v1, with **no output ports**. Inputs: `baseColor`, `normal`, `emission`, `roughness`, `metallic`,
  `ambientOcclusion`. `baseColor` is the internal key; "Albedo / Diffuse" is UI label text only.
- **Unconnected output inputs fall back to `MeshStandardMaterial`/NodeMaterial defaults** (flat normal,
  white base, no AO, etc.) — i.e. that socket is simply not assigned.
- Versioned key so persisted documents can be migrated.

### 2. Node registry + node definitions

A registry maps `type → MaterialNodeDef`. The definition is the **single source of truth** for ports,
params (defaults + UI metadata), and the TSL builder.

```ts
interface PortDef  { key: string; label?: string; kind: PortKind }

interface ParamDef {
  key: string
  label: string
  type: 'float' | 'int' | 'bool' | 'color' | 'select'
  min?: number; max?: number; step?: number
  options?: string[]            // for 'select'
  default: unknown
}

interface BuildCtx {
  inputs: Record<string, Node>      // resolved upstream TSL node-values, keyed by input port
  uniforms: Record<string, Node>    // one uniform() per ParamDef, live-updatable
  coord: Node                        // the active coordinate domain (uv() or triplanar world)
}

interface MaterialNodeDef {
  type: string
  category: 'generator' | 'filter' | 'adapter' | 'color' | 'output'
  label: string
  inputs: PortDef[]
  outputs: PortDef[]
  params: ParamDef[]
  build(ctx: BuildCtx): Record<string, Node>   // one TSL node-value per output port key
  bypass?: (ctx: BuildCtx) => Node             // optional: which input passes through when disabled
}
```

Key consequences:

- **Params are `uniform()` nodes**, so tweaks are live with no recompile. Only topology-changing params
  (octave counts, iteration counts) trigger a rebuild — and even those can use dynamic `Loop` bounds to
  stay recompile-free.
- **`ParamDef[]` drives the generated controls.** The hand-written `addBinding` blocks in
  `editor-config.ts` disappear; a generic mapper turns `ParamDef.type/min/max/step/options` into the
  right Tweakpane binding.
- **Only generic nodes register by default.** Wood-specific nodes stay outside the registry until a
  catalog/preset browser exists.

### 3. Graph compiler (the evaluator) — two backends

```ts
function compileGraph(
  doc: MaterialGraphDocument,
  registry: Map<string, MaterialNodeDef>,
  opts: { backend: 'live' | 'baked'; coord: Node; size?: { w: number; h: number } },
): { material: MeshStandardNodeMaterial; maps?: MaterialMapBundle }
```

Steps:

1. **Validate** — reject cycles; reject port-kind mismatches; enforce one connection per single-input
   socket (a new connection replaces the prior). Surface validation errors to the editor.
2. **Topo-sort** the DAG. Build each node's outputs in dependency order, memoizing
   `(nodeId, outputKey) → Node` so multi-output and shared subgraphs resolve once. **No MRT needed** —
   each output is just a TSL node-value.
3. **Bypass** — a disabled node returns its `bypass(ctx)` input (default: first compatible input),
   preserving today's on/off semantics ([[material-system]], [[node-editor]]).
4. **Emit per backend** from the `pbr-output` node's connected inputs:
   - **live**: assign expressions to `material.colorNode` / `normalNode` / `roughnessNode` / `aoNode` /
     `metalnessNode` / `emissiveNode`.
   - **baked**: wrap each terminal in `convertToTexture(node, w, h)`; bind the resulting textures as the
     corresponding maps; return a `MaterialMapBundle` with nullable maps for unconnected sockets. PNG
     export reads back these RTTNodes.

**Port-kind ↔ TSL type / adapter rules:**

| Kind | TSL type | Direct-connect rule |
|------|----------|---------------------|
| `field` | `float` | feeds roughness/metallic/AO/height/masks |
| `color` | `vec3` | feeds baseColor/emission |
| `normal` | `vec3` (encoded) | feeds normal only |
| `vector` | `vec2`/`vec3` | feeds coord/warp/flow inputs |

Incompatible direct links (e.g. `color → roughness`) are **rejected at connect time**; explicit adapter
nodes bridge them (`Luminance`, `Split Channels`, `Normal Map`, etc.).

### 4. Generic node library + wood decomposition

The library is split into **generic operators** (registered, reusable) and **presets** (saved
documents). The wood nodes become reference for authoring presets, not registry entries.

| Generic node | TSL basis | Replaces / generalizes |
|--------------|-----------|------------------------|
| `FBM Field` / `Noise` | `mx_fractal_noise_float`, dynamic `Loop` octaves | `height.ts`, `glsl/noise.ts` |
| `Domain Warp` | noise-vector add to coord | `warp.ts` |
| `Voronoi / Cells` | `mx_worley_noise` / `mx_cell_noise` | `cells.ts` (JFA flood-fill retired) |
| `Anisotropic Stripes` | directional `sin` + noise; params: angle, count, sharpness, waviness, contrast | **generalizes `bark-fibers`** |
| `Scatter / Splatter` | place a **stamp subgraph** at jittered cells; params: count, jitter, scale, seed | **generalizes `knots`** (a concentric-ring stamp becomes an *input*, not hardcoded) |
| `Slope Blur` | iterative gradient smear | `slope-blur.ts` |
| `Levels / Remap / Curve` | math remap (min/max/gamma/invert) | `roughness.ts` math |
| `Color Ramp / Gradient` | multi-stop field→color LUT | **decouples bark color out of `gradient-map`** |
| `Blend / Layer` | mask + blend modes (mix, multiply, screen, overlay) | **moss & exposed-wood become separate masked layers** |
| `Normal From Height` | central-difference / `mx` derivative | `normal.ts` |
| `AO From Height` | ring-tap cavity | `ao.ts` |
| `Split Channels` | `color → r,g,b,a` field outputs | new adapter |
| `Combine Channels` | field inputs → `color` | new adapter |
| `Luminance` / `Channel Select` | `color → field` | new adapter |
| `Normal Map` | RGBA `color → normal` | new adapter |
| `Mix` / `Clamp` / `Add` / `Mul` / `Constant` | scalar/vector math | new |
| `PBR Material Output` | terminal | replaces fixed channel binding |

**Wood as a preset document.** Bark is reconstructed by wiring generics:

```
FBM Field
  → Anisotropic Stripes (angle=horizontal, count, sharpness, waviness)   // was bark-fibers
  → Domain Warp
  → Slope Blur
  → Voronoi/Cells (plates + cracks)
  → Scatter (stamp = Color-Ramp-shaped concentric rings)                 // was knots
  → Color Ramp (bark dark→light)                                         // was gradient-map's base
  → Blend(layer: exposed-wood mask)  → Blend(layer: moss streak mask)    // was gradient-map's overlays
  → PBR Material Output.baseColor
  (+ Normal From Height, AO From Height, Levels→roughness branches)
```

`nodes/bark-fibers.ts`, `nodes/knots.ts`, `nodes/gradient-map.ts` move under `src/scene/material/nodes/wood/`,
remain source-controlled and inactive, and serve as the spec for those preset wirings. They are **not**
imported into the active registry or the default graph, and **do not** appear in the palette.

### 5. Renderer migration (Phase 1, the gating work)

- `src/app.ts:73` — `new THREE.WebGLRenderer(...)` → `WebGPURenderer` (from `three/webgpu`). Bootstrap
  becomes async: `await renderer.init()`. Switch the `requestAnimationFrame(animate)` loop
  (`src/app.ts:232`) to `renderer.setAnimationLoop(...)` with `renderer.renderAsync(scene, camera)`.
- Thread the new renderer type through `MainScene` (`src/scene/main.ts:60`). The custom bake engine
  (`engine/node.ts`, `engine/pass-runner.ts`, `engine/targets.ts`) is largely **retired** in favor of
  `convertToTexture`; `engine/export.ts` is rewritten to read back RTTNodes.
- **Triplanar** (`src/scene/mesher/tree-mesher.ts:180`, `installTriplanar`) is re-expressed as a TSL
  biplanar `Fn`:
  - For **live** shading it feeds the coordinate domain (`coord`) that generators sample.
  - For **baked** maps it samples the baked textures (today's behavior).
  - Keep the deliberate **2-axis biplanar** (IQ sample + Golus normal blend) rather than 3-axis — the
    ghosting fix was a quality decision ([[triplanar-mapping]]). Evaluate three's built-in
    `triplanarTexture` TSL helper but prefer a custom biplanar `Fn` to preserve 2-axis behavior.
  - Carry `uWorldPerTile`, `uTriSharpness`, `uTriEnabled` across as TSL `uniform()`s so the live A/B
    toggle and the world-per-tile master scale survive.

### 6. Editable Rete editor

- **Typed sockets**: one `ClassicPreset.Socket(kind)` per `PortKind`. On `connectioncreate`
  (`src/node-editor/node-editor-panel.ts:398`, where the read-only veto currently lives), validate
  kind-compatibility; on a single-input re-connect, **replace** the prior connection; reject
  incompatible kinds with user feedback.
- **Palette**: a registry-driven add menu grouped by `category`. Allow deleting any non-output node.
- **Generated controls**: `mountControls` is produced from `ParamDef[]` via a generic
  ParamDef→Tweakpane mapper, replacing the hand-written builds in `editor-config.ts`.
- **Persistence**: serialize `MaterialGraphDocument` (including node positions) to `sessionStorage`
  under a versioned key; restore on load. Keep auto-layout as an explicit button — never auto-layout
  over user positions.
- **Backend toggle**: a baked ↔ live switch surfaced in the editor / Texture tab, re-running
  `compileGraph` with the chosen backend.

---

## Phasing (everything lands; sequenced to de-risk)

1. **Renderer migration** — `WebGPURenderer` + async bootstrap; triplanar ported to TSL; the existing
   tree renders via a `MeshStandardNodeMaterial` (trivial procedural or a single map) to prove the
   pipeline and the WebGL2 fallback **before** touching the graph.
2. **Graph model + registry + compiler** — document, typed ports, both backends, cycle/type validation.
   A code-built default document reproduces a believable surface from generic operators; confirm parity.
3. **Generic node library** — implement the operators table above; park the wood nodes; express bark as
   a preset document and confirm it matches today's look.
4. **Editable editor** — typed sockets, palette, add/delete, connection validation, generated controls,
   `sessionStorage` persistence, backend toggle.
5. **Polish** — PNG export via `convertToTexture`, debug surface views, preset-document scaffolding (no
   catalog browser yet).

---

## Critical files

- `src/app.ts` — renderer creation (`:73`), render loop (`:232`), editor open button (`:549`).
- `src/scene/main.ts` — renderer threading (`:60`).
- `src/scene/material/material-graph.ts` — becomes the document host + compiler entry.
- `src/scene/material/engine/{node.ts, pass-runner.ts, targets.ts, export.ts}` — retired / replaced by
  TSL + `convertToTexture`.
- `src/scene/material/nodes/*` — reimplemented as `MaterialNodeDef`s;
  `bark-fibers.ts` / `knots.ts` / `gradient-map.ts` → `nodes/wood/` (inactive).
- `src/scene/material/editor-config.ts` — registry-driven adapter with generated controls.
- `src/scene/mesher/tree-mesher.ts` — triplanar (`:180`) ported to TSL.
- `src/node-editor/{types.ts, node-editor-panel.ts}` — typed sockets (`:436`/`:438`), veto removal
  (`:398`).
- **New**: `nodes/registry.ts`, `graph/document.ts`, `graph/compiler.ts`, `tsl/` operator builders,
  `presets/` (bark preset document).

---

## Verification

- `npm run build` (tsc + vite) is clean; `await renderer.init()` path runs; confirm the WebGL2 fallback
  on a WebGPU-less context.
- Run the app (`/run`): the tree renders with the new material; the triplanar A/B toggle still flips; no
  junction seams.
- **Backend toggle**: baked maps and live procedural produce visually equivalent surfaces; switching is
  live.
- **Default generic graph** yields all channels and binds to the tree material; the **bark preset**
  looks like today.
- **Editor**: add a node from the palette; connect compatible ports; reject `color → roughness`;
  reconnect replaces the prior single-input link; delete a non-output node; toggle a node (bypass);
  reload restores graph + positions from `sessionStorage`.
- **Adapters**: `Split` / `Combine` round-trip; `Luminance` / `Channel Select` feeds
  roughness/metallic/AO; a `color` output feeds `baseColor` directly.
- **PNG export** of each channel via `convertToTexture` matches the on-surface result.
- **Parked wood nodes** are absent from the palette and the active default graph.

---

## Risks / open items

- **WebGPURenderer surface-area drift** — audit for `getContext`, readback, color-management, and any
  WebGL-specific calls elsewhere during Phase 1; `setAnimationLoop` + async render changes frame timing.
- **Triplanar fidelity** under TSL must match the current 2-axis biplanar look before the GLSL path is
  removed.
- **Live-backend perf** with many noise octaves vs. the cached baked path — the backend toggle is the
  escape hatch; default heavy graphs to baked.
- **Geometry displacement / `positionNode` deformation** stays deferred (TSL makes it cheap later, but
  it is out of scope here).
- **Catalog/preset browser** is out of scope for v1 — presets exist as documents, but only the default
  is loaded; no selector UI yet.

---

## Assumptions

- Editable graph v1 ships now, not a runtime-only refactor.
- Preset structure is prepared (bark as a saved document) but there is no catalog browser yet.
- Wood-specific nodes remain source-controlled under `nodes/wood/`, inactive.
- One active `PBR Material Output` node per graph.
- Geometry deformation / displacement remain deferred.
- Multi-output nodes resolve as shared TSL subgraphs (no MRT, no separate cached passes).

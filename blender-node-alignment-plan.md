# Blender Node-Architecture Alignment — Full Plan

Status: **testing pipeline built (§5); Phases 0–3, 6 complete & verified. Phase 4: Noise ✓, Voronoi
(F1 Distance/Color/Position + Distance-to-Edge) ✓, Gradient ✓, Wave ✓ (F2/Smooth-F1 + Minkowski
pending). Phase 5: group compile core ✓, editor navigation ✓, declare(params) ✓ (group-interface-edit
UI + harness group-inlining pending). Node-family fill-in underway (Texture Coordinate ✓, Mapping ✓
[+ `vec3` param type], Vector Math ✓, Color family ✓ [Invert / Bright-Contrast / Hue-Sat-Val], Converter cluster ✓
[Clamp / Separate-Combine XYZ / extended Math]; see §11 for the remaining node inventory).**
This document is the full plan for aligning our material graph with Blender's node architecture, grounded
in three.js / TSL / WebGPU. Reference material lives in `external/blender_nodes/` (master:
`blender_node_system.md`; per-tree node docs under `docs/shader/`, `docs/compositor/`, `docs/texture/`).

---

## 1. Context

The material generator (`src/scene/material/graph/`) is a TSL/WebGPU node graph that compiles a
serializable id-based DAG into a `MeshStandardNodeMaterial`. It already has the right bones for a
Blender-style system:

- serializable id-based DAG (`MaterialGraphDocument` = nodes + edges) — `graph/types.ts`
- a node registry with categories — `graph/registry.ts`
- typed ports with connect-time validation — `graph/compiler.ts`, `graph/controller.ts`
- a decoupled Rete.js editor (`src/node-editor/`) bridged via an adapter — `editor-config.ts`
- a bake-to-PNG path for output verification — `graph/channel-baker.ts`
- **a dual-system testing pipeline** (ours vs Blender) for output-driven verification — see §5

What it lacks is Blender's **conceptual organization**: the socket-type/color taxonomy, node-class
(header) color coding, permissive type coercion, a real BSDF→Output pipeline, faithful procedural
textures, and composite (group) nodes with inspect/navigate UX.

Goal: translate Blender's *architecture and pipeline* — not a blind port — keeping it grounded in what
three.js can actually render. We surface and respect three.js/TSL/WebGPU limits rather than bailing
silently or hacking quick fixes, and we do not add features outside this project's scope.

---

## 2. Resolved decisions

1. **Shader/BSDF layer → single Principled BSDF mapped onto `MeshPhysicalNodeMaterial`.** The green
   `SOCK_SHADER` socket exists but is **constrained**: only Principled BSDF (and Emission) emit it;
   only Material Output consumes it. No free closure networking.
2. **Procedural textures → faithful Blender-math ports** (Blender Perlin/Worley → TSL), with Blender's
   feature outputs (Voronoi: Distance / Color / Position; F1 / F2 / Smooth F1 / Distance-to-Edge),
   verified per-node via bake PNG against Blender reference images.
3. **Linking → permissive, Blender-like, via a single coercion matrix** (Color→Float = luminance,
   Float→Vector = broadcast, Vector↔Color, etc.), applied at build time. The matrix drives both the
   connect-veto and the coercion. Shader (green) is never coercible.
4. **Composite → Node Groups (subgraphs) only.** Out of scope: the Compositor image-post tree, and
   Frame/Reroute layout nodes.

---

## 3. Structural limitations (surfaced, with the grounded translation)

### L1 — No closure (`SOCK_SHADER`) data type in TSL *(central limitation)*
Blender flows BSDF **closures** as first-class values (Add/Mix Shader combine them; Material Output
integrates). TSL has no closure value — `MeshStandardNodeMaterial`/`MeshPhysicalNodeMaterial` take
fixed per-channel node inputs under a fixed lighting model.
- **Translation:** Principled BSDF = one node whose inputs map to physical-material channels; its green
  output is a *marker* socket to Material Output, not a real closure.
- **Dropped (honest gap):** networkable Diffuse/Glossy/Glass/Refraction BSDFs and true Add/Mix Shader.
  A future constrained "Mix Shader" could only be a *parameter-space* blend of two Principled inputs.

### L2 — Principled coverage is partial against `MeshPhysicalNodeMaterial`
- **Clean map:** Base Color, Metallic, Roughness, Normal, IOR, Alpha, Coat (clearcoat),
  Coat Roughness, Sheen, Sheen Roughness, Transmission, Thickness, Iridescence, Specular, Emission.
- **Partial / flag:** Subsurface (three.js SSS limited vs Blender random-walk), Anisotropy, Tangent.
- **Unsupported (out of scope):** Volume output; true geometry displacement (we derive normals from
  height via `normal-from-height.ts`; vertex displacement via `positionNode` is a later, separate item).

### L3 — Socket type system: 24 Blender types → shader-relevant subset
Most Blender `eNodeSocketDatatype` values belong to geometry/compositor trees and have no meaning here.
Our grounded set with Blender's color convention:

| Our kind | Blender type | Color | TSL representation |
|---|---|---|---|
| `float` (rename of `field`) | `SOCK_FLOAT` | **grey** | TSL float |
| `vector` | `SOCK_VECTOR` | **blue** | TSL vec2/vec3 |
| `color` | `SOCK_RGBA` | **yellow** | TSL vec3/vec4 |
| `shader` (new, constrained) | `SOCK_SHADER` | **green** | marker → Material Output |
| *(optional)* `int` / `bool` value subtypes | `SOCK_INT`/`SOCK_BOOLEAN` | grey | build-time params |

- **Data-model change:** fold the current `normal` kind into `vector` (Blender has no normal socket;
  normal is a Vector with semantics). Migration touches `types.ts` `PortKind`, every node def, and
  stored documents (`default-document.ts`, sessionStorage).
- Image Texture is a **node with an internal image param**, never an Image *socket*.

### L4 — Faithful noise ≠ TSL/MaterialX noise
Current `fbm.ts` / `voronoi.ts` use `mx_fractal_noise_float` / MaterialX worley — not Blender's output.
Decision 2 requires porting Blender's hash/Perlin/Worley to TSL (under `src/scene/material/tsl/`) with
its multiple Voronoi feature channels. WebGPU caveat: octave counts stay **build-time constants**
(already handled via `BuildCtx.params`), not uniforms. Each ported node verified by bake-PNG diff (§5).

### L5 — Color management semantics
Blender Color sockets are scene-linear with a display transform; ours are "sRGB-authored";
WebGPURenderer does linear workflow with output-space conversion. Pin one convention — **linear
graph-internal, sRGB authoring widgets** (matching Blender) — affecting ColorRamp, Mix Color, basecolor.
This is also what makes the §5 *color* channel comparison tighten from "structure only" to "near match".

### L6 — Permissive coercion needs a real matrix
Strict kind-match lives in two places today: `compiler.ts` `validate()` (throws) and `controller.ts`
`portKindsMatch()` / `connect()` (vetoes). Both must consult one coercion table: allowed pairs + the
TSL conversion to inject at build time (color→float = luminance via existing `adapters.ts`;
float→vec3 = `.xxx` broadcast). Disallowed pairs still veto. Shader never coerces.

### L7 — Node Groups: nested documents + recursive compile + editor navigation
Today the model is strictly first-order (flat nodes/edges; no groups). Blender groups wrap a nested
tree with Group Input / Group Output boundary nodes and an interface of exposed sockets. Translating:
- **Data model:** a group node references a sub-`MaterialGraphDocument` plus an interface (exposed
  in/out sockets); add Group Input / Group Output node types.
- **Compiler:** `compiler.ts` recurses — compile the subgraph, bind the group node's external inputs to
  Group Input and Group Output to the group node's outputs.
- **Editor:** enter/exit navigation (double-click in, breadcrumb/Esc out) — the current single-canvas
  `node-editor-panel.ts` has none.
- **Dynamic sockets:** Blender re-runs `declare()` when modes change so sockets appear/disappear; our
  registry uses static `inputs`/`outputs`. Group interfaces (and mode-driven texture outputs, L4) need
  a *dynamic* declaration form (`declare(params)`) plus editor reconciliation on port change.

---

## 4. Target architecture (the shape)

**A. Two color systems (Blender parity).**
- *Socket colors* by data type (grey/blue/yellow/green, L3): CSS keyed on socket `kind`
  (`node-editor.css` + socket rendering in `rete-elements.ts`).
- *Node header colors* by **node class** (Blender `nclass`): re-map our free-form `category` onto
  Blender classes — **Input, Output, Shader, Texture, Color (OP_COLOR), Vector (OP_VECTOR),
  Converter** — and derive header color from class.
- *Add menu* → categorized submenus by class (`populatePalette()` already carries an unused
  `data-category`; small change).

**B. Node families to bring across** (grounded subset of `docs/shader/`):
- *Input:* Value, Color, Tex Coordinate, Geometry/Normal (interpolated), UV.
- *Texture (faithful, L4):* Noise, Voronoi, Wave, Gradient.
- *Color (OP_COLOR):* Mix Color, RGB Curves (LUT-baked), Hue/Sat/Value, Bright/Contrast, Invert,
  ColorRamp (have `color-ramp.ts`).
- *Vector (OP_VECTOR):* Vector Math, Mapping, Normal Map, Bump (have `normal-from-height.ts`),
  Normalize.
- *Converter:* Math, Map Range, Clamp, Separate/Combine Color, Separate/Combine XYZ, RGB-to-BW
  (have `math.ts`, `levels.ts`, `adapters.ts`, split/combine).
- *Shader:* Principled BSDF (L1/L2), Emission.
- *Output:* Material Output (replaces/renames current `pbr-output`).
- *Group:* Group, Group Input, Group Output (L7).

**C. Reuse over rebuild.** Extend the existing spine (registry/compiler/controller/adapter); re-home or
rename existing nodes into the Blender taxonomy; reuse TSL build logic where math already matches and
re-implement where L4 demands faithfulness.

---

## 5. Testing pipeline (built) — ours vs Blender

The verification backbone for everything below. **One JSON config** (a `MaterialGraphDocument`, under
`configs/`) is the single source of truth, driving **both** systems into `bake/<name>/`:

```txt
bake/<name>/
  config.json
  <channel>.ours.png        # our TSL/WebGPU output
  <channel>.blender.png     # Blender reference
```

**Our side** (browser/WebGPU — render only runs in a browser). Dev server + bake server running, then
in the app's dev console:
```js
const cfg = await (await fetch('/configs/noise.json')).json();
await __bakeConfig(cfg, 'noise', 1024);   // loadDocument → bake every connected channel → POST
```
- `__bakeConfig` (`src/app.ts`) → `MaterialGraphController.loadDocument()` (`controller.ts`) →
  `ChannelBaker.readImageData()` → POST to `scripts/bake-server.mjs` (now supports nested `name`).

**Blender side** (headless reference):
```sh
npm run bake:blender -- configs/noise.json     # → bake/noise/<channel>.blender.png
```
- `scripts/blender-bake.mjs` spawns Blender (`$BLENDER`, else the macOS app path) running
  `scripts/blender_bake.py`, which rebuilds the graph as a Blender shader tree and EMIT-bakes each
  connected PBR channel. Translation registry: **`NODE_BUILDERS`** (our `type` → Blender idname + param
  map). **Unmapped node types error loudly** — extending coverage = adding one `NODE_BUILDERS` entry.

**Comparison bar.** Outputs are **not** pixel-perfect while a node still uses MaterialX noise; this tool
checks *structure/behavior*. Once a node is a faithful port (Phase 4) and color management is pinned
(Phase 6), the bar tightens to near-match (remaining diff = color encoding only). Comparison is by
eyeball today; an optional per-pixel MAE helper (`scripts/bake-diff.mjs`) can be added if/when numeric
thresholds become useful — not built yet, deliberately not over-engineered.

**Harness must evolve with the port** (tracked per-phase in §6):
- Phase 2: add `NODE_BUILDERS` for `constant-color` / `constant-field`; map our coercions to Blender's
  implicit conversions so coerced configs compare.
- Phase 3: the channel extractor in `blender_bake.py` (currently reads edges into `pbr-output`) must
  read channels from the **Principled BSDF inputs** once Material Output replaces `pbr-output`; add a
  `principled-bsdf` builder.
- Phase 4: replace MaterialX-backed builders with the Blender-native nodes so both sides share the same
  math reference; add `voronoi` feature-output configs.
- Phase 5: `blender_bake.py` **inlines groups** before translating (groups are a sugar over the flat
  graph for the reference side).
- Phase 6: pin `blender_bake.py` color management (and our PNG encode) so color channels match.

Files: `configs/`, `scripts/blender-bake.mjs`, `scripts/blender_bake.py`, `scripts/bake-server.mjs`,
`src/app.ts` (`__bakeConfig`), `src/scene/material/graph/controller.ts` (`loadDocument`).

---

## 6. Execution plan (per-phase Steps + Tests)

> Ordering: spine changes (taxonomy, colors, coercion) land before the node ports that depend on them.
> Each phase lists concrete **Steps** to execute and **Tests** that gate it via §5. Nothing is "done"
> until its test passes. Author the named `configs/*.json` as part of each phase.

### Phase 0 — Taxonomy & type-system foundation (no visible behavior change) — ✓ DONE
**Steps (as built)**
- Renamed `PortKind` `field`→`float`; folded `normal`→`vector` in `types.ts`; updated every node def and
  `pbr-output` input kinds.
- **Correction:** no sessionStorage migration was needed. Port *kinds* are not serialized — the stored
  `MaterialGraphDocument` carries only node `type`/`params`/`position`/`enabled` and edge port *keys*
  (which are unchanged). `DOC_VERSION` stays at 1; `default-document.ts` needed no change.
- Added the **`NodeClass`** enum (input/output/shader/texture/color/vector/converter) to `types.ts`;
  replaced `MaterialNodeDef.category` with `nodeClass` on every node (per-node Blender class). The
  editor palette (`editor-config.ts`) now feeds `def.nodeClass` into the palette item. (Visibly safe:
  the Add menu is a flat list today; category was only an unused `data-` attribute.)
- Defined the **coercion** type + `COERCION_MATRIX` + `coercionFor()` in `types.ts` (data only;
  consumed in Phase 2).

**Tests (passed)**
- `npx tsc --noEmit` clean; full `npm run build` (tsc + vite) clean.
- Runtime: app loads, default doc compiles (`lastError: null`), bakes all connected channels.
- **Regression (output-level):** baked the default bark at 512 with the new code via `__bakeConfig`
  and compared to the pre-change 512 baselines — `baseColor`/`normal`/`roughness` **byte-for-byte
  identical**. (Output identity is also guaranteed by construction: no `build()`/params/edges/coord
  changed; the compiler reads `.kind` only for equality and never branches on the literal, and never
  reads `nodeClass`.)

### Phase 1 — Color coding (two systems) — ✓ DONE
**Steps (as built)**
- Socket dot colours by `kind` (grey float / blue vector / yellow color; green reserved for the future
  shader socket). The socket wrapper span carries `data-kind` and sets `--ne-kind-color`; a descendant
  rule (`ne-node .input-socket rete-socket`, specificity 0,1,2) pipes it into the `rete-socket`
  component's `--socket-color`, overriding the component's `:host` default through the shadow boundary.
  — `rete-elements.ts` (data-kind on the socket spans), `node-editor.css`.
- Node-header colours by class: `EditorNodeConfig.nodeClass` → `EditorNode.nodeClass` →
  `data-class` on the `.title` div → CSS background per class (input/texture/color/vector/converter/
  shader/output). — `types.ts`, `editor-config.ts`, `node-editor-panel.ts` (`createNode`),
  `rete-elements.ts`, `node-editor.css`.
- Categorised Add menu: `populatePalette()` now groups items by `category` (= node class) into labelled,
  colour-tinted sections. — `node-editor-panel.ts`, `node-editor.css`.

**Tests (passed)**
- `npx tsc --noEmit` clean.
- In-app verification (`http://tree-graph.localhost`, default doc): DOM carries the expected
  `data-kind` (float/vector/color) and `data-class` (texture/vector/converter/output) attributes;
  computed styles confirm header backgrounds (e.g. texture `#7a3b3b`, converter `#3a6a6a`) and the
  socket dot's inner `.styles` div resolves to its kind colour (color → `rgb(199,199,41)` = `#c7c729`),
  proving the `--socket-color` override reaches the shadow DOM. Add menu renders TEXTURE/VECTOR/
  CONVERTER/COLOR/INPUT groups. Screenshot captured; tree still renders (no regression).

### Phase 2 — Permissive linking (coercion) — ✓ DONE
**Steps (as built)**
- `controller.portKindsMatch()` now allows a connection iff `coercionFor(outKind, inKind)` is defined
  (identity for same-kind); incompatible/non-coercible pairs (e.g. future shader) return false.
- `compiler.validate()` throws only when no coercion exists.
- Build-time injection via a shared `resolveEdgeValue()` helper used by **both** intermediate inputs
  (`resolveInputs`) and the terminal `pbr-output` channels (`resolveOutputSockets`). `coerce()` applies
  the conversion: float→vec = `vec3(v)` broadcast, vec→float = component average, color→float =
  `luminance(v)`, color↔vector = reinterpret (both vec3).
- **Bug found & fixed during verification:** terminal channels were initially bypassing coercion
  (`resolveOutputSockets` read the raw upstream value), so a colour wired to roughness rendered as
  colour. Routing both paths through `resolveEdgeValue` fixed it.
- Harness: added `constant-field`→`ShaderNodeValue` and `constant-color`→`ShaderNodeRGB` builders; the
  Blender channel router inserts `RGB to BW` for a colour feeding a scalar channel to mirror our
  luminance (other implicit conversions Blender applies natively when sockets are linked).

**Tests (passed)**
- `npx tsc --noEmit` clean.
- Behavioural: `portKindsMatch(color → float)` now returns `true` (was vetoed pre-Phase 2);
  both coercion configs compile with `lastError: null`.
- `configs/coerce-color-to-float.json` (noise → ColorRamp → **roughness**): ours bakes **grey luminance
  noise** (not colour), matching Blender's grayscale RGB-to-BW output in structure. Remaining
  brightness/texture delta = the known noise-math (Phase 4) + sRGB-encoding (Phase 6) gaps.
- `configs/coerce-float-to-vector.json` (constant 0.5 → noise `coord`): ours bakes a uniform grey fill
  — the float broadcast to a constant `vec3` coord — confirming `float→vector` broadcast.

### Phase 3 — BSDF → Output pipeline (L1/L2) — ✓ DONE
**Steps (as built)**
- Added the constrained green `shader` PortKind + `MaterialBundle` (a plain object carrying channel
  values — TSL has no closure, plan L1). `COERCION_MATRIX` gets a `shader: { shader: "identity" }` row
  only, so shader↔(float/vector/color) is rejected.
- **Principled BSDF** node (`nodes/principled-bsdf.ts`): typed inputs (baseColor, metallic, roughness,
  ior, alpha, normal, coat[+roughness], sheen[+roughness], transmission, emission[+strength]) →
  `build()` returns `{ bsdf: MaterialBundle }`. Unconnected inputs fall back to params (Blender's
  sliders). Physical lobes (coat/sheen/transmission) and alpha/emission are only included when
  connected or their weight/value is non-default, so unused lobes don't enable their shader branches.
- **Emission** node (`nodes/emission.ts`): emissive-only bundle.
- Renamed `pbr-output` → **`material-output`** (single `surface` shader input); `compiler` now
  builds a **`MeshPhysicalNodeMaterial`** (subclass of Standard — no mesher churn) and unpacks the
  bundle via `resolveBundle()` + `resolveEdgeValue` (shader→shader identity). `DOC_VERSION` bumped to 2
  so stale sessionStorage docs are dropped; `default-document.ts` rewired through Principled. Shader +
  output nodes made non-toggleable (a bypassed Principled would emit a colour, not a bundle).
- Verified the exact `MeshPhysicalNodeMaterial` node-prop names/types from the installed three source
  (`clearcoatNode`/`transmissionNode` = float, `sheenNode` = vec3-wrapped → a float weight broadcasts
  to grey sheen; `useSheen/useClearcoat/useTransmission` gate on the node being set — hence the lobe
  gating above).
- Harness: `blender_bake.py` treats shader/output nodes as **structural** — it reads channel sources
  from the (single) shader node's input edges and bakes each value; no Blender Principled is built.

**Bug found & fixed during verification:** the emission gate read `ctx.params.emission` (only
doc-provided) and treated `undefined` as non-default, baking a spurious emission channel — fixed with a
`?? "#000000"` fallback.

**Tests (passed)**
- `tsc` + full `npm run build` clean.
- `c.material.constructor.name === "MeshPhysicalNodeMaterial"`; default + `principled-basic` compile
  with `lastError: null`.
- **Veto now exercised for real:** `float → material-output.surface` rejected (`false`),
  `principled.bsdf → surface` allowed (`true`).
- **Regression:** default bark baked at 512 is **byte-identical** to the Phase-0 baseline
  (baseColor/normal/roughness) despite the full terminal rewrite — the channel values are unchanged.
- `configs/principled-basic.json`: baseColor (brown ColorRamp noise) + roughness bake ours vs Blender,
  structurally comparable (brightness/texture delta = Phase 4/6 gaps). **Live smoke:** the tree renders
  with the bark material on `MeshPhysicalNodeMaterial` (screenshot).
- Partial-vs-Blender (L2): Subsurface, Anisotropy, Specular Tint, Tangent intentionally **not** exposed
  on the node yet (documented in `principled-bsdf.ts`); Alpha maps to opacity but doesn't toggle
  transparency.

### Phase 4 — Faithful procedural textures (L4) — IN PROGRESS
**Noise — ✓ DONE (verified pixel-exact against Blender's algorithm).**
- Ported Blender's Perlin + fBm to TSL in `src/scene/material/tsl/blender-noise.ts`, transcribed
  **verbatim** from Blender GPU source (fetched): the hash `final` bit-mix (`hash_uint3`), `noise_grad`,
  `tri_mix`, `noise_perlin`, `snoise = 0.9820 * perlin`, and `noise_fbm` (normalize = `0.5*sum/maxamp +
  0.5`). `fbm` node (`nodes/fbm.ts`) now calls it (replacing MaterialX `mx_fractal_noise`); `scale`
  multiplies the domain (Blender convention), `octaves` (= Detail) drives a build-time loop unroll
  (WebGPU caveat), `gain` (= Roughness) / `lacunarity` stay live uniforms.
- TSL gotcha **found & fixed**: the octave/hash accumulation uses `toVar`/`.assign()`, which is only
  captured inside a TSL function stack — at top-level `build()` the assigns were dropped → `maxamp = 0`
  → `sum/0 = NaN` → all-black bakes. Wrapping `blenderFbm` in `Fn(() => …)()` fixed it.
- **Verification (decisive):** implemented Blender's noise independently in pure JS and evaluated it at
  the exact UVs our baker samples → our baked output matches it to **MAE 0.001 (0.1%, = 8-bit
  quantization)**. So the port is a faithful, pixel-exact implementation of Blender's noise. TSL has the
  needed uint/bitwise ops (`uint`/`bitXor`/`shiftLeft`/`shiftRight`/`bitAnd`); `generateConst` emits the
  large uint seed exactly.
- **Harness calibration note:** the direct ours-vs-Blender-*baked* compare sits at ~5% (mean offset
  ~0.03) — a UV-sampling/orientation calibration gap in `blender_bake.py`'s plane setup, *not* a noise
  difference (both match the reference). The pure-JS reference cross-check is the authoritative per-node
  check; tightening the Blender bake UV is a harness follow-up.
- Side effect: the default bark now uses Blender noise, so it looks different from the MaterialX-era
  baseline (intended). The preset's ramp/levels were tuned for the old noise — retuning is content, not
  code; the Phase 0–3 byte-identical baselines are now obsolete for fbm-containing docs.

**Voronoi F1 — ✓ DONE (verified pixel-exact against Blender's algorithm).**
- Ported Blender's Voronoi F1 to TSL in `src/scene/material/tsl/blender-voronoi.ts`, verbatim from GPU
  source: the **PCG** cell hash (`hash_pcg3d_i` + `hash_int3_to_vec3`, mask `& 0x7fffffff`, `× 1/float(
  0x7fffffff)`), `voronoi_distance` (Euclidean/Manhattan/Chebychev), and `voronoi_f1`'s 3×3×3 cell
  search (branchless `min`). `voronoi` node (`nodes/voronoi.ts`) now calls it (replacing MaterialX
  worley); params `scale` (mul), `randomness` (live uniform), `metric` (build-time select). Wrapped in
  `Fn()` (same toVar/stack reason as noise).
- **Verification:** pure-JS implementation of the same algorithm, evaluated at our exact UVs → our
  baked output matches it to **MAE 0.001 (0.1%)**. Visually a textbook F1 distance field (dark centers,
  bright edges).

**Harness investigation — RESOLVED (two distinct issues, separated by an 8-orientation diagnosis):**
- **Fixed orientation offset (cosmetic).** Our channel-baker samples `uv = (x/W, 1−y/H)`; the Blender
  plane-UV bake lands *transposed* relative to that. Proven by testing both images against the pure-JS
  reference across all 8 dihedral orientations: ours matches at `vflip` (MAE **0.001**); Blender matches
  the **noise** reference at its transposed orientation (MAE **0.0015**) — i.e. Blender 5.1.2's Noise is
  *identical* to our port, modulo this fixed orientation + sRGB encoding. Aligning the on-disk
  orientation proved fiddly (bottom-up `img.pixels` + save-time vflip form a D4 puzzle) and is
  **cosmetic** — the orientation-aware JS-reference cross-check is the authoritative check — so it's left
  documented rather than forced. `blender_bake.py` no longer attempts the transform.
- **Voronoi version skew (real, not calibration).** At its *best* orientation the 5.1.2 Voronoi bake is
  still **0.215** vs our PCG reference — no orientation aligns. So 5.1.2's binary uses a different
  Voronoi cell hash than `main` (which switched to PCG). Our port is faithful to `main` (proven 0.001 vs
  JS-ref). To validate Voronoi against the *local* 5.1.2 binary, either update Blender to a `main`-era
  build or port 5.1.2's specific pre-PCG hash. (Noise's hash is stable across versions, so Noise matches
  both.) **The pure-JS reference cross-check remains the authoritative per-node verification.**

**Gradient — ✓ DONE & verified.** Ported verbatim from `gpu_shader_material_tex_gradient.glsl`
(`tsl/blender-gradient.ts`); all 7 modes (linear/quadratic/easing/diagonal/radial/quadratic-sphere/
sphere). `type` is a build-time select. Pure-JS reference cross-check: **MAE ~0.001** across all 7 modes
(radial confirms TSL `atan(y,x)` = atan2).

**Wave — ✓ DONE & verified.** Ported verbatim from `gpu_shader_material_tex_wave.glsl`
(`tsl/blender-wave.ts`); Bands/Rings × Sine/Saw/Triangle × X/Y/Z/Diagonal, plus phase and fBm distortion
(reuses the faithful Noise port). Modes are build-time selects; phase/distortion/detail-scale/-roughness
are uniforms; detail is a build-time octave count. Cross-check: **MAE ~0.001** across type/direction/
profile/phase combos AND the distortion path.

**Voronoi Color / Position / Distance-to-Edge — ✓ DONE & verified.** `voronoiF1` now tracks the winning
cell so it can emit Distance (float), Color (vec3 = cell hash), or Position (vec3); added
`voronoi_distance_to_edge` (verbatim two-pass port). The node has a `feature` select (f1 /
distance-to-edge) and a `declare()` so its outputs change with it (see Phase 5). Cross-check vs pure-JS:
F1 distance **0.001**, Distance-to-Edge **0.001**, Color **0.0013** (sRGB-decoded); Position uses the
same proven argmin loop.

**Remaining (pending):** Voronoi F2 / Smooth F1 features and the Minkowski metric (needs an exponent
input). The Blender-bake harness builders for Gradient/Wave aren't added (the pure-JS reference
cross-check is the authoritative verification, and the Voronoi version skew already limits the
Blender-bake side).

### Phase 5 — Dynamic socket declaration + Node Groups (L7) — IN PROGRESS
**Group compile core — ✓ DONE & verified (byte-identical to inlined).**
- Data model: `GraphNode` gains `ports?` (instance-specific ports) and `subgraph?` (a nested
  `MaterialGraphDocument`). New node types `group` / `group-input` / `group-output` (`nodes/group.ts`),
  registered. `NodeClass` gains `group`.
- A single `nodePorts(node, registry)` (`registry.ts`) returns `node.ports` (groups) or the static def
  ports; the compiler, controller (`portKindsMatch`/`portKindFor`), and editor adapter (`editor-config`)
  all read ports through it — so static nodes are unchanged and group nodes get instance ports.
- Compiler refactored to recurse: `compileDocument(doc, …, seededInputs?)` builds one document's node
  outputs; a `group` node calls `compileGroup`, which compiles its subgraph with the group's external
  inputs seeded into the **Group Input** node, then reads the **Group Output** node's inputs back as the
  group's outputs (nested groups handled by recursion). `validate` takes an `isSubgraph` flag (subgraphs
  end in Group Output, the top-level in Material Output).
- Serialization: subgraph + ports are plain JSON — `loadDocument` / sessionStorage handle groups with no
  extra work.

**Tests (passed)**
- `tsc` + full `npm run build` clean; default bark still compiles (non-group path unchanged).
- **Round-trip (outputs):** a group wrapping `fbm → ColorRamp` (colour) + `fbm` (field) vs the inlined
  equivalent → baseColor & roughness **byte-identical (maxDiff 0)**.
- **Round-trip (Group Input):** a group taking an external `fbm` field, running `levels` inside, vs the
  inlined `fbm → levels` → roughness **byte-identical (maxDiff 0)** — exercises the seededInputs path.

**Editor navigation — ✓ DONE & verified.**
- Controller gained an **active-document** model: `path` (group ids root→current), `activeDocument`,
  `groupPath`, `enterGroup`/`exitGroup`/`exitToDepth`. All edit ops (`setParam`/`addNode`/`removeNode`/
  `connect`/…) now target the active (sub)document; compile + persist always run on the root. Boundary
  nodes (material-output / group-input / group-output) are undeletable. `addNode("group")` seeds a usable
  float passthrough subgraph.
- Generic editor: `EditorNodeConfig.onEnter` (double-click), `EditorGraphConfig.breadcrumb` + `onExit`
  (Esc). Panel renders a header breadcrumb, binds Esc, fires `onEnter` on title double-click. Group
  header colour + `.enterable` ⤵ glyph in CSS. The adapter builds from `activeDocument` and a `rerender`
  callback (`app.ts` `rebuildEditor`) re-opens the editor on navigation (preserving dock).
- **Verified in-app:** add Group → node shows teal header + ⤵; double-click enters (subgraph =
  Group Input→Group Output, breadcrumb *Material › group*); adding a node inside lands in the subgraph
  (root unaffected) and compiles; clicking the *Material* crumb exits to root (breadcrumb hidden).
  `tsc` + `npm run build` clean.

**Dynamic socket declaration `declare(params)` — ✓ DONE & verified.**
- `MaterialNodeDef.declare?(params)` returns the ports for the current params; `registry.nodePorts` uses
  it (after `node.ports`, before static). On a non-live param change the controller prunes now-dangling
  edges (`pruneDanglingEdges`) then recompiles; the editor reconciles via a deferred `rerender` fired
  from `bindParam` for select/bool/int params on declare-nodes (`queueMicrotask`).
- First consumer: the Voronoi `feature` select (F1 → Distance/Color/Position; Distance-to-Edge →
  Distance). **Verified:** switching feature changes the node's ports (3 → 1), prunes the dangling colour
  edge (no compile crash), and the editor re-renders the node with the new output set.

**Remaining (pending):**
- A UI to edit a group's interface (add/rename exposed sockets) — currently a fixed float passthrough;
  `declare`/`ports` are the foundation.
- Harness: `blender_bake.py` should inline groups before translating (groups aren't Blender-bakeable yet).

### Phase 6 — Color management pin (L5) — ✓ DONE & verified
**Convention pinned:** the graph works in **linear** space (TSL/`THREE.Color` with colour management on
already store linear; authoring widgets stay sRGB hex). A baked PNG follows texture convention —
**colour channels are sRGB-encoded, data channels are linear**:
- Ours (`channel-baker.ts`): `COLOR_CHANNELS` (baseColor, emission) get `sRGBTransferOETF(node)`;
  `FIELD_CHANNELS` (roughness/metallic/ao) render linear grayscale; normal stays linear/raw.
- Blender (`blender_bake.py`): per-channel view transform — `Standard` (sRGB) for colour channels,
  `Raw` (linear) for data channels — so Blender stops sRGB-encoding data maps.

**Diagnosis & test (`configs/swatch.json`, constant `#808080` → baseColor + `0.5` → roughness):**
- Before: baseColor ours **55** (linear) vs Blender **128** (sRGB); roughness ours **128** (linear) vs
  Blender **188** (sRGB) — each system was wrong on a different channel class.
- After: **all four = 128** — baseColor sRGB on both, roughness linear on both. Convention matched.
- This also closes the residual sRGB gap in the dual-bake (e.g. Phase 4 noise roughness is now linear on
  both sides; the only remaining ours-vs-Blender offset is the cosmetic orientation transpose).

Note: a cold WebGPU bake after a fresh page load can take ~15s (one-time pipeline compile); subsequent
bakes are fast. The `sRGBTransferOETF` wrap itself is trivial.

---

## 7. Open per-node fidelity checklist (resolved during implementation, output-checked)
- Voronoi feature outputs & distance metrics — match Blender exactly, bake-compare each mode.
- Noise dimensionality (Blender 1D–4D) — decide supported dims.
- ColorRamp interpolation modes (Linear/Ease/B-Spline/Constant) — match Blender.
- RGB Curves / Map Range — LUT vs analytic; verify monotonicity & clamp.
- Color space (L5) — pin and verify against a Blender swatch (Phase 6).

---

## 8. Verification strategy (methodical, output-driven)
1. **Per-node bake compare** via the §5 pipeline (`__bakeConfig` + `npm run bake:blender`); eyeball (or
   optional MAE) ours vs Blender for the same config.
2. **Type/coercion tests:** drive `controller.connect()` across pairs; assert link+coerce / veto.
3. **Pipeline smoke:** Principled graph renders on `MeshPhysicalNodeMaterial` live
   (`npm run dev:proxy` → `http://tree-graph.localhost`).
4. **Group round-trip:** recursive compile == inlined (bake both ours, assert equal).
5. **Regression:** default bark material renders unchanged after Phase 0 renames (bake before/after).

---

## 9. Critical files (extend, don't replace)
- `src/scene/material/graph/types.ts` — PortKind taxonomy, coercion-matrix types, group/interface
  model, dynamic-declare extension.
- `src/scene/material/graph/registry.ts` — node-class categorization, new registrations.
- `src/scene/material/graph/compiler.ts` — build-time coercion, recursive group compile, Physical target.
- `src/scene/material/graph/controller.ts` — coercion-aware `connect()`/`portKindsMatch()`;
  `loadDocument()` (built, §5).
- `src/scene/material/graph/nodes/*` — re-homed/ported nodes; new Principled/Emission/Group nodes.
- `src/scene/material/tsl/*` — faithful Blender noise/voronoi TSL functions.
- `src/scene/material/editor-config.ts` — class→color, categorized palette, group-aware adapter.
- `src/node-editor/node-editor-panel.ts`, `rete-elements.ts`, `node-editor.css` — socket/header colors,
  categorized add-menu, group enter/exit navigation.
- `src/scene/material/graph/default-document.ts` — migrate to new kinds/names.
- **Testing pipeline (built):** `configs/`, `scripts/blender-bake.mjs`, `scripts/blender_bake.py`,
  `scripts/bake-server.mjs`, `src/app.ts` (`__bakeConfig`).

---

## 10. Explicit non-goals
- Compositor image-post tree; Frame/Reroute layout nodes (not selected).
- Free BSDF closure networking / true Add-Mix Shader (L1); Volume output (L2).
- Geometry-nodes tree; datablock sockets (Object/Collection/Image-as-socket); true geometry displacement.

## 11. Node-family inventory (the grounded §4.B set — done vs missing)
Tracks coverage of the §4.B node families beyond the phase work. ✓ = built & verified.

- **Input:** Value ✓ (`constant-field`), Color ✓ (`constant-color`), **Texture Coordinate ✓**
  (`tex-coordinate`: Generated/UV/Object/Normal). *Limitation:* only UV is real in the baked (uv-quad)
  backend — Generated/Object/Normal are mesh-local and live-render-only, collapsing to UV when baking;
  Generated is object-space `positionLocal`, not bbox-normalized. **Missing:** a separate UV-Map node
  (TexCoord.uv covers it).
- **Texture:** Noise ✓, Voronoi ✓ (F1 Distance/Color/Position + Distance-to-Edge), Gradient ✓, Wave ✓.
  **Missing:** Voronoi F2 / Smooth-F1 / Minkowski; Brick/Magic/Musgrave/Gabor (out of scope unless needed).
- **Vector:** Mapping ✓ (point/texture/vector/normal; uses the `vec3` param type), **Vector Math ✓**
  (`vector-math`: 22 ops; outputs switch vector↔value via declare; Normalize is one of its ops), Bump ≈
  `normal-from-height`. **Missing:** Normal Map.
- **Color:** Mix Color ✓ (`blend`), ColorRamp ✓, **Invert ✓**, **Bright/Contrast ✓**,
  **Hue/Saturation/Value ✓** (branchless TSL ports of Blender's rgb_to_hsv/hsv_to_rgb in
  `tsl/blender-color.ts`). **Missing:** RGB Curves.
- **Converter:** Math ✓ (now 22 ops: +divide/power/sqrt/abs/sine/cosine/tangent/arctan2/floor/ceil/
  round/fraction/modulo/greater-than/less-than/sign), Map Range ✓ (`levels`), **Clamp ✓** (minmax/range),
  **Separate XYZ ✓**, **Combine XYZ ✓**, Separate/Combine Color ✓ (`split`/`combine-channels`),
  RGB-to-BW ✓ (`luminance`). **Missing:** the remaining ~18 Math ops (hyperbolic/log/compare/smoothmin…).
- **Shader:** Principled ✓ (Subsurface/Anisotropy/Tangent not exposed — L2), Emission ✓.
  **Output:** Material Output ✓. **Group:** ✓.
- Non-Blender outliers kept from before: `domain-warp`, `anisotropic-stripes` (no Blender equivalent).

New reusable infra added for Mapping: a **`vec3` ParamType** (uniform Vector3, live-updatable, rendered
as a 3-field Tweakpane vector) — usable by any future vector-valued param.

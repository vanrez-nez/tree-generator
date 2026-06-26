# Blender Node-Architecture Alignment — Full Plan

Status: **testing pipeline built (§5); Phase 0 complete & verified; Phases 1–6 pending.** This document
is the full plan for aligning our material graph with Blender's node architecture, grounded in
three.js / TSL / WebGPU. Reference material lives in `external/blender_nodes/` (master:
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

### Phase 1 — Color coding (two systems)
**Steps**
- Socket colors by `kind` (grey/blue/yellow/green) — `node-editor.css`, socket rendering in
  `rete-elements.ts`.
- Node header colors by class — `editor-config.ts` passes class/color into `EditorNodeConfig`;
  `rete-elements.ts` + CSS render it.
- Categorized Add-menu submenus by class — `node-editor-panel.ts` `populatePalette()`.

**Tests** (editor chrome — visual, not the bake harness)
- App visual check (`npm run dev:proxy` → `http://tree-graph.localhost`): socket dots and node headers
  match Blender's color conventions; Add menu groups by class. Capture a screenshot for the record.

### Phase 2 — Permissive linking (coercion)
**Steps**
- Replace strict checks in `controller.ts` (`portKindsMatch`/`connect`) and `compiler.ts` (`validate`)
  with coercion-matrix lookups; inject the TSL conversion at build time (reuse `adapters.ts` luminance;
  add broadcast/swizzle helpers).
- Harness: add `NODE_BUILDERS` for `constant-color` / `constant-field`; ensure Blender's implicit
  conversions mirror ours.

**Tests**
- Author `configs/coerce-color-to-float.json` (constant-color → roughness) and
  `configs/coerce-float-to-vector.json`. Bake both sides; confirm the coercion (luminance / broadcast)
  produces matching structure.
- Veto check (console): `controller.connect()` on a disallowed pair returns `false`; shader pair never
  coerces.

### Phase 3 — BSDF → Output pipeline (L1/L2)
**Steps**
- Add **Principled BSDF** node mapping inputs → `MeshPhysicalNodeMaterial` channels; switch compiler
  target from `MeshStandardNodeMaterial` → `MeshPhysicalNodeMaterial`.
- Add **Emission** node; rename `pbr-output` → **Material Output** consuming the green Shader marker;
  wire the constrained green socket (only Principled/Emission → Material Output).
- Harness: update `blender_bake.py` channel extractor to read from **Principled inputs** (Material
  Output replaces `pbr-output`); add a `principled-bsdf` builder.

**Tests**
- Author `configs/principled-basic.json` (noise → ColorRamp → Base Color; noise → Roughness; →
  Principled → Material Output). Live smoke: renders on `MeshPhysicalNodeMaterial` in-app.
- Bake compare baseColor/roughness ours vs Blender Principled.
- Partial channels (Subsurface/Anisotropy) surfaced explicitly in the node UI (manual check).

### Phase 4 — Faithful procedural textures (L4) — core harness use
**Steps**
- Port Blender Perlin/Worley to TSL (`src/scene/material/tsl/`): **Noise** first, then **Voronoi**
  (Distance/Color/Position; F1/F2/Smooth F1/Distance-to-Edge), then **Wave**, **Gradient**.
- Mode-driven outputs need the dynamic-declare form (Phase 5) or an interim static output superset —
  decide per node, record in the registry.
- Harness: swap MaterialX-backed `NODE_BUILDERS` to the Blender-native nodes so both sides share the
  reference math.

**Tests** (the bar tightens here — faithful ports should *closely* match)
- Per node/mode: author `configs/noise.json` (exists), `configs/voronoi-f1.json`,
  `configs/voronoi-smoothf1.json`, etc. Bake ours vs Blender; **expect near-match** (remaining diff =
  color encoding, fixed in Phase 6). No node ships until its comparison holds.

### Phase 5 — Dynamic socket declaration + Node Groups (L7)
**Steps**
- Extend `MaterialNodeDef` with a `declare(params)` form; reconcile editor ports on change.
- Nested document model: group node references a sub-document + interface; add Group Input / Group
  Output node types; recursive compile in `compiler.ts`.
- Editor enter/exit navigation (double-click in, breadcrumb/Esc out) in `node-editor-panel.ts`.
- Harness: `blender_bake.py` inlines groups before translating.

**Tests**
- Author `configs/group-roundtrip.json` (a group) and `configs/group-inlined.json` (its flattened
  equivalent). Bake both **ours**; assert byte-identical (recursive compile == inlined).
- Serialize/deserialize the nested doc; enter/exit works in the editor (manual).

### Phase 6 — Color management pin (L5)
**Steps**
- Pin linear graph-internal + sRGB authoring widgets; audit ColorRamp / Mix Color / basecolor wiring.
- Harness: align `blender_bake.py` color management and our PNG encode so color channels are comparable.

**Tests**
- Author `configs/swatch.json` (known constant colors). Bake ours vs Blender; **color channels now
  match** within encoding tolerance. Re-run Phase 4 color-output configs and confirm they tightened.

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

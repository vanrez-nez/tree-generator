# Blender Node-Architecture Alignment — Full Plan

Status: **planning / not approved for execution.** This document is the full plan for aligning our
material graph with Blender's node architecture, grounded in three.js / TSL / WebGPU. Reference
material lives in `external/blender_nodes/` (master: `blender_node_system.md`; per-tree node docs under
`docs/shader/`, `docs/compositor/`, `docs/texture/`).

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
(already handled via `BuildCtx.params`), not uniforms. Each ported node verified by bake-PNG diff.

### L5 — Color management semantics
Blender Color sockets are scene-linear with a display transform; ours are "sRGB-authored";
WebGPURenderer does linear workflow with output-space conversion. Pin one convention — **linear
graph-internal, sRGB authoring widgets** (matching Blender) — affecting ColorRamp, Mix Color, basecolor.

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

## 5. Phased implementation plan

> Each phase ends with an output-driven check (bake PNG and/or live render). Nothing is "done" until
> its output is verified. Phases are ordered so the spine changes land before the node ports that
> depend on them.

### Phase 0 — Taxonomy & type-system foundation (no visible behavior change)
- Rename `PortKind` `field`→`float`; fold `normal`→`vector` in `types.ts`. Update every node def and
  migrate `default-document.ts` + sessionStorage loader.
- Introduce the **node class** enum (Input/Output/Shader/Texture/Color/Vector/Converter) and attach a
  class to each existing node def (replacing/aliasing the free `category`).
- Define the **coercion matrix** type and table in `types.ts`.
- *Verify:* existing default bark material still compiles and renders unchanged (regression).

### Phase 1 — Color coding (two systems)
- Socket colors by `kind` (grey/blue/yellow/green) — `node-editor.css`, `rete-elements.ts`.
- Node header colors by class — `editor-config.ts` passes class/color into `EditorNodeConfig`;
  `rete-elements.ts` + CSS render it.
- Categorized Add menu submenus by class — `node-editor-panel.ts` `populatePalette()`.
- *Verify:* visual check in app (`npm run dev:proxy` → `http://tree-graph.localhost`); socket/header
  colors match Blender's conventions.

### Phase 2 — Permissive linking (coercion)
- Replace strict checks in `controller.ts` (`portKindsMatch`/`connect`) and `compiler.ts` (`validate`)
  with matrix lookups; inject the TSL conversion at build time (reuse `adapters.ts` luminance, add
  broadcast/swizzle helpers).
- *Verify:* connect every type-pair in the editor — allowed pairs link + coerce correctly; disallowed
  pairs veto; shader never coerces. Bake a coerced graph and confirm expected output.

### Phase 3 — BSDF → Output pipeline (L1/L2)
- Add **Principled BSDF** node mapping inputs to `MeshPhysicalNodeMaterial` channels; switch the
  compiler target from `MeshStandardNodeMaterial` to `MeshPhysicalNodeMaterial`.
- Add **Emission** node; rename `pbr-output` → **Material Output** consuming the green Shader marker.
- Wire the constrained green Shader socket (only Principled/Emission → Material Output).
- *Verify:* build textures→color/vector→Principled→Output; confirm live render with expected channels;
  flag partial channels (Subsurface/Anisotropy) explicitly in the node UI.

### Phase 4 — Faithful procedural textures (L4)
- Port Blender Perlin/Worley math to TSL (`src/scene/material/tsl/`): **Noise**, **Voronoi**
  (Distance/Color/Position; F1/F2/Smooth F1/Distance-to-Edge), then **Wave**, **Gradient**.
- Requires the dynamic-declare form (mode-driven outputs) from Phase 5 prerequisite, or a static
  superset of outputs as an interim — decide per node, recorded in the registry.
- *Verify:* bake each node/mode to PNG and diff against a Blender screenshot with identical params.
  No node ships until it matches.

### Phase 5 — Dynamic socket declaration + Node Groups (L7)
- Extend `MaterialNodeDef` with a `declare(params)` form; reconcile editor ports on change.
- Nested document model: group node references a sub-document + interface; add Group Input / Group
  Output node types; recursive compile in `compiler.ts`.
- Editor enter/exit navigation (double-click in, breadcrumb/Esc out) in `node-editor-panel.ts`.
- *Verify:* group round-trip — a group's output equals its inlined equivalent; serialize/deserialize
  the nested document; enter/exit works.

### Phase 6 — Color management pin (L5)
- Pin linear graph-internal + sRGB authoring widgets; audit ColorRamp/Mix Color/basecolor wiring.
- *Verify:* bake a known swatch and compare to a Blender reference swatch.

---

## 6. Open per-node fidelity checklist (resolved during implementation, output-checked)
- Voronoi feature outputs & distance metrics — match Blender exactly, bake-compare each mode.
- Noise dimensionality (Blender 1D–4D) — decide supported dims.
- ColorRamp interpolation modes (Linear/Ease/B-Spline/Constant) — match Blender.
- RGB Curves / Map Range — LUT vs analytic; verify monotonicity & clamp.
- Color space (L5) — pin and verify against a Blender swatch.

---

## 7. Verification strategy (methodical, output-driven)
1. **Per-node bake compare** via `channel-baker.ts` / bake server; visual diff vs Blender screenshot.
2. **Type/coercion tests:** drive `controller.connect()` across all pairs; assert link+coerce / veto.
3. **Pipeline smoke:** Principled graph renders on `MeshPhysicalNodeMaterial` live
   (`npm run dev:proxy` → `http://tree-graph.localhost`).
4. **Group round-trip:** recursive compile == inlined; serialize/deserialize nested doc.
5. **Regression:** default bark material still compiles/renders after Phase 0 renames.

---

## 8. Critical files (extend, don't replace)
- `src/scene/material/graph/types.ts` — PortKind taxonomy, coercion-matrix types, group/interface
  model, dynamic-declare extension.
- `src/scene/material/graph/registry.ts` — node-class categorization, new registrations.
- `src/scene/material/graph/compiler.ts` — build-time coercion, recursive group compile, Physical target.
- `src/scene/material/graph/controller.ts` — coercion-aware `connect()`/`portKindsMatch()`.
- `src/scene/material/graph/nodes/*` — re-homed/ported nodes; new Principled/Emission/Group nodes.
- `src/scene/material/tsl/*` — faithful Blender noise/voronoi TSL functions.
- `src/scene/material/editor-config.ts` — class→color, categorized palette, group-aware adapter.
- `src/node-editor/node-editor-panel.ts`, `rete-elements.ts`, `node-editor.css` — socket/header colors,
  categorized add-menu, group enter/exit navigation.
- `src/scene/material/graph/default-document.ts` — migrate to new kinds/names.

---

## 9. Explicit non-goals
- Compositor image-post tree; Frame/Reroute layout nodes (not selected).
- Free BSDF closure networking / true Add-Mix Shader (L1); Volume output (L2).
- Geometry-nodes tree; datablock sockets (Object/Collection/Image-as-socket); true geometry displacement.

# Material baking pipeline

The GPU renders the material graph in the browser, so to get channels/renders out as files they are
POSTed to a small local **bake server** that writes them under `./bake/` (gitignored).

- Start it alongside the dev server: `npm run bake:server` (listens on `http://127.0.0.1:8788`).
- Dev server: `npm run dev` (or `npm run dev:proxy` → `http://tree-graph.localhost`).

There are two ways to drive a bake:

- **[`/export-bake` POST route](#export-bake-post-route)** — automated/headless; POST an arbitrary
  document and get the full channel + render set on disk. **Preferred for scripting/agents.**
- **[Dev-console handles](#dev-console-handles)** — `__*` helpers exposed in dev builds, driven from the
  app's console against the live tree material.

Contents:

- [Bake server endpoints](#bake-server-endpoints)
- [`/export-bake` POST route](#export-bake-post-route)
  - [Payload reference](#payload-reference)
  - [`render` options](#render-options)
  - [Lighting profiles](#lighting-profiles)
  - [Output layout](#output-layout)
- [Dev-console handles](#dev-console-handles)
- [Batch preset generation with an agent](#batch-preset-generation-with-an-agent)
- [Dual-system testing (ours vs Blender)](#dual-system-testing-ours-vs-blender)

---

## Bake server endpoints

`scripts/bake-server.mjs` (`npm run bake:server`), port `8788` (`BAKE_PORT` overrides), CORS-open. Writes
under `<repo>/bake/`.

| Method / path | Purpose |
|---|---|
| `POST /save?name=<path>` | Write the request body to `bake/<path>` (`name` may nest with `/`; sanitized, no traversal). |
| `POST /export-bake` | Submit a bake job (see below). Held open until the worker reports a result (~180 s timeout). |
| `GET /export-bake/stream` | SSE stream the `/export-bake` worker tab connects to (internal). |
| `POST /export-bake/result` | Worker reports a finished job (internal). |
| `GET /` or `/compare` | HTML gallery comparing `bake/<name>/*.ours.png` against `external/renders/<name>.png`. |
| `GET /img?path=<rel>` | Serve a file under `bake/` or `external/renders/`. |

---

## `/export-bake` POST route

An isolated app route that bakes an **arbitrary `MaterialGraphDocument`** with **no tree/floor scene and
no Tweakpane**. Because the GPU bake only runs in the browser (and a browser tab can't listen for HTTP),
it is a relay: you POST the document to the bake server, which pushes it over SSE to an open
`/export-bake` tab that bakes it and posts the result back.

1. Start the bake server + dev server.
2. Open **`/export-bake`** in a browser (e.g. `http://tree-graph.localhost/export-bake`). It boots an
   isolated renderer and connects — the status log shows `connected to bake server — waiting for POST
   jobs`. Leave the tab open; it is the persistent **worker** (one at a time — last connection wins; jobs
   run sequentially).
3. POST the document. The request blocks until the bake finishes and returns the written channels:

   ```sh
   curl -X POST http://127.0.0.1:8788/export-bake \
     -H 'content-type: application/json' \
     -d "$(jq -n --slurpfile d src/scene/material/presets/bark.json \
            '{name:"bark", size:512, doc:$d[0]}')"
   # → {"id":1,"ok":true,"name":"bark","channels":["baseColor","normal","roughness","metallic"]}
   ```

A POST with **no** worker tab open returns `503`. An invalid `doc` (missing `nodes`/`edges`) returns
`400` and writes nothing.

> Convenience: visiting `/export-bake?preset=<key|all>[&size=&channels=]` runs a one-shot bake of
> built-in registry presets at startup (still requires the bake server).

### Payload reference

`POST /export-bake` body:

| Field | Type | Default | Notes |
|---|---|---|---|
| `doc` | `MaterialGraphDocument` | — (required) | The graph to bake. Must have `nodes` + `edges` arrays. |
| `name` | `string` | `"on-the-fly"` | Output folder under `bake/`. May nest with `/` (e.g. `materials/earth-and-ground/cracked-clay`). |
| `size` | `number` | `1024` | Channel resolution (px, square). Rounded to a multiple of 64 (readback alignment). |
| `channels` | `string[]` | all connected | Subset of `baseColor, normal, emission, roughness, metallic, ambientOcclusion`. Unconnected channels are skipped. |
| `overwrite` | `boolean` | `false` | If `false` and `bake/<name>` exists, a numeric postfix is appended at the end (`bark` → `bark-01` → `bark-02`, …). If `true`, writes into `bake/<name>` in place. The response `name` is the folder actually written. |
| `render` | `object` | see below | Demo render config (lighting profiles). |

### `render` options

`render` global defaults apply to every profile; `render.profiles` selects/overrides which profiles to
render.

| Field | Type | Default | Notes |
|---|---|---|---|
| `size` | `number` | `512` | Render px (square), rounded to a multiple of 64. |
| `samples` | `number` | `4` | MSAA. WebGPU supports 4× or off, so `≥2 → 4×`, else off. |
| `shadows` | `boolean` | `true` | Soft PCF shadow (sphere casts onto the plane). |
| `background` | `string` | `"#181818"` | CSS hex background color. |
| `environmentIntensity` | `number` | `0` | IBL (RoomEnvironment PMREM) strength; `0` = no environment. |
| `scale` | `number` | `1` | UV tiling — repeat the material N× across the sphere/plane. |
| `profiles` | `Array<string \| RenderProfile>` | all built-ins | A string selects a built-in; an object overrides/extends one. |

A `RenderProfile` object (used inside `profiles`) accepts: `name` (output stem, required) plus any of
`lightPosition:[x,y,z]`, `lightIntensity`, `ambientStrength`, `environmentIntensity`, `shadows`,
`background`, `size`, `samples`, `scale`. Resolution precedence (low → high):
**hard defaults → `render` globals → built-in profile → per-entry override**.

Examples:

```jsonc
// Render only two built-ins, tiled 2×:
"render": { "scale": 2, "profiles": ["standard", "metallic"] }

// Custom raking light + near-zero ambient on a single profile:
"render": { "profiles": [ { "name": "normals", "lightPosition": [8, 0.4, 0], "ambientStrength": 0.02 } ] }
```

### Lighting profiles

Each rendered profile writes `renders/<name>.png`. Built-ins (default set = all four), with their tuned
values (everything else falls back to the global/hard defaults above):

| Profile | Purpose | `lightPosition` | `lightIntensity` | `ambientStrength` | `environmentIntensity` | `shadows` | `background` |
|---|---|---|---|---|---|---|---|
| `standard` | Balanced key + fill, soft shadow. | `[3,4,5]` | `3.0` | `0.35` | `0` | on | `#181818` |
| `normals` | Low raking light reveals the **normal-map surface relief**. | `[6,0.9,1.2]` | `3.4` | `0.06` | `0` | off | `#101010` |
| `metallic` | Adds an **IBL environment** so metallic surfaces read reflective (not black). | `[3,4,5]` | `1.0` | `0.1` | `1.3` | on | `#202024` |
| `ao` | Ambient-dominant, no shadow, so baked **ambient occlusion** darkening reads. | `[0,6,2]` | `0.25` | `1.1` | `0` | off | `#202020` |

Notes:
- The IBL environment (RoomEnvironment PMREM) is built once per bake, only when a profile needs it.
- `metallic` keeps the doc's **baked metalness** — a dielectric stays matte; the environment just makes
  real metal read.
- Tiling relies on the baked channel targets being `RepeatWrapping`, so `scale > 1` repeats seamlessly.

### Output layout

Each bake writes under `bake/<name>/`:

```txt
bake/<name>/
  preset.json                 # the source document
  channels/<channel>.png      # one per connected channel
  renders/tiled-2x2.png       # 2×2 tile of the baseColor channel (seam check)
  renders/standard.png        # one render per lighting profile …
  renders/normals.png
  renders/metallic.png
  renders/ao.png
```

---

## Dev-console handles

Exposed only in dev builds (`import.meta.env.DEV`), on the normal app route. They bake off the **live tree
material** (or an explicit document) and POST to the same bake server.

| Handle | Signature | Writes |
|---|---|---|
| `__savePng(channel, size?)` | bake one channel of the live tree graph | `bake/<channel>.png` |
| `__bakeConfig(doc, name?, size?)` | bake every connected channel of a document | `bake/<name>/config.json` + `bake/<name>/<channel>.ours.png` |
| `__bakeMaterialTask(doc, folder, size?, channels?, render?)` | full task: preset + channels + tiled proof + profile renders | `bake/<folder>/…` (see [output layout](#output-layout)) |
| `__baker.readImageData(_renderer, controller, channel, size?)` | low-level: returns `ImageData` for a channel | — |
| `__tilingTest(size?)` | bake every Tileable Noise type, score the wrap seam, console.table a summary | `bake/tiling-<type>.png` |
| `__bakeService` | the singleton bake service (advanced) | — |

Single-channel manual bake (equivalent to `__savePng`):

```js
const channel = 'baseColor'; // baseColor | normal | roughness | metallic | ambientOcclusion | emission
const size = 1024;
const img = await __baker.readImageData(__renderer, __scene.materialController, channel, size);
const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
c.getContext('2d').putImageData(img, 0, 0);
const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
await fetch(`http://127.0.0.1:8788/save?name=${channel}.png`, { method: 'POST', body: blob });
```

The Texture tab also has **Export PNG** buttons (browser download) and **Bake → ./bake (dev)** buttons
(POST to the server).

Material-task preview from the console (loads a config, bakes the full set):

```js
const preset = await (await fetch('/configs/materials/ceramic-brick-and-tile/brick/brick-running-bond-red.json')).json();
await __bakeMaterialTask(preset, 'materials/ceramic-brick-and-tile/brick/brick-running-bond-red', 1024);
```

> Note: channels are baked through the graph's **baked** backend (a 2D uv slice). Nodes authored for the
> 3D world-space (live) domain — e.g. the angular `anisotropic-stripes` — can show artifacts/seams when
> baked this way; the bake is faithful to the graph, not necessarily a tileable texture yet.

---

## Batch preset generation with an agent

`npm run material:agent` processes catalog tasks one at a time with Codex or Claude. It builds a prompt
per `catalog/**/material.md` (including node capabilities + the bake instructions above), runs the agent,
and verifies the outputs after each job — failures are logged without stopping the sequence.

**Do not use Playwright** for these jobs: the bake path depends on the app's WebGPU runtime and the
`__bakeMaterialTask` helper in a real browser session (the generated prompt forbids it).

```sh
# Preview the first three prompts without running an agent.
npm run material:agent -- --dry-run --limit 3

# Run five metal materials through Codex.
npm run material:agent -- --agent codex --category metal --limit 5

# Run one specific material through Claude.
npm run material:agent -- --agent claude --only ceramic-brick-and-tile/brick/brick-running-bond-red

# Continue a larger run, skipping materials whose required bake files already exist.
npm run material:agent -- --agent codex --skip-existing
```

Per material, the agent writes `configs/materials/<catalog-relative-path>.json`, then bakes:

```js
const preset = await (await fetch('/configs/materials/<catalog-relative-path>.json')).json();
await __bakeMaterialTask(preset, 'materials/<catalog-relative-path>', 1024);
```

The runner verifies these exist under `bake/materials/<catalog-relative-path>/`: `preset.json`,
`channels/{baseColor,roughness,normal,metallic,ambientOcclusion}.png`, `renders/tiled-2x2.png`, and
`renders/{standard,normals,metallic,ao}.png`. Logs + JSONL summaries land under
`bake/_material-agent-runs/`.

---

## Dual-system testing (ours vs Blender)

While porting Blender's node math (see `blender-node-alignment-plan.md`), a single JSON config — a
`MaterialGraphDocument` — drives **both** systems, with outputs side by side in `bake/<name>/`:

```txt
bake/noise/
  config.json
  baseColor.ours.png    baseColor.blender.png
  roughness.ours.png    roughness.blender.png
```

Configs live in `configs/` (e.g. `configs/noise.json`). Outputs are **not** expected to match
pixel-for-pixel — our TSL noise and Blender's Perlin/Worley differ by construction; this checks
structure/behavior as the faithful ports land.

**1. Our side** (browser/WebGPU) — dev + bake servers running, in the app console:

```js
const cfg = await (await fetch('/configs/noise.json')).json();
await __bakeConfig(cfg, 'noise', 1024); // → bake/noise/config.json + bake/noise/<channel>.ours.png
```

**2. Blender side** (headless reference) — in a terminal:

```sh
npm run bake:blender -- configs/noise.json
# → bake/noise/<channel>.blender.png  (and a copy of config.json)
```

`scripts/blender-bake.mjs` spawns Blender (`$BLENDER`, else the standard macOS app path) running
`scripts/blender_bake.py`, which rebuilds the graph as a Blender shader tree and EMIT-bakes each connected
PBR channel. Unmapped node types **error loudly** — add a builder to `NODE_BUILDERS` in `blender_bake.py`
to support a new node. Color management uses the `Standard` view transform; expect a brightness offset on
color channels vs our raw render-target bytes (structure is preserved).

# Tree Starter

## Local Dev Proxy

Run the Vite dev server through a stable localhost hostname:

```sh
npm run dev:proxy
```

This runs `scripts/devsite.sh`, which:

- derives a hostname from the project folder, for example `tree-starter.localhost`
- assigns a stable port from the project path
- writes a Caddy route under `~/.local/share/devsite/routes/`
- starts or reloads Caddy
- runs Vite on `127.0.0.1:<stable-port>` with `--strictPort`

Open the printed URL, usually:

```txt
http://tree-starter.localhost
```

To override the hostname slug:

```sh
npm run dev:proxy -- my-name
```

Caddy must be installed and available on `PATH`.

## Baking material-graph channels to PNG

The GPU renders the material graph in the browser, so to get a channel out as a file it is POSTed to a
small local server. Useful for inspecting/testing what a node configuration produces as a 2D texture.

1. Start the dev server (`npm run dev`) and, alongside it, the bake server:

   ```sh
   npm run bake:server   # listens on http://127.0.0.1:8788, writes to ./bake/
   ```

2. In the app's dev console (the `__*` handles are exposed only in dev builds), bake a channel and
   POST it:

   ```js
   const channel = 'baseColor'; // baseColor | normal | roughness | metallic | ambientOcclusion | emission
   const size = 1024;
   const img = await __baker.readImageData(__renderer, __scene.materialController, channel, size);
   const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
   c.getContext('2d').putImageData(img, 0, 0);
   const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
   await fetch(`http://127.0.0.1:8788/save?name=${channel}.png`, { method: 'POST', body: blob });
   ```

   The PNG lands in `./bake/<channel>.png` (gitignored).

   Or use the wired-in shortcuts (dev builds only): the **`__savePng(channel, size)`** console handle, or
   the **"Bake → ./bake (dev)"** buttons in the Texture tab — both POST to the same server.

Note: channels are baked through the graph's **baked** backend (a 2D uv slice). Nodes authored for the
3D world-space (live) domain — e.g. the angular `anisotropic-stripes` — can show artifacts/seams when
baked this way; the bake is faithful to the graph, not necessarily a tileable texture yet.

## Material task preview pipeline

Catalog render tasks should use the shared dev helper instead of rebuilding preview scenes per task.
Start the dev server and bake server, then run this in the app console:

```js
const preset = await (await fetch('/configs/materials/ceramic-brick-and-tile/brick/brick-running-bond-red.json')).json();
await __bakeMaterialTask(
  preset,
  'materials/ceramic-brick-and-tile/brick/brick-running-bond-red',
  1024,
);
```

The helper loads the graph, writes `preset.json`, bakes `channels/baseColor.png`,
`channels/roughness.png`, `channels/normal.png`, `channels/metallic.png`,
`channels/ambientOcclusion.png`, writes `proof/tileability-2x2.png`, and renders
`renders/standard-demo-512.png` as a 512x512 sphere with a plane below using the same material.

## Batch material preset generation with an agent

Use the material-agent runner to process catalog tasks one at a time with Codex or Claude. The runner
does not modify graph/node implementation files; it builds a prompt per `catalog/**/material.md` that
includes the existing node capabilities and the shared bake instructions above. Each job is verified
after the agent exits, and failures are logged without stopping the remaining sequence.

Do not use Playwright for these jobs. The generated prompt forbids installing or using Playwright because
this material bake path depends on the app's WebGL/WebGPU runtime and the dev-console
`__bakeMaterialTask` helper in a real browser session.

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

For each material, the agent must write:

```txt
configs/materials/<catalog-relative-path>.json
```

Then it must bake with:

```js
const preset = await (await fetch('/configs/materials/<catalog-relative-path>.json')).json();
await __bakeMaterialTask(preset, 'materials/<catalog-relative-path>', 1024);
```

The runner verifies:

```txt
bake/materials/<catalog-relative-path>/preset.json
bake/materials/<catalog-relative-path>/channels/baseColor.png
bake/materials/<catalog-relative-path>/channels/roughness.png
bake/materials/<catalog-relative-path>/channels/normal.png
bake/materials/<catalog-relative-path>/channels/metallic.png
bake/materials/<catalog-relative-path>/channels/ambientOcclusion.png
bake/materials/<catalog-relative-path>/proof/tileability-2x2.png
bake/materials/<catalog-relative-path>/renders/standard-demo-512.png
```

Logs and JSONL summaries are written under `bake/_material-agent-runs/`.

## Dual-system testing pipeline (ours vs Blender)

While porting Blender's node math (see `blender-node-alignment-plan.md`), we compare our output against
Blender's for the **same** node configuration. A single JSON config — a `MaterialGraphDocument` (our
nodes/edges format) — is the source of truth driving **both** systems. Outputs land side by side in
`bake/<name>/`:

```txt
bake/noise/
  config.json
  baseColor.ours.png    baseColor.blender.png
  roughness.ours.png    roughness.blender.png
```

Configs live in `configs/` (e.g. `configs/noise.json`). Per channel, both PNGs show the same socket so
they can be eyeballed. Outputs are **not** expected to match pixel-for-pixel — our TSL noise and
Blender's Perlin/Worley differ by construction; this tool checks structure/behavior as the faithful
ports land.

**1. Our side** (browser/WebGPU). With the dev server and bake server running, in the app's dev console:

```js
const cfg = await (await fetch('/configs/noise.json')).json();
await __bakeConfig(cfg, 'noise', 1024); // loads the config, bakes every connected channel, POSTs
// → bake/noise/config.json + bake/noise/<channel>.ours.png
```

**2. Blender side** (headless reference). In a terminal:

```sh
npm run bake:blender -- configs/noise.json
# → bake/noise/<channel>.blender.png  (and a copy of config.json)
```

`scripts/blender-bake.mjs` spawns Blender (`$BLENDER`, else the standard macOS app path) running
`scripts/blender_bake.py`, which rebuilds the graph as a Blender shader tree and EMIT-bakes each
connected PBR channel. Unmapped node types **error loudly** — add a builder to `NODE_BUILDERS` in
`blender_bake.py` to support a new node. Color management uses the `Standard` view transform; expect a
brightness offset on color channels vs our raw render-target bytes (structure is preserved).

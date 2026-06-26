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

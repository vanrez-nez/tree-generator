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

## Material baking

Baking material-graph channels and reference renders to PNG (the `/export-bake` POST route, the dev-console
`__*` handles, the batch material-agent runner, and the Blender dual-system comparison) is documented in
full — including every configurable option — in **[docs/baking.md](docs/baking.md)**.

Quick start: run `npm run bake:server` alongside the dev server, then either open `/export-bake` and POST a
document to `http://127.0.0.1:8788/export-bake`, or use the `__bakeMaterialTask` console handle.

// Dev helper: receives baked material-graph channel PNGs from the running app and writes them to
// <project>/bake/. The GPU render happens in the browser, so the bytes are POSTed out over HTTP
// (returning them inline through automation tools gets base64-redacted). Kept separate from Vite so it
// doesn't touch the build. CORS-open for the 127.0.0.1 dev origin.
//
//   node scripts/bake-server.mjs        # or: npm run bake:server
//
// Then, in the app's dev console (handles are exposed only under import.meta.env.DEV):
//   const img = await __baker.readImageData(__renderer, __scene.materialController, 'baseColor', 1024)
//   const c = Object.assign(document.createElement('canvas'), { width: 1024, height: 1024 })
//   c.getContext('2d').putImageData(img, 0, 0)
//   const blob = await new Promise(r => c.toBlob(r, 'image/png'))
//   await fetch('http://127.0.0.1:8788/save?name=baseColor.png', { method: 'POST', body: blob })
//
// Channels (PBR output socket keys): baseColor | normal | roughness | metallic | ambientOcclusion | emission
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.BAKE_PORT) || 8788;

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("POST only");
  }
  // `name` may contain `/` to nest under bake/ (e.g. "noise/baseColor.ours.png"). Sanitize each path
  // segment and resolve under bake/, rejecting any traversal that escapes the bake directory.
  const rawName = new URL(req.url, "http://x").searchParams.get("name") || "bake.png";
  const name =
    rawName
      .split("/")
      .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, "_"))
      .filter((seg) => seg && seg !== "." && seg !== "..")
      .join("/") || "bake.png";
  const bakeDir = resolve(ROOT, "bake");
  const out = resolve(bakeDir, name);
  if (out !== bakeDir && !out.startsWith(bakeDir + "/")) {
    res.statusCode = 400;
    return res.end("bad name");
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const buf = Buffer.concat(chunks);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, buf);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, path: out, bytes: buf.length }));
    console.log(`wrote ${out} (${buf.length} bytes)`);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`bake-server listening on http://127.0.0.1:${PORT}`));

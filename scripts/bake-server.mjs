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
import { writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.BAKE_PORT) || 8788;
const BAKE_DIR = resolve(ROOT, "bake");
const REF_DIR = resolve(ROOT, "external", "renders");
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".md": "text/plain; charset=utf-8" };

// Only serve files under bake/ or external/renders/ (no traversal).
function safeFile(rel) {
  const p = resolve(ROOT, rel);
  if (p.startsWith(BAKE_DIR + "/") || p.startsWith(REF_DIR + "/")) return existsSync(p) ? p : null;
  return null;
}

// ---- /export-bake job relay ----
// The GPU bake only runs in the browser (three.js WebGPURenderer), and a browser tab can't listen for
// HTTP — so a POSTed document is relayed over SSE to an open /export-bake worker tab, which bakes it and
// POSTs the result back here. The agent's POST is held open until that result (or a timeout) arrives.
// One worker at a time (last connection wins); the worker processes jobs sequentially.
let worker = null; // the connected SSE response, or null
let nextJobId = 1;
const pending = new Map(); // jobId -> { res, timer }: agent requests awaiting a worker result
const JOB_TIMEOUT_MS = 180_000;

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((res, rej) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        res(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        rej(err);
      }
    });
    req.on("error", rej);
  });
}

// Sanitize a (possibly nested) bake name: strip unsafe chars per path segment, drop . / .. / empties.
function sanitizeName(raw, fallback = "bake") {
  return (
    (raw || "")
      .split("/")
      .map((seg) => seg.replace(/[^a-zA-Z0-9._-]/g, "_"))
      .filter((seg) => seg && seg !== "." && seg !== "..")
      .join("/") || fallback
  );
}

// Resolve a job's output folder once. When `overwrite` is off and `bake/<name>` already exists, append a
// numeric postfix at the END (bark → bark-01 → bark-02 …) so a re-bake never clobbers a previous run.
function resolveBakeFolder(name, overwrite) {
  const base = sanitizeName(name, "on-the-fly");
  if (overwrite || !existsSync(resolve(BAKE_DIR, base))) return base;
  for (let n = 1; ; n++) {
    const candidate = `${base}-${String(n).padStart(2, "0")}`;
    if (!existsSync(resolve(BAKE_DIR, candidate))) return candidate;
  }
}

// HTML comparison gallery: each baked config (bake/NN/) beside its Blender reference (external/renders/NN.png).
function galleryHtml() {
  const dirs = existsSync(BAKE_DIR)
    ? readdirSync(BAKE_DIR)
        .filter((d) => statSync(resolve(BAKE_DIR, d)).isDirectory())
        .sort()
    : [];
  const img = (rel, label) =>
    `<figure><img src="/img?path=${encodeURIComponent(rel)}" loading="lazy"><figcaption>${label}</figcaption></figure>`;
  const rows = dirs
    .map((nn) => {
      const refPng = existsSync(resolve(REF_DIR, `${nn}.png`)) ? `external/renders/${nn}.png` : null;
      const refMd = existsSync(resolve(REF_DIR, `${nn}.md`)) ? `external/renders/${nn}.md` : null;
      const ours = readdirSync(resolve(BAKE_DIR, nn))
        .filter((f) => f.endsWith(".ours.png"))
        .sort((a, b) => (a.startsWith("baseColor") ? -1 : b.startsWith("baseColor") ? 1 : a.localeCompare(b)));
      const refCell = refPng
        ? img(refPng, `Blender ref${refMd ? ` · <a href="/img?path=${encodeURIComponent(refMd)}">def</a>` : ""}`)
        : `<figure class="missing"><div>no external/renders/${nn}.png</div></figure>`;
      const oursCells = ours.length
        ? ours.map((f) => img(`bake/${nn}/${f}`, f.replace(".ours.png", ""))).join("")
        : `<figure class="missing"><div>no *.ours.png — bake via __bakeConfig</div></figure>`;
      return `<section><h2>${nn}</h2><div class="row"><div class="ref">${refCell}</div><div class="ours">${oursCells}</div></div></section>`;
    })
    .join("\n");
  return `<!doctype html><meta charset=utf-8><title>bake compare</title><style>
body{background:#161616;color:#ddd;font:13px system-ui,sans-serif;margin:0;padding:16px}
h1{font-size:15px;font-weight:600} h2{font-size:13px;color:#9ad1ff;margin:18px 0 6px}
.row{display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap;border-top:1px solid #2a2a2a;padding-top:8px}
.ref,.ours{display:flex;gap:10px;flex-wrap:wrap}
.ref{border-right:1px solid #2a2a2a;padding-right:24px}
figure{margin:0;text-align:center} img{width:220px;height:220px;object-fit:contain;background:#0c0c0c;border:1px solid #333;image-rendering:pixelated}
figcaption{font-size:11px;color:#999;margin-top:3px} a{color:#9ad1ff}
.missing div{width:220px;height:220px;display:grid;place-items:center;color:#666;border:1px dashed #333;font-size:11px;padding:8px;box-sizing:border-box}
</style><h1>Material test surface — ours (offline bake) vs Blender reference</h1>
<p style="color:#888">Reproduce <code>external/renders/NN.md</code> as <code>configs/NN.json</code>, bake via <code>__bakeConfig(doc,'NN')</code>. Similar ≠ identical; lighting ignored.</p>
${rows || "<p>No bakes yet — run a config through <code>__bakeConfig</code>.</p>"}`;
}

createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  const url = new URL(req.url, "http://x");
  if (req.method === "GET") {
    if (url.pathname === "/" || url.pathname === "/compare") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(galleryHtml());
    }
    if (url.pathname === "/img") {
      const file = safeFile(url.searchParams.get("path") || "");
      if (!file) {
        res.statusCode = 404;
        return res.end("not found");
      }
      res.setHeader("content-type", MIME[extname(file)] || "application/octet-stream");
      return res.end(readFileSync(file));
    }
    // SSE stream the /export-bake worker tab connects to; jobs are pushed as `event: job`.
    if (url.pathname === "/export-bake/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      worker = res;
      console.log("export-bake worker connected");
      const ping = setInterval(() => res.write(": ping\n\n"), 15000);
      req.on("close", () => {
        clearInterval(ping);
        if (worker === res) worker = null;
        console.log("export-bake worker disconnected");
      });
      return;
    }
    res.statusCode = 404;
    return res.end("not found");
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("GET or POST");
  }
  // Submit a bake job: relay the document payload to the connected worker tab and hold this response open
  // until the worker reports a result (or the job times out).
  // Body: { doc, name, size?, channels?, overwrite?, render? } (render = demo lighting profiles).
  if (url.pathname === "/export-bake") {
    if (!worker) {
      return sendJson(res, 503, {
        ok: false,
        error: "no /export-bake worker connected — open the /export-bake page in a browser first",
      });
    }
    return readJson(req)
      .then((job) => {
        const { doc, name, size, channels, overwrite, render } = job;
        // Validate the document up front so a bad payload never reaches the worker or touches disk.
        if (!doc || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
          return sendJson(res, 400, { ok: false, error: "invalid document (missing nodes/edges)" });
        }
        // Resolve the output folder once (overwrite → clobber; else postfix -NN) and send that to the worker.
        const folder = resolveBakeFolder(name, !!overwrite);
        const id = nextJobId++;
        const timer = setTimeout(() => {
          if (pending.delete(id)) sendJson(res, 504, { ok: false, error: "bake timed out" });
        }, JOB_TIMEOUT_MS);
        pending.set(id, { res, timer });
        worker.write(`event: job\ndata: ${JSON.stringify({ id, doc, name: folder, size, channels, render })}\n\n`);
        console.log(`export-bake job ${id} → worker (name: ${folder}${overwrite ? ", overwrite" : ""})`);
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: `bad JSON: ${err.message}` }));
  }
  // The worker reports a finished job here; resolve the agent's held response with the result.
  if (url.pathname === "/export-bake/result") {
    return readJson(req)
      .then((result) => {
        sendJson(res, 200, { ok: true }); // ack the worker
        const job = pending.get(result.id);
        if (!job) return;
        clearTimeout(job.timer);
        pending.delete(result.id);
        sendJson(job.res, result.ok ? 200 : 500, result);
        console.log(`export-bake job ${result.id} ← worker (${result.ok ? "ok" : "error"})`);
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: `bad JSON: ${err.message}` }));
  }
  // `name` may contain `/` to nest under bake/ (e.g. "noise/baseColor.ours.png"). Sanitize each path
  // segment and resolve under bake/, rejecting any traversal that escapes the bake directory.
  const rawName = new URL(req.url, "http://x").searchParams.get("name") || "bake.png";
  const name = sanitizeName(rawName, "bake.png");
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

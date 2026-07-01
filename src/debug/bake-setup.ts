import { WebGPURenderer } from "three/webgpu";
import type { MainScene } from "../scene/main";
import { bakeService } from "../scene/material/graph/bake-service";
import type { MaterialGraphController } from "../scene/material/graph/controller";
import { defaultRegistry } from "../scene/material/graph/registry";
import { runTilingTest } from "../scene/material/graph/tiling-test";
import { MATERIAL_PRESETS, makePreset } from "../scene/material/presets";
import { PBR_SOCKETS, type PbrSocket, type MaterialGraphDocument } from "../scene/material/graph/types";
import { createExport, type ExportApi, type DemoRenderOptions } from "./export";

// The dev bake server (scripts/bake-server.mjs, `npm run bake:server`). `POST /save?name=<path>` writes the
// body under ./bake/<path>; the name may nest with `/`.
const BAKE_SERVER = "http://127.0.0.1:8788";

// ---------------------------------------------------------------------------------------------------------
// DEV console handles (moved out of app.ts). These drive baking off the LIVE tree scene, so they take the
// scene + the exporter bound to it. Installed only in DEV, on the normal app route.
// ---------------------------------------------------------------------------------------------------------
export interface BakeDevHandleDeps {
  mainScene: MainScene;
  exporter: ExportApi;
}

export function installBakeDevHandles({ mainScene, exporter }: BakeDevHandleDeps): void {
  Object.assign(window as unknown as Record<string, unknown>, {
    __bakeService: bakeService,
    // Back-compat shim for dev-console bake snippets: `__baker.readImageData(_renderer, graph, ch, size)`
    // now routes through the singleton service (the renderer arg is ignored — the service owns it).
    __baker: {
      readImageData: (_r: unknown, graph: MaterialGraphController, ch: PbrSocket, size?: number) =>
        bakeService.readImage(graph, ch, size),
    },
    __savePng: exporter.saveChannelToBake,
    __bakeConfig: exporter.bakeConfigToBake,
    __bakeMaterialTask: exporter.bakeMaterialTask,
    // Tiling test for every Tileable Noise type: bakes each, scores the wrap-edge seam, console.tables a
    // pass/fail summary, and saves a 2×2 composite PNG per type to ./bake (needs `npm run bake:server`).
    // Usage from the dev console: `await __tilingTest()`  (optionally `__tilingTest(256)`).
    __tilingTest: (size?: number) =>
      runTilingTest(bakeService, mainScene.materialController.getRegistry(), {
        size,
        onTile: (type, img) => exporter.saveTilingComposite(type, img),
      }).then((rows) => {
        console.table(
          rows.map((r) => ({
            type: r.type,
            pass: r.pass,
            ratioH: Number.isFinite(r.ratioH) ? +r.ratioH.toFixed(2) : "—",
            ratioV: Number.isFinite(r.ratioV) ? +r.ratioV.toFixed(2) : "—",
          })),
        );
        const failed = rows.filter((r) => !r.pass).map((r) => r.type);
        console.log(failed.length ? `[tiling] SEAMS: ${failed.join(", ")}` : "[tiling] all seamless ✓");
        return rows;
      }),
  });
}

// ---------------------------------------------------------------------------------------------------------
// /export-bake route — an isolated headless bake driven entirely by the URL. Visiting the page boots a
// minimal renderer + a non-persisting material controller (NO tree/floor scene, NO Tweakpane), bakes each
// requested preset's channels, and POSTs them to the bake server. See runExportBake below.
// ---------------------------------------------------------------------------------------------------------

// A job pushed from the bake server over SSE. `doc` is the arbitrary MaterialGraphDocument to bake.
interface BakeJob {
  id: number;
  doc: MaterialGraphDocument;
  name?: string;
  size?: number;
  channels?: string[];
  render?: DemoRenderOptions; // shadows/MSAA/size for the sphere-plane demo render
}

// readImage requires 256-byte-aligned rows → a multiple of 64 px. Round any request to the nearest one.
function normalizeSize(size: unknown): number {
  const n = typeof size === "number" ? size : Number.parseInt(String(size ?? ""), 10);
  return Math.max(64, Math.round((Number.isFinite(n) ? n : 1024) / 64) * 64);
}

// Keep only real PBR sockets; default to all of them (unconnected channels are skipped at bake time).
// Accepts a `,`-separated string (URL) or a string[] (JSON payload).
function normalizeChannels(channels: unknown): PbrSocket[] {
  const isSocket = (c: string): c is PbrSocket => (PBR_SOCKETS as readonly string[]).includes(c);
  const list =
    typeof channels === "string" && channels
      ? channels.split(",").map((s) => s.trim())
      : Array.isArray(channels)
        ? channels
        : [];
  const filtered = list.filter((c): c is PbrSocket => typeof c === "string" && isSocket(c));
  return filtered.length ? filtered : [...PBR_SOCKETS];
}

// Minimal on-page status log so a visit shows live progress without the dev console. Returns a `log`
// appender; the surrounding page chrome (hiding the pane) is set up once here.
function createStatusLog(): (line: string) => void {
  const host = document.querySelector<HTMLDivElement>("#app");
  const pane = document.querySelector<HTMLDivElement>(".pane-host");
  if (pane) pane.style.display = "none";

  const pre = document.createElement("pre");
  pre.style.cssText =
    "position:fixed;inset:0;margin:0;padding:16px;overflow:auto;background:#111;color:#d4d4d4;" +
    "font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:10";
  (host ?? document.body).appendChild(pre);

  return (line: string) => {
    console.log(`[export-bake] ${line}`);
    pre.textContent += `${line}\n`;
    pre.scrollTop = pre.scrollHeight;
  };
}

function reportResult(result: Record<string, unknown>): Promise<Response> {
  return fetch(`${BAKE_SERVER}/export-bake/result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
}

// Handle one relayed job: bake the full material-task output set (channels + tileability proof + lit
// sphere/plane demo) via the shared exporter, then report success/failure back so the server can resolve
// the agent's held POST. bakeMaterialTask validates the doc and writes nothing on an invalid one.
async function handleJob(job: BakeJob, exporter: ExportApi, log: (line: string) => void): Promise<void> {
  const name = job.name?.trim() || "on-the-fly";
  log(`job ${job.id}: baking "${name}"…`);
  try {
    const channels = await exporter.bakeMaterialTask(
      job.doc,
      name,
      // An explicit request size wins; when omitted, bakeMaterialTask falls back to the doc's authored
      // Material Output `outputResolution`.
      job.size == null ? undefined : normalizeSize(job.size),
      normalizeChannels(job.channels),
      job.render,
    );
    log(`✓ ${name} — ${channels.length ? channels.join(", ") : "(no connected channels)"} + proof + render`);
    await reportResult({ id: job.id, ok: true, name, channels });
  } catch (err) {
    log(`✗ job ${job.id} failed: ${String(err)}`);
    await reportResult({ id: job.id, ok: false, name, error: String(err) });
  }
}

// Optional startup one-shot: bake named registry presets (back-compat with the URL-driven behaviour).
// `?preset=all` (or absent with any of size/channels) → every preset; else a comma list of keys.
async function runPresetOneShot(
  params: URLSearchParams,
  exporter: ExportApi,
  log: (line: string) => void,
): Promise<void> {
  const known = new Set(MATERIAL_PRESETS.map((p) => p.key));
  const presetParam = params.get("preset");
  const requested =
    !presetParam || presetParam === "all"
      ? MATERIAL_PRESETS.map((p) => p.key)
      : presetParam.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((p) => !known.has(p));
  const presets = requested.filter((p) => known.has(p));
  if (unknown.length) log(`⚠ unknown preset(s) skipped: ${unknown.join(", ")}`);
  if (!presets.length) {
    log("No valid presets in ?preset — skipping startup bake.");
    return;
  }
  const size = normalizeSize(params.get("size") ?? params.get("resolution"));
  const channels = normalizeChannels(params.get("channels"));
  log(`startup bake: ${presets.length} preset(s) @ ${size}px — ${channels.join(", ")}`);
  for (const name of presets) {
    try {
      await exporter.bakeMaterialTask(makePreset(name), name, size, channels);
      log(`✓ ${name}`);
    } catch (err) {
      log(`✗ ${name} failed: ${String(err)} — is the bake server running? (npm run bake:server)`);
      return;
    }
  }
  log(`startup bake done (${presets.length} preset(s)).`);
}

// Entry point for the `/export-bake` route. Boots an isolated renderer (NO tree/floor scene, NO Tweakpane)
// and connects to the bake server as a persistent WORKER: each document POSTed to the server's
// `/export-bake` endpoint is relayed here over SSE, baked on the GPU, and its result reported back. An
// optional `?preset=`/`?size=`/`?channels=` runs a one-shot preset bake at startup.
export async function runExportBake(): Promise<void> {
  const log = createStatusLog();

  // The bake needs a canvas-backed WebGPU renderer (init is async on WebGPU). Reuse the .scene canvas from
  // index.html; nothing is drawn to it — channel bakes render to the service's scratch targets.
  const canvas = document.querySelector<HTMLCanvasElement>(".scene");
  if (!canvas) {
    log("Missing .scene canvas — cannot create a renderer.");
    return;
  }
  const renderer = new WebGPURenderer({ canvas, antialias: false });
  await renderer.init();
  bakeService.attachRenderer(renderer);
  log("renderer ready");

  // Isolated exporter: same bake tooling the app uses, but built from the default registry with no
  // MainScene — so it never touches any on-screen material. bakeMaterialTask produces the full output set
  // (channels + tileability proof + lit sphere/plane demo).
  const exporter = createExport({ renderer, registry: defaultRegistry });

  // Connect to the bake server as the worker tab. EventSource auto-reconnects on drop.
  const es = new EventSource(`${BAKE_SERVER}/export-bake/stream`);
  es.addEventListener("open", () => log("connected to bake server — waiting for POST jobs"));
  es.addEventListener("error", () =>
    log("⚠ bake server connection lost — is `npm run bake:server` running? (retrying…)"),
  );

  // Process jobs one at a time; bakeService also serialises GPU work, but chaining keeps the status log
  // readable and the renderer-hijacking demo render from overlapping.
  let chain: Promise<unknown> = Promise.resolve();
  es.addEventListener("job", (event) => {
    const job = JSON.parse((event as MessageEvent).data) as BakeJob;
    chain = chain.then(() => handleJob(job, exporter, log));
  });

  const params = new URLSearchParams(location.search);
  if (params.has("preset") || params.has("size") || params.has("resolution") || params.has("channels")) {
    await runPresetOneShot(params, exporter, log);
  }
}

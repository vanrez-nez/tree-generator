#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG_ROOT = join(ROOT, "catalog");
const CONFIG_ROOT = join(ROOT, "configs", "materials");
const BAKE_ROOT = join(ROOT, "bake", "materials");
const LOG_ROOT = join(ROOT, "bake", "_material-agent-runs");

const REQUIRED_BAKE_FILES = [
  "preset.json",
  "channels/baseColor.png",
  "channels/roughness.png",
  "channels/normal.png",
  "channels/metallic.png",
  "channels/ambientOcclusion.png",
  "renders/tiled-2x2.png",
  "renders/standard.png",
];

const NODE_CAPABILITIES = `
Existing material graph node capabilities. Use only these node type ids, params, ports, and generic graph composition. Do not add, edit, rename, or implement nodes.

Document shape:
- JSON MaterialGraphDocument: { "version": 2, "nodes": GraphNode[], "edges": GraphEdge[] }
- GraphNode: { "id": string, "type": string, "params": object, "position": { "x": number, "y": number }, "enabled": true }
- GraphEdge: { "fromNode": string, "fromOutput": string, "toNode": string, "toInput": string }
- Terminal path must end in principled-bsdf.bsdf -> material-output.surface.
- Prefer tileable/offline-safe nodes for catalog bakes. Avoid relying on non-tileable perspective, object silhouettes, image sampling, or graph code changes.

Texture nodes:
- tileable-noise: input coord(vector optional); outputs field(float), or field+vector when noiseType="curl"; params noiseType select default "perlin-fbm", scale int 1..24, aspect 1..8, octaves 1..8, gain 0..1. Good for tileable grain, pores, dirt, cloudy variation, masks.
- fbm: input coord(vector optional); output field(float); params scale 0.1..8, octaves 0..15, lacunarity 1.5..3, gain 0..1. Good for broad organic variation.
- voronoi: input coord(vector optional); outputs distance(float), color(color), position(vector), except feature="distance-to-edge" only distance; params scale 0.1..8, randomness 0..1, metric euclidean/manhattan/chebyshev/minkowski, feature f1/f2/smooth-f1/distance-to-edge, exponent 0.1..8, smoothness 0..1. Good for pebbles, cells, crack networks, aggregate.
- tile: input coord(vector optional); outputs mask(float), value(float); params lattice square/hex/brick/herringbone, columns 1..32, rows 1..64, offset 0..1, offsetFreq 1..6, gap 0..0.08, roundness 0..1, edge 0..0.05, sizeRandom/posRandom/rotRandom 0..1. Good for bricks, tiles, planks, blocks, pavers.
- checker: input coord/color1/color2 optional; outputs color(color), fac(float); params color1, color2, scale 0.5..32.
- wave: input coord(vector optional); output field(float); params scale 0.1..8, waveType, direction, profile, phase, distortion, detail, detailScale, detailRoughness. Good for wood grain, strata, brushed lines.
- anisotropic-stripes: input coord(vector optional); output field(float); params count 1..64, sharpness 0.2..8, waviness 0..2, contrast 0..1. Use carefully: README notes it can seam in baked 2D if overused.
- scatter: input coord(vector optional); outputs coord(vector), value(float), size(float); params density 1..48, amount 0..1, radius 0.05..1, sizeRandom/posRandom/rotRandom 0..1. Good for flakes, chips, stones, knots, inclusions.
- shape: inputs coord(vector optional), seed(float optional); outputs mask(float), height(float); params shape, sides 3..12, irregularity 0..1, dome 0.2..3, edge 0.002..0.3. Good for isolated stones, chips, scales, blobs.
- gradient: input coord(vector optional); output field(float); params scale 0.1..8, gradientType. Good for directional bands and subtle ramps.
- screen-noise: input coord(vector optional); output field(float); params noiseType, resolution. Use sparingly for fine breakup.

Vector/coordinate nodes:
- tex-coordinate: outputs generated, uv, object, normal vectors. Prefer uv/generated through mapping/tileable-warp for bakeable patterns.
- mapping: input vector; output vector; params mappingType, location vec3, rotation vec3, scale vec3.
- tileable-warp: input coord; output coord; params amount 0..1, scale 1..16. Good for seamless distortion.
- domain-warp: input coord; output coord; params amount 0..2, scale 0.1..8. Use lightly and verify seams.
- vector-math: inputs vector1/vector2; output vector or value depending operation; params operation, scale -8..8.
- normal-from-height: input height(float); output normal(vector); params strength 0..2.
- normal-map: input color/strength; output normal(vector); params strength 0..4. Use only if you procedurally build a normal color.

Converters/color utility:
- color-ramp: input field(float); output color; params colorA, colorB, low 0..1, high 0..1.
- levels: input field; output field; params min 0..1, max 0..1, invert bool.
- math: inputs a/b/c depending op; output field; params op, factor, c. Good for masks, roughness, metallic, AO, height.
- clamp: inputs value/min/max; output field; params mode minmax/range, min -10..10, max -10..10.
- height-blend: inputs heightA/heightB/breakup; output fac; params transition, width, breakup.
- luminance: color -> field.
- split-channels: color -> r/g/b fields.
- combine-channels: r/g/b fields -> color.
- separate-xyz / combine-xyz for vector components.
- blend: inputs a(color), b(color), mask(float optional); output color; params mode mix/multiply/screen/add, opacity 0..1.
- invert, bright-contrast, hue-sat-val, rgb-curves for color shaping.
- constant-field and constant-color for scalar/color sources.

Shader/output:
- principled-bsdf inputs: baseColor color, metallic float, roughness float, ior float, alpha float, normal vector, height float, ambientOcclusion float, coat float, coatRoughness float, sheen float, sheenRoughness float, transmission float, emission color, emissionStrength float. Output bsdf shader.
- emission output bsdf shader; mix-shader combines shaders; material-output consumes surface shader.
`;

const BAKING_INSTRUCTIONS = `
Bake verification instructions, included here so catalog material.md files do not need repeated procedural bake guidance:

1. Create the graph preset at the exact config path requested by this job: configs/materials/<catalog-relative-path>.json.
2. Start or reuse the dev server and bake server:
   - npm run dev
   - npm run bake:server
3. Open the Vite app in a browser. In dev builds, the app exposes __bakeMaterialTask.
4. In the browser console, run:
   const preset = await (await fetch('/configs/materials/<catalog-relative-path>.json')).json();
   await __bakeMaterialTask(preset, 'materials/<catalog-relative-path>', 1024);
5. Verify these exact files exist under bake/materials/<catalog-relative-path>/:
   - preset.json
   - channels/baseColor.png
   - channels/roughness.png
   - channels/normal.png
   - channels/metallic.png
   - channels/ambientOcclusion.png
   - renders/tiled-2x2.png
   - renders/standard.png
6. If baking fails, fix only the preset JSON and retry. Do not change graph/node implementation.
7. Treat visible seams, blank outputs, missing required channels, or a compile warning from the material controller as a failed attempt until improved.
`;

function usage() {
  console.log(`
Usage:
  node scripts/material-agent-batch.mjs --agent codex [options]
  node scripts/material-agent-batch.mjs --agent claude [options]
  node scripts/material-agent-batch.mjs --dry-run [options]

Options:
  --agent <codex|claude|none>   Agent CLI to run. Default: none.
  --dry-run                     Print/write prompts and job list without invoking an agent.
  --only <path-fragment>        Run one material whose catalog-relative path contains this fragment.
  --category <slug>             Restrict to catalog category slug.
  --from <path-fragment>        Start at the first material whose path contains this fragment.
  --limit <n>                   Maximum jobs to process.
  --skip-existing               Skip jobs with all required bake outputs already present.
  --model <name>                Model argument passed through to Codex/Claude.
  --timeout-minutes <n>         Per-job timeout. Default: 45.
  --prompt-dir <dir>            Also write each generated prompt to this directory.
  --no-images                   Do not pass reference.png with Codex -i.
  --fail-on-job-failure         Exit nonzero after the sequence if any material job fails.
  --help                        Show this help.

Examples:
  npm run material:agent -- --dry-run --limit 3
  npm run material:agent -- --agent codex --category metal --limit 5
  npm run material:agent -- --agent claude --only ceramic-brick-and-tile/brick/brick-running-bond-red
`);
}

function parseArgs(argv) {
  const opts = {
    agent: "none",
    dryRun: false,
    only: "",
    category: "",
    from: "",
    limit: Infinity,
    skipExisting: false,
    model: "",
    timeoutMinutes: 45,
    promptDir: "",
    images: true,
    failOnJobFailure: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`Missing value for ${arg}`);
      return v;
    };
    if (arg === "--agent") opts.agent = value();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--only") opts.only = value();
    else if (arg === "--category") opts.category = value();
    else if (arg === "--from") opts.from = value();
    else if (arg === "--limit") opts.limit = Number(value());
    else if (arg === "--skip-existing") opts.skipExisting = true;
    else if (arg === "--model") opts.model = value();
    else if (arg === "--timeout-minutes") opts.timeoutMinutes = Number(value());
    else if (arg === "--prompt-dir") opts.promptDir = value();
    else if (arg === "--no-images") opts.images = false;
    else if (arg === "--fail-on-job-failure") opts.failOnJobFailure = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) opts.limit = Infinity;
  if (!Number.isFinite(opts.timeoutMinutes) || opts.timeoutMinutes <= 0) opts.timeoutMinutes = 45;
  if (opts.dryRun) opts.agent = "none";
  if (!["none", "codex", "claude"].includes(opts.agent)) {
    throw new Error("--agent must be codex, claude, or none");
  }
  return opts;
}

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (name === "material.md") acc.push(p);
  }
  return acc;
}

function relNoMaterial(materialPath) {
  return relative(CATALOG_ROOT, dirname(materialPath)).split("\\").join("/");
}

function expectedBakeFiles(relPath) {
  return REQUIRED_BAKE_FILES.map((file) => join(BAKE_ROOT, relPath, file));
}

function verifyJob(relPath) {
  const missing = [];
  const empty = [];
  for (const file of expectedBakeFiles(relPath)) {
    if (!existsSync(file)) missing.push(relative(ROOT, file));
    else if (statSync(file).size === 0) empty.push(relative(ROOT, file));
  }
  const configPath = join(CONFIG_ROOT, `${relPath}.json`);
  if (!existsSync(configPath)) missing.unshift(relative(ROOT, configPath));
  else {
    try {
      const doc = JSON.parse(readFileSync(configPath, "utf8"));
      if (doc.version !== 2 || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges)) {
        empty.unshift(`${relative(ROOT, configPath)} has invalid MaterialGraphDocument shape`);
      }
    } catch (err) {
      empty.unshift(`${relative(ROOT, configPath)} JSON parse failed: ${err.message}`);
    }
  }
  return { ok: missing.length === 0 && empty.length === 0, missing, empty };
}

function buildJobs(opts) {
  let jobs = walk(CATALOG_ROOT)
    .map((materialPath) => {
      const relPath = relNoMaterial(materialPath);
      const referencePath = join(dirname(materialPath), "reference.png");
      return {
        relPath,
        category: relPath.split("/")[0],
        materialPath,
        referencePath,
        configPath: join(CONFIG_ROOT, `${relPath}.json`),
        bakePath: join(BAKE_ROOT, relPath),
      };
    })
    .sort((a, b) => a.relPath.localeCompare(b.relPath));

  if (opts.category) jobs = jobs.filter((j) => j.category === opts.category);
  if (opts.only) jobs = jobs.filter((j) => j.relPath.includes(opts.only));
  if (opts.from) {
    const idx = jobs.findIndex((j) => j.relPath.includes(opts.from));
    jobs = idx === -1 ? [] : jobs.slice(idx);
  }
  if (opts.skipExisting) jobs = jobs.filter((j) => !verifyJob(j.relPath).ok);
  if (Number.isFinite(opts.limit)) jobs = jobs.slice(0, opts.limit);
  return jobs;
}

function buildPrompt(job) {
  const materialText = readFileSync(job.materialPath, "utf8");
  const hasReference = existsSync(job.referencePath);
  return `You are running one material preset generation job inside ${ROOT}.

Task:
- Create the strongest possible procedural node graph preset for catalog/${job.relPath}.
- Use the catalog task and reference image as the visual target.
- Save the preset JSON at ${relative(ROOT, job.configPath)}.
- Bake and verify the preset output at ${relative(ROOT, job.bakePath)}.

Hard constraints:
- Do not create, edit, rename, or modify graph/node/source implementation files.
- Do not change catalog material.md files for this job.
- Use only existing node graph capabilities listed below.
- Do not sample or embed the reference image in the graph. The reference is a visual target only.
- Do not use, install, or attempt to add Playwright. Playwright is forbidden for this workflow because it does not support this WebGL/WebGPU bake path reliably enough for material verification here.
- Do not replace the browser bake with headless automation. Baking must use the existing app dev build and the exposed __bakeMaterialTask helper in a real browser session.
- The output must be a valid MaterialGraphDocument JSON with version 2.
- Connect all relevant PBR channels you can: baseColor, roughness, normal, metallic, ambientOcclusion, and height when useful.
- Make the graph tileable in baked UV space. Prefer tileable-noise, tile, voronoi, wave, mapping, tileable-warp, color-ramp, levels, math, blend, normal-from-height, and principled-bsdf.
- It is acceptable if the graph is approximate, but it must be deliberate and as close as practical using existing nodes.

Material paths:
- material.md: ${relative(ROOT, job.materialPath)}
- reference.png: ${hasReference ? relative(ROOT, job.referencePath) : "(missing)"}
- config output: ${relative(ROOT, job.configPath)}
- bake output folder: ${relative(ROOT, job.bakePath)}
- browser fetch path: /configs/materials/${job.relPath}.json
- __bakeMaterialTask folder argument: materials/${job.relPath}

${NODE_CAPABILITIES}

${BAKING_INSTRUCTIONS.replaceAll("<catalog-relative-path>", job.relPath)}

Catalog task:
${materialText}

Completion criteria:
- ${relative(ROOT, job.configPath)} exists and parses.
- bake/materials/${job.relPath}/preset.json exists.
- bake/materials/${job.relPath}/channels/baseColor.png exists.
- bake/materials/${job.relPath}/channels/roughness.png exists.
- bake/materials/${job.relPath}/channels/normal.png exists.
- bake/materials/${job.relPath}/channels/metallic.png exists.
- bake/materials/${job.relPath}/channels/ambientOcclusion.png exists.
- bake/materials/${job.relPath}/renders/tiled-2x2.png exists.
- bake/materials/${job.relPath}/renders/standard.png exists.
- Final response should be short and include whether bake verification passed.
`;
}

function createLineTee(prefix, write) {
  let pending = "";
  return {
    write(buf) {
      pending += buf.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) write(`${prefix}${line}\n`);
    },
    flush() {
      if (pending.length > 0) {
        write(`${prefix}${pending}\n`);
        pending = "";
      }
    },
  };
}

function createClaudeMessageTee(prefix) {
  let pending = "";
  return {
    write(buf) {
      pending += buf.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) printClaudeMessageLine(prefix, line);
    },
    flush() {
      if (pending.length > 0) {
        printClaudeMessageLine(prefix, pending);
        pending = "";
      }
    },
  };
}

function printClaudeMessageLine(prefix, line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    const text = extractClaudeText(event);
    if (text) process.stdout.write(`${prefix}${text.endsWith("\n") ? text : `${text}\n`}`);
    if (event.type === "result" && event.is_error) {
      const error = event.result || event.error || "Claude run failed";
      process.stderr.write(`${prefix}${error}\n`);
    }
  } catch {
    process.stdout.write(`${prefix}${line}\n`);
  }
}

function extractClaudeText(event) {
  if (typeof event?.text === "string") return event.text;
  if (typeof event?.delta?.text === "string") return event.delta.text;
  if (typeof event?.message?.content === "string") return event.message.content;
  if (Array.isArray(event?.message?.content)) {
    return event.message.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
  }
  if (Array.isArray(event?.content)) {
    return event.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
  }
  return "";
}

function runCommand(command, args, input, timeoutMs, logPath, label, outputMode = "plain") {
  return new Promise((resolve) => {
    console.log(`[material-agent] spawning ${command} for ${label}`);
    const child = spawn(command, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    console.log(`[material-agent] spawned ${command} pid=${child.pid ?? "unknown"} for ${label}`);
    const chunks = [];
    const stdoutTee =
      outputMode === "claude-stream-json"
        ? createClaudeMessageTee(`[agent:${label}] `)
        : createLineTee(`[agent:${label}] `, (line) => process.stdout.write(line));
    const stderrTee = createLineTee(`[agent:${label}:err] `, (line) => process.stderr.write(line));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);

    child.stdout.on("data", (buf) => {
      stdoutTee.write(buf);
      chunks.push(buf);
    });
    child.stderr.on("data", (buf) => {
      stderrTee.write(buf);
      chunks.push(buf);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      stdoutTee.flush();
      stderrTee.flush();
      chunks.push(Buffer.from(`\n[runner error] ${err.stack || err.message}\n`));
      writeFileSync(logPath, Buffer.concat(chunks));
      resolve({ code: 1, signal: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      stdoutTee.flush();
      stderrTee.flush();
      writeFileSync(logPath, Buffer.concat(chunks));
      resolve({ code, signal });
    });
    child.stdin.end(input);
  });
}

async function runAgent(job, prompt, opts, logPath) {
  if (opts.agent === "none") return { code: 0, signal: null };

  if (opts.agent === "codex") {
    const args = [
      "exec",
      "--cd",
      ROOT,
      "--sandbox",
      "danger-full-access",
      "--skip-git-repo-check",
      "-",
    ];
    if (opts.model) args.splice(1, 0, "--model", opts.model);
    if (opts.images && existsSync(job.referencePath)) args.splice(args.length - 1, 0, "-i", job.referencePath);
    return await runCommand("codex", args, prompt, opts.timeoutMinutes * 60_000, logPath, job.relPath);
  }

  const args = [
    "--print",
    "--input-format",
    "text",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    ROOT,
  ];
  if (opts.model) args.push("--model", opts.model);
  return await runCommand(
    "claude",
    args,
    prompt,
    opts.timeoutMinutes * 60_000,
    logPath,
    job.relPath,
    "claude-stream-json",
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const jobs = buildJobs(opts);
  mkdirSync(LOG_ROOT, { recursive: true });
  if (opts.promptDir) mkdirSync(opts.promptDir, { recursive: true });

  const startedAt = new Date().toISOString().replaceAll(":", "-");
  const summaryPath = join(LOG_ROOT, `${startedAt}-summary.jsonl`);

  console.log(`[material-agent] jobs: ${jobs.length}; agent: ${opts.agent}; skipExisting: ${opts.skipExisting}`);
  if (jobs.length === 0) return;

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const before = verifyJob(job.relPath);
    console.log(`\n[material-agent] ${i + 1}/${jobs.length} ${job.relPath}`);
    console.log(`[material-agent] before: ${before.ok ? "already verified" : "not verified"}`);

    mkdirSync(dirname(job.configPath), { recursive: true });
    const prompt = buildPrompt(job);
    if (opts.promptDir) {
      const safeName = job.relPath.replaceAll("/", "__");
      writeFileSync(join(opts.promptDir, `${safeName}.prompt.md`), prompt);
    }

    const logPath = join(LOG_ROOT, `${startedAt}-${String(i + 1).padStart(4, "0")}-${job.relPath.replaceAll("/", "__")}.log`);
    let agentResult = { code: 0, signal: null };
    if (opts.agent !== "none") {
      agentResult = await runAgent(job, prompt, opts, logPath);
    } else {
      writeFileSync(logPath, prompt);
      console.log(`[material-agent] dry-run prompt: ${relative(ROOT, logPath)}`);
    }

    const after = verifyJob(job.relPath);
    const verified = opts.agent === "none" ? before.ok : after.ok;
    const record = {
      time: new Date().toISOString(),
      relPath: job.relPath,
      agent: opts.agent,
      dryRun: opts.agent === "none",
      exitCode: agentResult.code,
      signal: agentResult.signal,
      verified,
      missing: opts.agent === "none" ? before.missing : after.missing,
      empty: opts.agent === "none" ? before.empty : after.empty,
      log: relative(ROOT, logPath),
    };
    writeFileSync(summaryPath, `${JSON.stringify(record)}\n`, { flag: "a" });

    if (opts.agent === "none") {
      console.log(`[material-agent] dry-run only; verification not required for ${job.relPath}`);
    } else if (after.ok) {
      passed += 1;
      console.log(`[material-agent] verified ${job.relPath}`);
    } else {
      failed += 1;
      console.warn(`[material-agent] failed ${job.relPath}; continuing`);
      if (after.missing.length) console.warn(`[material-agent] missing: ${after.missing.join(", ")}`);
      if (after.empty.length) console.warn(`[material-agent] invalid/empty: ${after.empty.join(", ")}`);
    }
  }

  console.log(`\n[material-agent] done. verified=${passed} failed=${failed}`);
  console.log(`[material-agent] summary: ${relative(ROOT, summaryPath)}`);
  if (opts.failOnJobFailure && opts.agent !== "none" && failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

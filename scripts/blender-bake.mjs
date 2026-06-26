// Dual-system testing pipeline — Blender reference side.
//
// Generates the Blender texture outputs for a node config (a MaterialGraphDocument — the single JSON
// shared by both systems). Spawns Blender headless to run scripts/blender_bake.py, which rebuilds the
// graph and bakes each connected PBR channel to bake/<name>/<channel>.blender.png. The app produces
// the matching <channel>.ours.png via the __bakeConfig dev-console handle, so the two sit side by side.
//
//   node scripts/blender-bake.mjs <config.json> [--name X] [--size 1024] [--channels baseColor,roughness]
//   npm run bake:blender -- configs/noise.json
//
// Blender binary: $BLENDER, else the standard macOS app path. Outputs (and a copy of config.json) land
// in bake/<name>/ (name defaults to the config's basename).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PY = resolve(ROOT, "scripts", "blender_bake.py");
const DEFAULT_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";

function parseArgs(argv) {
  const out = { config: null, name: null, size: "1024", channels: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") out.name = argv[++i];
    else if (a === "--size") out.size = argv[++i];
    else if (a === "--channels") out.channels = argv[++i];
    else if (!a.startsWith("--") && !out.config) out.config = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.config) {
  console.error("usage: node scripts/blender-bake.mjs <config.json> [--name X] [--size N] [--channels a,b]");
  process.exit(2);
}

const blender = process.env.BLENDER || DEFAULT_BLENDER;
if (!existsSync(blender)) {
  console.error(`Blender not found at '${blender}'. Set $BLENDER to your Blender executable.`);
  process.exit(2);
}

const configPath = resolve(process.cwd(), args.config);
if (!existsSync(configPath)) {
  console.error(`config not found: ${configPath}`);
  process.exit(2);
}

const name = args.name || basename(configPath).replace(/\.json$/i, "");
const outdir = resolve(ROOT, "bake", name);
mkdirSync(outdir, { recursive: true });
// Dump the single source-of-truth config alongside the outputs (idempotent with the app side).
copyFileSync(configPath, resolve(outdir, "config.json"));

const child = spawn(
  blender,
  ["--background", "--factory-startup", "--python", PY, "--", configPath, outdir, args.size, args.channels],
  { stdio: "inherit" },
);
child.on("exit", (code) => {
  if (code === 0) console.log(`\nBlender outputs in bake/${name}/`);
  process.exit(code ?? 1);
});

import "./style.css";

// Entry dispatcher. `/export-bake` boots an isolated headless bake (no tree/floor scene, no Tweakpane);
// every other path boots the full app. Dynamic imports keep the two graphs apart — the export route never
// loads MainScene/tweakpane, and the normal route never loads the bake-setup module.
const path = new URL(location.href).pathname.replace(/\/+$/, "");
if (path === "/export-bake") {
  const { runExportBake } = await import("./debug/bake-setup");
  await runExportBake();
} else {
  await import("./app"); // side-effect module: full scene + pane boot
}

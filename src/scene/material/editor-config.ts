// Adapter: maps the fixed material DAG (MaterialGraph) into the generic node-editor's
// `EditorGraphConfig`. This is the only module that knows both the material internals and the
// editor contract, keeping src/node-editor/ reusable. Each node's controls are an embedded
// Tweakpane Pane bound to that node's `params` — the exact bindings that used to live inline in
// app.ts's buildTextureLayers, so editing a value flows through the same signature-poll re-bake.
import { Pane } from "tweakpane";
import type { EditorGraphConfig, EditorNodeConfig } from "../../node-editor";
import type { MaterialGraph } from "./material-graph";
import type { MaterialNode } from "./engine/node";

// Vertical processing chain on the left; the four channel outputs fanned out on the right.
const CHAIN_X = 0;
const CHANNEL_X = 360;
const ROW = 150;

type Build = (pane: Pane) => void;

// A node that takes one input and produces one output (the linear chain links).
function chainNode(
  id: string,
  title: string,
  node: MaterialNode,
  row: number,
  build: Build,
  opts: { hasInput?: boolean; enableable?: boolean } = {},
): EditorNodeConfig {
  const hasInput = opts.hasInput ?? true;
  const enableable = opts.enableable ?? true;
  return {
    id,
    title,
    position: { x: CHAIN_X, y: row * ROW },
    inputs: hasInput ? [{ key: "in" }] : [],
    outputs: [{ key: "out" }],
    enabled: node.enabled,
    onToggle: enableable
      ? (enabled) => {
          node.enabled = enabled;
        }
      : undefined,
    mountControls: paneMount(build),
  };
}

// A channel output node: one input (from cells), no output. Disabling drops its map (handled by
// MaterialGraph.bakeMaps via node.enabled).
function channelNode(
  id: string,
  title: string,
  node: MaterialNode,
  row: number,
  build: Build,
): EditorNodeConfig {
  return {
    id,
    title,
    position: { x: CHANNEL_X, y: row * ROW },
    inputs: [{ key: "in" }],
    outputs: [],
    enabled: node.enabled,
    onToggle: (enabled) => {
      node.enabled = enabled;
    },
    mountControls: paneMount(build),
  };
}

// Wrap a binding builder into a mountControls hook: create a container-bound Pane, populate it, and
// return a disposer.
function paneMount(build: Build): (host: HTMLElement) => () => void {
  return (host) => {
    const pane = new Pane({ container: host });
    build(pane);
    return () => pane.dispose();
  };
}

export function buildMaterialEditorConfig(graph: MaterialGraph): EditorGraphConfig {
  const nodes: EditorNodeConfig[] = [
    // Height is the root generator — everything derives from it, so it has no input and no toggle.
    chainNode(
      "height",
      "Height — FBM",
      graph.height,
      0,
      (p) => {
        p.addBinding(graph.height.params, "seed", { min: 0, max: 9999, step: 1 });
        p.addBinding(graph.height.params, "tiles", { min: 1, max: 16, step: 1 });
        p.addBinding(graph.height.params, "octaves", { min: 1, max: 8, step: 1 });
        p.addBinding(graph.height.params, "gain", { min: 0, max: 1, step: 0.01 });
      },
      { hasInput: false, enableable: false },
    ),
    chainNode("warp", "Warp (weathering)", graph.warp, 1, (p) => {
      p.addBinding(graph.warp.params, "intensity", { min: 0, max: 0.5, step: 0.01 });
      p.addBinding(graph.warp.params, "tiles", { min: 1, max: 12, step: 1 });
      p.addBinding(graph.warp.params, "octaves", { min: 1, max: 8, step: 1 });
    }),
    chainNode("slopeBlur", "Slope Blur (erosion)", graph.slopeBlur, 2, (p) => {
      p.addBinding(graph.slopeBlur.params, "iterations", { min: 0, max: 16, step: 1 });
      p.addBinding(graph.slopeBlur.params, "intensity", { min: 1, max: 8, step: 0.5 });
    }),
    chainNode("cells", "Cells (JFA plates)", graph.cells, 3, (p) => {
      p.addBinding(graph.cells.params, "cells", { min: 2, max: 32, step: 1 });
      p.addBinding(graph.cells.params, "jitter", { min: 0, max: 1, step: 0.01 });
      p.addBinding(graph.cells.params, "seed", { min: 0, max: 9999, step: 1 });
      p.addBinding(graph.cells.params, "crackDepth", { label: "crack depth", min: 0, max: 0.5, step: 0.01 });
      p.addBinding(graph.cells.params, "crackWidth", { label: "crack width", min: 1, max: 6, step: 1 });
      p.addBinding(graph.cells.params, "plateAmount", { label: "plate var", min: 0, max: 0.5, step: 0.01 });
    }),
    channelNode("basecolor", "Basecolor — Gradient Map", graph.basecolor, 0, (p) => {
      p.addBinding(graph.basecolor.params, "colorA", { view: "color", label: "color A" });
      p.addBinding(graph.basecolor.params, "colorB", { view: "color", label: "color B" });
    }),
    channelNode("normal", "Normal", graph.normal, 1, (p) => {
      p.addBinding(graph.normal.params, "strength", { min: 0, max: 40, step: 0.5 });
    }),
    channelNode("ao", "Ambient Occlusion", graph.ao, 2, (p) => {
      p.addBinding(graph.ao.params, "radius", { min: 1, max: 32, step: 1 });
      p.addBinding(graph.ao.params, "strength", { min: 0, max: 12, step: 0.1 });
    }),
    channelNode("roughness", "Roughness", graph.roughness, 3, (p) => {
      p.addBinding(graph.roughness.params, "min", { min: 0, max: 1, step: 0.01 });
      p.addBinding(graph.roughness.params, "max", { min: 0, max: 1, step: 0.01 });
      p.addBinding(graph.roughness.params, "invert");
    }),
  ];

  const connections = [
    { from: "height", fromOutput: "out", to: "warp", toInput: "in" },
    { from: "warp", fromOutput: "out", to: "slopeBlur", toInput: "in" },
    { from: "slopeBlur", fromOutput: "out", to: "cells", toInput: "in" },
    { from: "cells", fromOutput: "out", to: "basecolor", toInput: "in" },
    { from: "cells", fromOutput: "out", to: "normal", toInput: "in" },
    { from: "cells", fromOutput: "out", to: "ao", toInput: "in" },
    { from: "cells", fromOutput: "out", to: "roughness", toInput: "in" },
  ];

  return { nodes, connections };
}

import { Pane } from "tweakpane";
import type { BindingApi } from "@tweakpane/core";
import type { EditorGraphConfig, EditorNodeConfig, EditorPaletteItem } from "../../node-editor";
import type { MaterialGraphController } from "./graph/controller";
import type { GraphNode, ParamDef } from "./graph/types";

const OUTPUT_TYPE = "pbr-output";

// Registry-driven adapter: turns the controller's live MaterialGraphDocument into the generic editor
// config (material-graph-plan.md). Node ports and Tweakpane controls are generated from each node's
// MaterialNodeDef — no hand-written per-node builders. Param/toggle edits flow back into the controller
// (live uniform update or recompile), so the surface reacts immediately.

function bindParam(
  pane: Pane,
  controller: MaterialGraphController,
  nodeId: string,
  param: ParamDef,
  local: Record<string, unknown>,
): void {
  let binding: BindingApi;
  switch (param.type) {
    case "color":
      binding = pane.addBinding(local, param.key, { label: param.label, view: "color" });
      break;
    case "select":
      binding = pane.addBinding(local, param.key, {
        label: param.label,
        options: Object.fromEntries((param.options ?? []).map((o) => [o, o])),
      });
      break;
    case "bool":
      binding = pane.addBinding(local, param.key, { label: param.label });
      break;
    case "int":
    case "float":
    default:
      binding = pane.addBinding(local, param.key, {
        label: param.label,
        min: param.min,
        max: param.max,
        step: param.step ?? (param.type === "int" ? 1 : undefined),
      });
      break;
  }
  binding.on("change", (ev) => controller.setParam(nodeId, param.key, ev.value));
}

function paneMount(build: (pane: Pane) => void): (host: HTMLElement) => () => void {
  return (host) => {
    const pane = new Pane({ container: host });
    build(pane);
    return () => pane.dispose();
  };
}

// Build the editor config for a single graph node (ports, generated controls, toggle, delete).
function nodeToConfig(controller: MaterialGraphController, node: GraphNode): EditorNodeConfig {
  const def = controller.getRegistry().get(node.type);
  // A local mirror of params (defaults filled in) the Tweakpane controls bind to; changes forward to
  // the controller.
  const local: Record<string, unknown> = {};
  for (const p of def.params) local[p.key] = node.params[p.key] ?? p.default;

  const canToggle = def.inputs.length > 0 && node.type !== OUTPUT_TYPE;

  return {
    id: node.id,
    title: def.label,
    position: node.position,
    inputs: def.inputs.map((p) => ({ key: p.key, label: p.label ?? p.key, kind: p.kind })),
    outputs: def.outputs.map((p) => ({ key: p.key, label: p.label ?? p.key, kind: p.kind })),
    mountControls:
      def.params.length > 0
        ? paneMount((pane) => {
            for (const p of def.params) bindParam(pane, controller, node.id, p, local);
          })
        : undefined,
    enabled: node.enabled,
    onToggle: canToggle ? (enabled) => controller.setNodeEnabled(node.id, enabled) : undefined,
    deletable: node.type !== OUTPUT_TYPE,
  };
}

export function buildMaterialEditorConfig(controller: MaterialGraphController): EditorGraphConfig {
  const registry = controller.getRegistry();
  const doc = controller.document;

  const nodes: EditorNodeConfig[] = doc.nodes.map((node) => nodeToConfig(controller, node));

  // Palette: every registered generic node except the terminal output.
  const palette: EditorPaletteItem[] = registry
    .all()
    .filter((def) => def.type !== OUTPUT_TYPE)
    .map((def) => ({ type: def.type, label: def.label, category: def.nodeClass }));

  const connections = doc.edges.map((e) => ({
    from: e.fromNode,
    fromOutput: e.fromOutput,
    to: e.toNode,
    toInput: e.toInput,
  }));

  return {
    nodes,
    connections,
    palette,
    // Drawing a wire validates (port kinds) + applies via the controller; false vetoes it (snap back).
    onConnect: (c) =>
      controller.connect({ fromNode: c.from, fromOutput: c.fromOutput, toNode: c.to, toInput: c.toInput }),
    onDisconnect: (c) =>
      controller.disconnect({
        fromNode: c.from,
        fromOutput: c.fromOutput,
        toNode: c.to,
        toInput: c.toInput,
      }),
    onAddNode: (type, position) => {
      const id = controller.addNode(type, position);
      const node = controller.document.nodes.find((n) => n.id === id);
      return node ? nodeToConfig(controller, node) : null;
    },
    onDeleteNode: (id) => controller.removeNode(id),
  };
}

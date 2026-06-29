import { Pane } from "tweakpane";
import type { BindingApi } from "@tweakpane/core";
import type { EditorGraphConfig, EditorNodeConfig, EditorPaletteItem } from "../../node-editor";
import type { MaterialGraphController } from "./graph/controller";
import { nodePorts } from "./graph/registry";
import { mountCurveWidget } from "./curve-widget";
import { mountInterfaceWidget } from "./interface-widget";
import {
  GROUP_INPUT_TYPE,
  GROUP_OUTPUT_TYPE,
  GROUP_TYPE,
  type CurveValue,
  type GraphNode,
  type ParamDef,
  type PortDef,
} from "./graph/types";

const OUTPUT_TYPE = "material-output";
// Nodes that can't be deleted from the canvas (terminal output + a subgraph's boundary markers).
const UNDELETABLE = new Set([OUTPUT_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);
// Boundary markers live only inside a subgraph — never offered in the add-node palette.
const PALETTE_HIDDEN = new Set([OUTPUT_TYPE, GROUP_INPUT_TYPE, GROUP_OUTPUT_TYPE]);

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
  // For declare-driven nodes, called after a non-live param change so the editor re-renders with the new
  // ports. Deferred (queueMicrotask) so the canvas rebuild doesn't dispose this Pane mid change-event.
  onPortsMaybeChanged?: () => void,
): void {
  // Curve params render a bespoke canvas editor (not a Tweakpane binding); it writes live via setParam.
  if (param.type === "curve") {
    mountCurveWidget(pane.element, controller, nodeId, param.key, local[param.key] as CurveValue);
    return;
  }
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
    case "vec3":
      // Tweakpane renders an {x,y,z} object as a 3-field vector input.
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
  binding.on("change", (ev) => {
    let value = ev.value;
    // Guard against a non-finite edit (e.g. clearing the numeric field) — committing NaN to a param
    // serialises to invalid WGSL and invalidates the whole shader. Drop back to the default instead.
    if ((param.type === "int" || param.type === "float") && !Number.isFinite(Number(value))) {
      value = param.default;
    }
    controller.setParam(nodeId, param.key, value);
    // Only `select` / `bool` params can change a node's ports (every declare() keys off a select: noiseType,
    // op, feature, operation). Rebuilding the whole editor on numeric edits (int/float) is unnecessary AND
    // disruptive — it disposes the live Tweakpane mid-edit, snapping sliders (e.g. `scale`) back. Restrict
    // the port-rebuild to the param types that actually affect ports.
    if (onPortsMaybeChanged && (param.type === "select" || param.type === "bool")) {
      queueMicrotask(onPortsMaybeChanged);
    }
  });
}

function paneMount(build: (pane: Pane) => void): (host: HTMLElement) => () => void {
  return (host) => {
    const pane = new Pane({ container: host });
    build(pane);
    return () => pane.dispose();
  };
}

// Group Input / Group Output nodes get an interface editor (add/rename/remove exposed sockets) instead
// of param controls. Returns the mount fn, or undefined for non-boundary nodes (fall back to params).
function groupBoundaryControls(
  controller: MaterialGraphController,
  node: GraphNode,
  ports: { inputs: PortDef[]; outputs: PortDef[] },
  rerender: () => void,
): ((host: HTMLElement) => () => void) | undefined {
  if (node.type !== GROUP_INPUT_TYPE && node.type !== GROUP_OUTPUT_TYPE) return undefined;
  // The boundary mirrors the interface on its opposite face: Group Input's *outputs* are the group's
  // inputs; Group Output's *inputs* are the group's outputs.
  const side = node.type === GROUP_INPUT_TYPE ? "input" : "output";
  const sockets = side === "input" ? ports.outputs : ports.inputs;
  return (host) => {
    mountInterfaceWidget(host, controller, side, sockets, rerender);
    return () => {};
  };
}

// Build the editor config for a single graph node (ports, generated controls, toggle, delete).
function nodeToConfig(
  controller: MaterialGraphController,
  node: GraphNode,
  rerender: () => void,
): EditorNodeConfig {
  const registry = controller.getRegistry();
  const def = registry.get(node.type);
  // A node's effective ports: instance-specific (groups) or the static def. See registry.nodePorts.
  const ports = nodePorts(node, registry);
  // A local mirror of params (defaults filled in) the Tweakpane controls bind to; changes forward to
  // the controller.
  const local: Record<string, unknown> = {};
  for (const p of def.params) {
    let v = node.params[p.key] ?? p.default;
    // Never surface a non-finite numeric param (a value corrupted to NaN by a transient empty field) in the
    // control — fall back to the default so the editor neither shows nor re-commits NaN.
    if ((p.type === "int" || p.type === "float") && !Number.isFinite(Number(v))) v = p.default;
    // vec3 / curve are objects mutated in place by their widgets — deep-copy so edits don't alias
    // node.params before they're committed via setParam.
    local[p.key] =
      p.type === "vec3" ? { ...(v as object) } : p.type === "curve" ? structuredClone(v) : v;
  }

  // Shader + output nodes aren't disable-able: bypassing a Principled/Emission would pass a raw colour
  // (not a bundle) to Material Output and break the unpack.
  const canToggle =
    ports.inputs.length > 0 && def.nodeClass !== "output" && def.nodeClass !== "shader";

  return {
    id: node.id,
    title: def.label,
    nodeClass: def.nodeClass,
    position: node.position,
    inputs: ports.inputs.map((p) => ({ key: p.key, label: p.label ?? p.key, kind: p.kind })),
    outputs: ports.outputs.map((p) => ({ key: p.key, label: p.label ?? p.key, kind: p.kind })),
    mountControls: groupBoundaryControls(controller, node, ports, rerender) ?? (
      def.params.length > 0
        ? paneMount((pane) => {
            for (const p of def.params)
              bindParam(pane, controller, node.id, p, local, def.declare ? rerender : undefined);
          })
        : undefined),
    enabled: node.enabled,
    onToggle: canToggle ? (enabled) => controller.setNodeEnabled(node.id, enabled) : undefined,
    deletable: !UNDELETABLE.has(node.type),
    // Group nodes are enterable: double-click descends into the subgraph, then re-render the canvas.
    onEnter:
      node.type === GROUP_TYPE
        ? () => {
            if (controller.enterGroup(node.id)) rerender();
          }
        : undefined,
  };
}

// `rerender` re-opens the editor with a fresh config — used by group enter/exit navigation, which swaps
// the active (sub)document. Defaults to a no-op for callers that don't navigate.
export function buildMaterialEditorConfig(
  controller: MaterialGraphController,
  rerender: () => void = () => {},
): EditorGraphConfig {
  const registry = controller.getRegistry();
  const doc = controller.activeDocument;

  const nodes: EditorNodeConfig[] = doc.nodes.map((node) => nodeToConfig(controller, node, rerender));

  // Palette: registered nodes except the terminal output and the subgraph boundary markers.
  const palette: EditorPaletteItem[] = registry
    .all()
    .filter((def) => !PALETTE_HIDDEN.has(def.type))
    .map((def) => ({ type: def.type, label: def.label, category: def.nodeClass }));

  const connections = doc.edges.map((e) => ({
    from: e.fromNode,
    fromOutput: e.fromOutput,
    to: e.toNode,
    toInput: e.toInput,
  }));

  // Breadcrumb: Material (root) → each entered group; clicking a crumb pops back to that depth.
  const path = controller.groupPath;
  const breadcrumb =
    path.length === 0
      ? undefined
      : [
          { label: "Material", onClick: () => (controller.exitToDepth(0), rerender()) },
          ...path.map((id, i) => ({
            label: id,
            onClick: () => (controller.exitToDepth(i + 1), rerender()),
          })),
        ];

  return {
    nodes,
    connections,
    palette,
    breadcrumb,
    onExit: path.length > 0 ? () => (controller.exitGroup(), rerender()) : undefined,
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
      const node = controller.activeDocument.nodes.find((n) => n.id === id);
      return node ? nodeToConfig(controller, node, rerender) : null;
    },
    onDeleteNode: (id) => controller.removeNode(id),
  };
}

import type { MaterialGraphController } from "./graph/controller";
import type { PortDef, PortKind } from "./graph/types";

// Group-interface editor, mounted on the Group Input / Group Output boundary nodes (Phase 5). Lists the
// group's exposed sockets for that side with rename + delete, plus an add row (name + kind). Each edit
// calls the controller (which prunes dangling wires and recompiles) then `rerender` to rebuild the
// canvas — controller edits don't auto-rebuild the Rete editor. `side` is "input" for the Group Input
// node (edits the group's inputs) and "output" for Group Output. Shader sockets aren't exposable through
// groups (our shader marker only flows Principled→Output — plan L1), so the kind picker omits it.
const KINDS: PortKind[] = ["float", "vector", "color"];

export function mountInterfaceWidget(
  host: HTMLElement,
  controller: MaterialGraphController,
  side: "input" | "output",
  sockets: PortDef[],
  rerender: () => void,
): void {
  const root = document.createElement("div");
  root.className = "iface-widget";

  const title = document.createElement("div");
  title.className = "iface-title";
  title.textContent = side === "input" ? "Group Inputs" : "Group Outputs";
  root.appendChild(title);

  for (const s of sockets) {
    const row = document.createElement("div");
    row.className = "iface-row";

    const dot = document.createElement("span");
    dot.className = "iface-dot";
    dot.dataset.kind = s.kind;
    row.appendChild(dot);

    const name = document.createElement("input");
    name.type = "text";
    name.value = s.label ?? s.key;
    name.className = "iface-name";
    const commit = () => {
      if (name.value.trim() && name.value.trim() !== (s.label ?? s.key)) {
        controller.renameGroupSocket(side, s.key, name.value);
        rerender();
      }
    };
    name.addEventListener("blur", commit);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") name.blur();
    });
    row.appendChild(name);

    const del = document.createElement("button");
    del.className = "iface-del";
    del.textContent = "✕";
    del.title = "Remove socket";
    del.onclick = () => {
      controller.removeGroupSocket(side, s.key);
      rerender();
    };
    row.appendChild(del);
    root.appendChild(row);
  }

  // Add row
  const add = document.createElement("div");
  add.className = "iface-row iface-add";
  const newName = document.createElement("input");
  newName.type = "text";
  newName.placeholder = "new socket";
  newName.className = "iface-name";
  const kind = document.createElement("select");
  kind.className = "iface-kind";
  for (const k of KINDS) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    kind.appendChild(o);
  }
  const addBtn = document.createElement("button");
  addBtn.className = "iface-addbtn";
  addBtn.textContent = "+";
  addBtn.title = "Add socket";
  addBtn.onclick = () => {
    controller.addGroupSocket(side, newName.value || "socket", kind.value as PortKind);
    rerender();
  };
  newName.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBtn.click();
  });
  add.append(newName, kind, addBtn);
  root.appendChild(add);

  host.appendChild(root);
}

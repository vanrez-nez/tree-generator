// The generic config contract the node editor consumes. This module is intentionally decoupled
// from any specific domain (e.g. the material graph): callers describe their graph as plain data
// plus a `mountControls` hook, and the editor renders it. The material side supplies this via an
// adapter (src/scene/material/editor-config.ts), so src/node-editor/ stays reusable.

/** Where the editor panel is anchored. */
export type DockMode = 'left' | 'top' | 'bottom'

export type EditorSocketConfig = {
  /** Unique-per-node key the connections reference. */
  key: string
  label?: string
  /** Port type; sockets with different kinds get distinct Socket instances (typed ports). */
  kind?: string
}

export type EditorNodeConfig = {
  id: string
  title: string
  /** Node class — drives the header colour (e.g. Blender's nclass: input/texture/color/…). */
  nodeClass?: string
  /** Canvas position; the editor lays nodes out from these (no auto-arrange). */
  position?: { x: number; y: number }
  inputs?: EditorSocketConfig[]
  outputs?: EditorSocketConfig[]
  /**
   * Mount this node's controls into `host` (e.g. a Tweakpane Pane bound to the node's params).
   * Return a disposer invoked when the node element unmounts.
   */
  mountControls?: (host: HTMLElement) => () => void
  /** Whether this node is currently soloed (its output previewed on the surface). Drives the eye highlight. */
  soloed?: boolean
  /** Provide to render the solo/preview (eye) button. Omit for nodes whose output can't be previewed. */
  onSolo?: () => void
  /** Whether the node shows a delete (×) button. Omit/false for terminal nodes (e.g. the output). */
  deletable?: boolean
  /** Provide to make the node "enterable" (double-click) — e.g. descend into a group's subgraph. */
  onEnter?: () => void
  /** Commit a renamed label (empty string clears back to the default). Omit to disable renaming. */
  onRename?: (label: string) => void
  /** Fallback title shown when the custom label is cleared. */
  defaultTitle?: string
}

/** A node type offered in the editor's add-node palette. */
export type EditorPaletteItem = {
  type: string
  label: string
  category?: string
}

export type EditorConnectionConfig = {
  from: string
  fromOutput: string
  to: string
  toInput: string
}

export type EditorGraphConfig = {
  nodes: EditorNodeConfig[]
  connections: EditorConnectionConfig[]
  /**
   * Called when the user draws a connection in the canvas (config-id terms). Return false to veto it
   * (e.g. incompatible port kinds); the wire snaps back. Omit to keep the topology read-only.
   */
  onConnect?: (connection: EditorConnectionConfig) => boolean
  /** Called when the user removes a connection in the canvas. */
  onDisconnect?: (connection: EditorConnectionConfig) => void
  /** Node types offered in the add-node palette. Omit to hide the palette button. */
  palette?: EditorPaletteItem[]
  /**
   * Create a node of `type` in the owner (e.g. the material controller) at `position`, and return its
   * editor config so the canvas can render it. Return null to abort.
   */
  onAddNode?: (type: string, position: { x: number; y: number }) => EditorNodeConfig | null
  /** Remove a node from the owner. The canvas removal is handled by the panel. */
  onDeleteNode?: (id: string) => void
  /** Export the current graph (e.g. download it as JSON). Provide to surface the header's export button. */
  onExport?: () => void
  /** Navigation trail (root → current group). Rendered as a clickable breadcrumb; omit/empty at root. */
  breadcrumb?: { label: string; onClick: () => void }[]
  /** Exit one navigation level (bound to Esc). Omit at the root. */
  onExit?: () => void
}

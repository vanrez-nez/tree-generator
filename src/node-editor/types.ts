// The generic config contract the node editor consumes. This module is intentionally decoupled
// from any specific domain (e.g. the material graph): callers describe their graph as plain data
// plus a `mountControls` hook, and the editor renders it. The material side supplies this via an
// adapter (src/scene/material/editor-config.ts), so src/node-editor/ stays reusable.

/** Where the editor panel is anchored. `fullscreen` (the "client" mode) hides the 3D preview. */
export type DockMode = 'left' | 'right' | 'top' | 'bottom' | 'fullscreen'

export type EditorSocketConfig = {
  /** Unique-per-node key the connections reference. */
  key: string
  label?: string
}

export type EditorNodeConfig = {
  id: string
  title: string
  /** Canvas position; the editor lays nodes out from these (no auto-arrange). */
  position?: { x: number; y: number }
  inputs?: EditorSocketConfig[]
  outputs?: EditorSocketConfig[]
  /**
   * Mount this node's controls into `host` (e.g. a Tweakpane Pane bound to the node's params).
   * Return a disposer invoked when the node element unmounts.
   */
  mountControls?: (host: HTMLElement) => () => void
  /** Current on/off state for the header eye toggle. */
  enabled?: boolean
  /** Provide to render the eye toggle. Omit for nodes that can't be disabled (e.g. a root). */
  onToggle?: (enabled: boolean) => void
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
}

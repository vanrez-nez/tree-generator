// Generic, reusable node-editor panel (Rete v2 + Lit). Decoupled from any domain: feed it an
// `EditorGraphConfig` (see types.ts) describing nodes, connections and per-node control mounts.
export { NodeEditorPanel } from './node-editor-panel'
export type { NodeEditorPanelOptions } from './node-editor-panel'
export type {
  DockMode,
  EditorGraphConfig,
  EditorNodeConfig,
  EditorConnectionConfig,
  EditorSocketConfig,
} from './types'

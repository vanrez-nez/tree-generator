// Shared eye glyphs for visibility/enable toggles. Used by the Tweakpane "Layers" blade
// (src/tweak-pane/layers-blade.ts) and the node editor's per-node on/off toggle
// (src/node-editor/). Kept as inline SVG strings so both DOM and Lit templates can embed them.

export const EYE_OPEN_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3.5C4.5 3.5 1.7 5.7 0.7 8c1 2.3 3.8 4.5 7.3 4.5S15.3 10.3 16.3 8C15.3 5.7 12.5 3.5 8 3.5Zm0 7.2A2.7 2.7 0 1 1 8 5.3a2.7 2.7 0 0 1 0 5.4Zm0-1.5A1.2 1.2 0 1 0 8 6.8a1.2 1.2 0 0 0 0 2.4Z"/></svg>'
export const EYE_CLOSED_SVG =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 3l11 11-1 1-2.2-2.2A8.6 8.6 0 0 1 8 12.5C4.5 12.5 1.7 10.3 0.7 8a9.2 9.2 0 0 1 2.6-3.1L1 3l1-1Zm6 2.3c1.5 0 2.7 1.2 2.7 2.7 0 .4-.1.8-.2 1.1L7.2 5.5c.3-.1.5-.2.8-.2ZM8 10.7c-1.5 0-2.7-1.2-2.7-2.7 0-.3.1-.6.2-.9l3.4 3.4c-.3.1-.6.2-.9.2Zm0-7.2c3.5 0 6.3 2.2 7.3 4.5-.4 1-1.1 1.9-1.9 2.6l-1-1A6.7 6.7 0 0 0 13.5 8C12.6 6.3 10.5 5 8 5c-.4 0-.8 0-1.2.1L5.7 4A8.9 8.9 0 0 1 8 3.5Z"/></svg>'

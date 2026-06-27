// Rete v2 schemes + the custom Lit elements that give the editor its look:
//  - `EditorNode`: a ClassicPreset.Node that also carries on/off + a controls-mount hook.
//  - `PaneControl`: a ClassicPreset.Control whose payload is a `mount(host)` callback (used to
//    drop a Tweakpane Pane straight into the node body).
//  - `<ne-node>`: a custom node element replicating Rete's default socket/control layout (via the
//    plugin's `<rete-ref>`) plus a header eye toggle, themed dark to sit next to Tweakpane.
//  - `<ne-pane-control>`: hosts the mounted controls and disposes them on unmount.
import { ClassicPreset, type GetSchemes } from 'rete'
import { LitElement, html, nothing, type PropertyValues } from 'lit'
import {
  createElement as createLucideElement,
  Eye,
  EyeOff,
  Trash2,
  type IconNode,
} from 'lucide'

const NODE_WIDTH = 288

export class EditorNode extends ClassicPreset.Node {
  width = NODE_WIDTH
  height = 0 // auto
  enabled = true
  enableable = false
  nodeClass?: string
  onToggle?: (enabled: boolean) => void
  onDelete?: () => void
  onEnter?: () => void
  mountControls?: (host: HTMLElement) => () => void
}

// Schemes use the base node type so the classic Lit/connection presets stay compatible; nodes are
// `EditorNode` instances at runtime and are measured/cast where arrange-specific width/height is needed.
export type Schemes = GetSchemes<
  ClassicPreset.Node,
  ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>
>

/** A control whose entire body is rendered by an external `mount` callback (e.g. a Tweakpane Pane). */
export class PaneControl extends ClassicPreset.Control {
  constructor(readonly mount: (host: HTMLElement) => () => void) {
    super()
  }
}

// Hosts externally-mounted controls (a Tweakpane Pane). A plain custom element — NOT a LitElement —
// so Lit never manages/clears its children; the preset sets `.control` before connection, we mount
// on connect and dispose on disconnect.
export class PaneControlElement extends HTMLElement {
  control: PaneControl | null = null
  private dispose: (() => void) | null = null

  connectedCallback(): void {
    if (this.control && !this.dispose) {
      this.dispose = this.control.mount(this)
    }
  }

  disconnectedCallback(): void {
    this.dispose?.()
    this.dispose = null
  }
}

// Custom node element. Mirrors the classic Lit preset's render (sockets + controls via <rete-ref>)
// and adds a header with the title and an optional eye toggle.
export class EditorNodeElement extends LitElement {
  static properties = {
    data: { attribute: false },
    emit: { attribute: false },
  }
  // `declare` (not a class field) so Lit's reactive accessors from `static properties` aren't
  // shadowed — otherwise `.data`/`.emit` assignments wouldn't trigger re-render (class-field-shadowing).
  declare data: EditorNode
  declare emit: (props: unknown) => void

  // Light DOM (not shadow) so Tweakpane's globally-injected stylesheet reaches the embedded panes.
  // Node chrome is styled from node-editor.css via `ne-node` selectors.
  protected createRenderRoot(): HTMLElement {
    return this
  }

  // Restrict node dragging to the title bar: swallow pointerdown on the body so Rete's node-drag
  // (listening on an ancestor) never starts there, leaving Tweakpane's sliders/controls free.
  private readonly stopDrag = (event: Event): void => {
    event.stopPropagation()
  }

  private sortByIndex<T extends [string, undefined | { index?: number }]>(entries: T[]): void {
    entries.sort((a, b) => (a[1]?.index || 0) - (b[1]?.index || 0))
  }

  render() {
    if (!this.data) return nothing
    const { id, label } = this.data
    const inputs = Object.entries(this.data.inputs) as [string, ClassicPreset.Input<ClassicPreset.Socket>][]
    const outputs = Object.entries(this.data.outputs) as [string, ClassicPreset.Output<ClassicPreset.Socket>][]
    const controls = Object.entries(this.data.controls) as [string, ClassicPreset.Control][]
    this.sortByIndex(inputs)
    this.sortByIndex(outputs)
    this.sortByIndex(controls)

    this.classList.toggle('selected', Boolean(this.data.selected))
    this.classList.toggle('disabled', this.data.enableable && !this.data.enabled)

    const eye =
      this.data.enableable && this.data.onToggle
        ? html`<button
            class="eye ${this.data.enabled ? '' : 'off'}"
            title=${this.data.enabled ? 'Disable node' : 'Enable node'}
            @pointerdown=${(e: Event) => e.stopPropagation()}
            @click=${(e: Event) => {
              e.stopPropagation()
              const next = !this.data.enabled
              this.data.enabled = next
              this.data.onToggle?.(next)
              this.requestUpdate() // `data` is mutated in place, so prompt a re-render of the eye
            }}
          >
            ${lucideIcon(this.data.enabled ? Eye : EyeOff)}
          </button>`
        : nothing

    const del = this.data.onDelete
      ? html`<button
          class="ne-del"
          title="Delete node"
          @pointerdown=${(e: Event) => e.stopPropagation()}
          @click=${(e: Event) => {
            e.stopPropagation()
            this.data.onDelete?.()
          }}
        >
          ${lucideIcon(Trash2)}
        </button>`
      : nothing

    const enterable = Boolean(this.data.onEnter)
    return html`
      <div
        class="title ${enterable ? 'enterable' : ''}"
        data-testid="title"
        data-class=${this.data.nodeClass ?? nothing}
        title=${enterable ? 'Double-click to enter group' : 'Double-click to zoom to node'}
      >
        <span class="title-text">${label}</span>
        ${eye}${del}
      </div>
      <div class="ports outputs" @pointerdown=${this.stopDrag}>
        ${outputs.map(([key, output]) =>
          output
            ? html`<div class="output" data-testid=${'output-' + key}>
                <div class="output-title">${output.label}</div>
                <span class="output-socket" data-kind=${output.socket.name ?? nothing}>
                  <rete-ref
                    .data=${{ type: 'socket', side: 'output', key, nodeId: id, payload: output.socket }}
                    .emit=${this.emit}
                  ></rete-ref>
                </span>
              </div>`
            : nothing,
        )}
      </div>
      <div class="controls" @pointerdown=${this.stopDrag}>
        ${controls.map(([key, control]) =>
          control
            ? html`<span class="control" data-testid=${'control-' + key}>
                <rete-ref .emit=${this.emit} .data=${{ type: 'control', payload: control }}></rete-ref>
              </span>`
            : nothing,
        )}
      </div>
      <div class="ports inputs" @pointerdown=${this.stopDrag}>
        ${inputs.map(([key, input]) =>
          input
            ? html`<div class="input" data-testid=${'input-' + key}>
                <span class="input-socket" data-kind=${input.socket.name ?? nothing}>
                  <rete-ref
                    .data=${{ type: 'socket', side: 'input', key, nodeId: id, payload: input.socket }}
                    .emit=${this.emit}
                  ></rete-ref>
                </span>
                <div class="input-title">${input.label}</div>
              </div>`
            : nothing,
        )}
      </div>
    `
  }

  updated(changed: PropertyValues): void {
    super.updated(changed)
    // Mirror Rete's expectation that the element reports an `auto` height when not fixed.
    this.style.width = `${this.data?.width ?? NODE_WIDTH}px`
  }
}

function lucideIcon(icon: IconNode): SVGElement {
  const element = createLucideElement(icon, {
    'aria-hidden': 'true',
    height: 14,
    stroke: 'currentColor',
    width: 14,
  })
  element.classList.add('lucide-icon')
  return element
}

let defined = false
/** Register the custom elements once (idempotent). */
export function defineEditorElements(): void {
  if (defined) return
  defined = true
  customElements.define('ne-pane-control', PaneControlElement)
  customElements.define('ne-node', EditorNodeElement)
}

// A dockable panel hosting a Rete v2 node editor. The graph is supplied as a plain `EditorGraphConfig`
// (decoupled — see types.ts) and is treated as read-only topology: nodes/connections are placed
// programmatically and user-initiated create/remove is vetoed, so the underlying fixed pipeline can't
// be broken from the UI. Docking is done by padding `#app` on the docked edge so the (fullscreen)
// 3D canvas shrinks into the remaining area and the existing resize handler picks it up.
import { NodeEditor, ClassicPreset } from 'rete'
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin'
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin'
import { LitPlugin, Presets as LitPresets, type LitArea2D } from '@retejs/lit-plugin'
import { html } from 'lit'
import {
  createElement as createLucideElement,
  Maximize,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  Scan,
  X,
  ZoomIn,
  ZoomOut,
  type IconNode,
} from 'lucide'
import {
  EditorNode,
  PaneControl,
  type Schemes,
  defineEditorElements,
} from './rete-elements'
import type { DockMode, EditorGraphConfig } from './types'
import './node-editor.css'

type AreaExtra = LitArea2D<Schemes>

export type NodeEditorPanelOptions = {
  /** Where the panel attaches; defaults to `document.body`. */
  host?: HTMLElement
  /** The element to pad so the 3D canvas reflows when docking; defaults to `#app`. */
  appElement?: HTMLElement
  /** Invoked (next frame) whenever the docked gutter changes, so the host can re-run its resize. */
  onLayoutChange?: () => void
}

const DOCK_MODES: DockMode[] = ['left', 'right', 'top', 'bottom', 'fullscreen']
// Minimum docked extent, and the room always left for the rest of the app on the opposite side.
const MIN_SIDE = 260
const MIN_STRIP = 180
const EDGE_MARGIN = 120
const DEFAULT_FRACTION = 0.5 // docked panels default to 50% of the viewport

// Zoom is via the header buttons only (the wheel pans instead). Clamped to this range; each button
// press multiplies/divides by ZOOM_STEP.
const MIN_ZOOM = 0.1
const MAX_ZOOM = 2.5
const ZOOM_STEP = 1.2
// Empty breathing room kept around the node graph (in rem), so connectors never sit flush against
// the panel edges. Baked into the content bounds used for panning + centring, and into the fit gap.
const CONTENT_PADDING_REM = 5
const FIT_SCALE = 0.8 // zoomAt gap to the viewport border on "fit" (lower = more margin)

export class NodeEditorPanel {
  private readonly root: HTMLDivElement
  private readonly canvasHost: HTMLDivElement
  private readonly handle: HTMLDivElement
  private readonly appElement: HTMLElement
  private readonly onLayoutChange?: () => void

  private editor: NodeEditor<Schemes> | null = null
  private area: AreaPlugin<Schemes, AreaExtra> | null = null
  private building = false
  private open_ = false

  // Docked size in px (width for left/right, height for top/bottom). Defaults to 50% of the viewport
  // until the user drags the resize handle.
  private mode: DockMode = 'right'
  private sideSize = Math.round(window.innerWidth * DEFAULT_FRACTION)
  private stripSize = Math.round(window.innerHeight * DEFAULT_FRACTION)
  private sizeUserSet = false
  private dragStart: { x: number; y: number; size: number } | null = null

  constructor(options: NodeEditorPanelOptions = {}) {
    defineEditorElements()
    this.appElement = options.appElement ?? (document.getElementById('app') as HTMLElement)
    this.onLayoutChange = options.onLayoutChange

    this.root = document.createElement('div')
    this.root.className = 'ne-panel'
    this.root.hidden = true

    const header = document.createElement('div')
    header.className = 'ne-header'
    const title = document.createElement('span')
    title.className = 'ne-header__title'
    title.textContent = 'Material'
    header.appendChild(title)

    // Zoom controls: out / fit / in (wheel pans instead of zooming — see `ensureEditor`).
    const zoom = document.createElement('div')
    zoom.className = 'ne-zoom'
    const zoomBtn = (icon: IconNode, label: string, onClick: () => void): void => {
      const b = document.createElement('button')
      b.className = 'ne-dock__btn'
      b.title = label
      b.setAttribute('aria-label', label)
      appendLucideIcon(b, icon)
      b.addEventListener('click', onClick)
      zoom.appendChild(b)
    }
    zoomBtn(ZoomOut, 'Zoom out', () => void this.zoomBy(1 / ZOOM_STEP))
    zoomBtn(Scan, 'Fit to view', () => void this.zoomToFit())
    zoomBtn(ZoomIn, 'Zoom in', () => void this.zoomBy(ZOOM_STEP))
    header.appendChild(zoom)

    const dock = document.createElement('div')
    dock.className = 'ne-dock'
    for (const m of DOCK_MODES) {
      const btn = document.createElement('button')
      btn.className = `ne-dock__btn ne-dock__btn--${m}`
      btn.dataset.mode = m
      btn.title = m === 'fullscreen' ? 'Fullscreen' : `Dock ${m}`
      btn.setAttribute('aria-label', btn.title)
      appendLucideIcon(btn, DOCK_ICON[m])
      btn.addEventListener('click', () => this.setDockMode(m))
      dock.appendChild(btn)
    }
    header.appendChild(dock)

    const close = document.createElement('button')
    close.className = 'ne-header__close'
    close.title = 'Close'
    close.setAttribute('aria-label', 'Close')
    appendLucideIcon(close, X)
    close.addEventListener('click', () => this.close())
    header.appendChild(close)

    this.canvasHost = document.createElement('div')
    this.canvasHost.className = 'ne-canvas'

    // Drag handle on the panel's inner edge (repositioned per dock mode in `applyDock`).
    this.handle = document.createElement('div')
    this.handle.className = 'ne-resize'
    this.handle.addEventListener('pointerdown', this.onHandleDown)

    this.root.appendChild(header)
    this.root.appendChild(this.canvasHost)
    this.root.appendChild(this.handle)
    ;(options.host ?? document.body).appendChild(this.root)
  }

  isOpen(): boolean {
    return this.open_
  }

  open(config: EditorGraphConfig, mode: DockMode = 'right'): void {
    this.root.hidden = false
    this.open_ = true
    this.appElement.classList.add('editor-open')
    this.applyDock(mode)
    void this.rebuild(config)
  }

  close(): void {
    if (!this.open_) return
    this.open_ = false
    this.root.hidden = true
    this.appElement.classList.remove('editor-open')
    this.clearAppPadding()
    this.notifyLayout()
  }

  setDockMode(mode: DockMode): void {
    if (!this.open_) return
    this.applyDock(mode)
    // Refit the graph into the new viewport.
    requestAnimationFrame(() => void this.zoomToFit())
  }

  dispose(): void {
    this.canvasHost.removeEventListener('wheel', this.onWheelPan)
    this.area?.destroy()
    this.area = null
    this.editor = null
    this.root.remove()
    this.appElement.classList.remove('editor-open')
    this.clearAppPadding()
  }

  // --- internals ---------------------------------------------------------

  private applyDock(mode: DockMode): void {
    this.mode = mode
    for (const m of DOCK_MODES) this.root.classList.toggle(`ne-panel--${m}`, m === mode)
    this.root
      .querySelectorAll<HTMLButtonElement>('.ne-dock__btn')
      .forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode))
    // Position the resize handle on the inner edge (none in fullscreen).
    this.handle.className = `ne-resize ne-resize--${mode}`
    this.handle.hidden = mode === 'fullscreen'
    this.applySize()
  }

  // Set the panel's inline size + the matching #app padding for the current mode, then notify the
  // host so the 3D canvas reflows. Until the user drags, the size tracks 50% of the live viewport.
  private applySize(): void {
    if (!this.sizeUserSet) {
      this.sideSize = Math.round(window.innerWidth * DEFAULT_FRACTION)
      this.stripSize = Math.round(window.innerHeight * DEFAULT_FRACTION)
    }
    const root = this.root.style
    root.width = ''
    root.height = ''
    this.clearAppPadding()
    const app = this.appElement.style

    if (this.mode === 'left' || this.mode === 'right') {
      this.sideSize = clamp(this.sideSize, MIN_SIDE, window.innerWidth - EDGE_MARGIN)
      root.width = `${this.sideSize}px`
      app[this.mode === 'left' ? 'paddingLeft' : 'paddingRight'] = `${this.sideSize}px`
    } else if (this.mode === 'top' || this.mode === 'bottom') {
      this.stripSize = clamp(this.stripSize, MIN_STRIP, window.innerHeight - EDGE_MARGIN)
      root.height = `${this.stripSize}px`
      app[this.mode === 'top' ? 'paddingTop' : 'paddingBottom'] = `${this.stripSize}px`
    } else {
      // fullscreen: panel covers everything; canvas hidden via .editor-open--full
      this.appElement.classList.add('editor-open--full')
    }
    this.notifyLayout()
  }

  private clearAppPadding(): void {
    const s = this.appElement.style
    s.paddingLeft = s.paddingRight = s.paddingTop = s.paddingBottom = ''
    this.appElement.classList.remove('editor-open--full')
  }

  private readonly onHandleDown = (event: PointerEvent): void => {
    if (this.mode === 'fullscreen') return
    event.preventDefault()
    const horizontal = this.mode === 'left' || this.mode === 'right'
    this.dragStart = {
      x: event.clientX,
      y: event.clientY,
      size: horizontal ? this.sideSize : this.stripSize,
    }
    this.sizeUserSet = true
    this.handle.setPointerCapture(event.pointerId)
    this.handle.addEventListener('pointermove', this.onHandleMove)
    this.handle.addEventListener('pointerup', this.onHandleUp)
    document.body.classList.add('ne-resizing')
  }

  private readonly onHandleMove = (event: PointerEvent): void => {
    if (!this.dragStart) return
    const { x, y, size } = this.dragStart
    // The handle sits on the inner edge, so growth direction is toward the viewport centre.
    if (this.mode === 'right') this.sideSize = size - (event.clientX - x)
    else if (this.mode === 'left') this.sideSize = size + (event.clientX - x)
    else if (this.mode === 'bottom') this.stripSize = size - (event.clientY - y)
    else if (this.mode === 'top') this.stripSize = size + (event.clientY - y)
    this.applySize()
  }

  private readonly onHandleUp = (event: PointerEvent): void => {
    this.dragStart = null
    this.handle.releasePointerCapture(event.pointerId)
    this.handle.removeEventListener('pointermove', this.onHandleMove)
    this.handle.removeEventListener('pointerup', this.onHandleUp)
    document.body.classList.remove('ne-resizing')
    requestAnimationFrame(() => void this.zoomToFit())
  }

  // The 3D canvas reflows via a ResizeObserver on the canvas (set up by the host), so changing the
  // #app padding is enough — no window 'resize' event needed. `onLayoutChange` stays as an optional
  // hook for hosts that want an explicit signal.
  private notifyLayout(): void {
    requestAnimationFrame(() => this.onLayoutChange?.())
  }

  private ensureEditor(): void {
    if (this.editor) return

    const editor = new NodeEditor<Schemes>()
    const area = new AreaPlugin<Schemes, AreaExtra>(this.canvasHost)
    const connection = new ConnectionPlugin<Schemes, AreaExtra>()
    const render = new LitPlugin<Schemes, AreaExtra>()

    render.addPreset(
      LitPresets.classic.setup({
        customize: {
          node: (context) => {
            const payload = context.payload as EditorNode
            return ({ emit }) => html`<ne-node .data=${payload} .emit=${emit}></ne-node>`
          },
          control: (context) => {
            const payload = context.payload
            if (payload instanceof PaneControl) {
              return () => html`<ne-pane-control .control=${payload}></ne-pane-control>`
            }
            return () => html`<rete-control .data=${payload}></rete-control>`
          },
        },
      }),
    )

    connection.addPreset(ConnectionPresets.classic.setup())

    AreaExtensions.selectableNodes(area, AreaExtensions.selector(), {
      accumulating: AreaExtensions.accumulateOnCtrl(),
    })
    AreaExtensions.simpleNodesOrder(area)

    editor.use(area)
    area.use(connection)
    area.use(render)

    // Wheel pans (zoom is buttons-only): disable the built-in wheel/pinch zoom and translate on wheel.
    area.area.setZoomHandler(null)
    this.canvasHost.addEventListener('wheel', this.onWheelPan, { passive: false })

    // Clamp button-zoom to range, and keep any pan (wheel or background drag) within the content
    // bounds. The wheel handler pre-clamps, so this mainly catches drag-pan; the `clamping` flag
    // prevents the corrective translate from recursing.
    let clamping = false
    area.addPipe(async (context) => {
      if (context.type === 'zoom' && (context.data.zoom < MIN_ZOOM || context.data.zoom > MAX_ZOOM)) {
        return undefined
      }
      if (context.type === 'translated' && !clamping) {
        const t = area.area.transform
        const c = this.clampedXY(t.x, t.y)
        if (Math.abs(c.x - t.x) > 0.5 || Math.abs(c.y - t.y) > 0.5) {
          clamping = true
          await area.area.translate(c.x, c.y)
          clamping = false
        }
      }
      return context
    })

    // Read-only topology: veto user-initiated connection create/remove (programmatic build sets
    // `building` so our own additions pass).
    editor.addPipe((context) => {
      if (
        !this.building &&
        (context.type === 'connectioncreate' || context.type === 'connectionremove')
      ) {
        return undefined
      }
      return context
    })

    this.editor = editor
    this.area = area
  }

  private async rebuild(config: EditorGraphConfig): Promise<void> {
    this.ensureEditor()
    const editor = this.editor!
    const area = this.area!

    this.building = true
    // Clear any previous graph.
    for (const conn of [...editor.getConnections()]) await editor.removeConnection(conn.id)
    for (const node of [...editor.getNodes()]) await editor.removeNode(node.id)

    const byId = new Map<string, EditorNode>()
    for (const def of config.nodes) {
      const node = new EditorNode(def.title)
      node.enabled = def.enabled ?? true
      node.enableable = Boolean(def.onToggle)
      node.onToggle = def.onToggle
      node.mountControls = def.mountControls

      const socket = new ClassicPreset.Socket('socket')
      for (const input of def.inputs ?? []) {
        node.addInput(input.key, new ClassicPreset.Input(socket, input.label, false))
      }
      for (const output of def.outputs ?? []) {
        node.addOutput(output.key, new ClassicPreset.Output(socket, output.label, true))
      }
      if (def.mountControls) {
        node.addControl('params', new PaneControl(def.mountControls))
      }

      await editor.addNode(node)
      if (def.position) await area.translate(node.id, def.position)
      byId.set(def.id, node)
    }

    for (const c of config.connections) {
      const from = byId.get(c.from) as ClassicPreset.Node | undefined
      const to = byId.get(c.to) as ClassicPreset.Node | undefined
      if (!from || !to) continue
      await editor.addConnection(
        new ClassicPreset.Connection(from, c.fromOutput as never, to, c.toInput as never),
      )
    }
    this.building = false

    requestAnimationFrame(() => void this.zoomToFit())
  }

  private async zoomToFit(): Promise<void> {
    if (!this.area || !this.editor) return
    await AreaExtensions.zoomAt(this.area, this.editor.getNodes(), { scale: FIT_SCALE })
  }

  // Zoom (button-driven) around the viewport centre, clamped to [MIN_ZOOM, MAX_ZOOM]; re-clamp the
  // pan afterwards since the content's on-screen extent changed.
  private async zoomBy(factor: number): Promise<void> {
    const area = this.area
    if (!area) return
    const k = clamp(area.area.transform.k * factor, MIN_ZOOM, MAX_ZOOM)
    if (k === area.area.transform.k) return
    await area.area.zoom(k, this.canvasHost.clientWidth / 2, this.canvasHost.clientHeight / 2)
    this.clampPan()
  }

  private readonly onWheelPan = (event: WheelEvent): void => {
    event.preventDefault()
    let dx = event.deltaX
    let dy = event.deltaY
    if (event.shiftKey && dx === 0) {
      dx = dy
      dy = 0
    }
    // Scroll down/right reveals lower/right content, i.e. translate the content the opposite way.
    this.panBy(-dx, -dy)
  }

  private panBy(dx: number, dy: number): void {
    const area = this.area
    if (!area) return
    const t = area.area.transform
    const c = this.clampedXY(t.x + dx, t.y + dy)
    void area.area.translate(c.x, c.y)
  }

  private clampPan(): void {
    const area = this.area
    if (!area) return
    const t = area.area.transform
    const c = this.clampedXY(t.x, t.y)
    if (Math.abs(c.x - t.x) > 0.5 || Math.abs(c.y - t.y) > 0.5) void area.area.translate(c.x, c.y)
  }

  // Content bounds in world (pre-transform) coords, from the node views' positions + element sizes,
  // expanded by CONTENT_PADDING_REM so the clamp always leaves breathing room around the connectors.
  private contentBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    const area = this.area
    if (!area || area.nodeViews.size === 0) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const view of area.nodeViews.values()) {
      const { x, y } = view.position
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x + view.element.offsetWidth)
      y1 = Math.max(y1, y + view.element.offsetHeight)
    }
    const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
    const pad = CONTENT_PADDING_REM * remPx
    return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
  }

  // Clamp a desired pan offset so the content can't be scrolled into empty space. An axis whose
  // content fits the viewport (minus PAN_MARGIN) locks to centre — i.e. "no pan if nothing to pan".
  private clampedXY(x: number, y: number): { x: number; y: number } {
    const area = this.area
    const bounds = this.contentBounds()
    if (!area || !bounds) return { x, y }
    const k = area.area.transform.k
    const axis = (value: number, lo: number, hi: number, viewport: number): number => {
      // `lo`/`hi` already include CONTENT_PADDING_REM. Padded content fits → lock to centre (no pan).
      if ((hi - lo) * k <= viewport) return (viewport - (lo + hi) * k) / 2
      // Padded content overflows → scroll until the padded edge meets the viewport edge.
      return clamp(value, viewport - hi * k, -lo * k)
    }
    return {
      x: axis(x, bounds.x0, bounds.x1, this.canvasHost.clientWidth),
      y: axis(y, bounds.y0, bounds.y1, this.canvasHost.clientHeight),
    }
  }
}

const DOCK_ICON: Record<DockMode, IconNode> = {
  left: PanelLeft,
  right: PanelRight,
  top: PanelTop,
  bottom: PanelBottom,
  fullscreen: Maximize,
}

function appendLucideIcon(button: HTMLButtonElement, icon: IconNode): void {
  const element = createLucideElement(icon, {
    'aria-hidden': 'true',
    height: 14,
    stroke: 'currentColor',
    width: 14,
  })
  element.classList.add('lucide-icon')
  button.appendChild(element)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

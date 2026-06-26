// A dockable panel hosting a Rete v2 node editor. The graph is supplied as a plain `EditorGraphConfig`
// (decoupled — see types.ts) and is treated as read-only topology: nodes/connections are placed
// programmatically and user-initiated create/remove is vetoed, so the underlying fixed pipeline can't
// be broken from the UI. Docking is done by padding `#app` on the docked edge so the 3D canvas
// shrinks into the remaining area and the existing resize handler picks it up.
import { NodeEditor, ClassicPreset, type GetSchemes } from 'rete'
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin'
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin'
import { LitPlugin, Presets as LitPresets, type LitArea2D } from '@retejs/lit-plugin'
import {
  AutoArrangePlugin,
  Presets as ArrangePresets,
} from 'rete-auto-arrange-plugin'
import type { LayoutOptions } from 'elkjs'
import { html } from 'lit'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  createElement as createLucideElement,
  PanelBottom,
  PanelLeft,
  PanelTop,
  Plus,
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
import type { DockMode, EditorConnectionConfig, EditorGraphConfig, EditorNodeConfig } from './types'
import './node-editor.css'

type AreaExtra = LitArea2D<Schemes>
type ArrangeNode = ClassicPreset.Node & {
  height: number
  parent?: string
  width: number
}
type ArrangeConnection = ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node>
type ArrangeSchemes = GetSchemes<ArrangeNode, ArrangeConnection>
type LayoutArrangement = 'down' | 'right' | 'up' | 'left'
type StoredPositions = Record<string, { x: number; y: number }>

export type NodeEditorPanelOptions = {
  /** Where the panel attaches; defaults to `document.body`. */
  host?: HTMLElement
  /** The element to pad so the 3D canvas reflows when docking; defaults to `#app`. */
  appElement?: HTMLElement
  /** Invoked (next frame) whenever the docked gutter changes, so the host can re-run its resize. */
  onLayoutChange?: () => void
}

const DOCK_MODES: DockMode[] = ['left', 'top', 'bottom']
const LAYOUT_ARRANGEMENTS: LayoutArrangement[] = ['down', 'right', 'up', 'left']
// Minimum docked extent, and the room always left for the rest of the app on the opposite side.
const MIN_SIDE = 260
const MIN_STRIP = 180
const EDGE_MARGIN = 120
const MIN_CONTROL_VIEWPORT = 220
const DEFAULT_FRACTION = 0.5 // docked panels default to 50% of the viewport

// Zoom is via the header buttons or Shift + wheel. Clamped to this range; each step
// multiplies/divides by ZOOM_STEP.
const MIN_ZOOM = 0.1
const MAX_ZOOM = 2.5
const ZOOM_STEP = 1.2
const WHEEL_LINE_DELTA_PX = 16
const WHEEL_PAGE_DELTA_PX = 100
const WHEEL_ZOOM_BASE = 0.95
const WHEEL_ZOOM_SPEED = 1
// Empty breathing room kept around the node graph (in rem), so connectors never sit flush against
// the panel edges. Baked into the content bounds used for panning + centring, and into the fit gap.
const CONTENT_PADDING_REM = 5
const FIT_SCALE = 0.8 // zoomAt gap to the viewport border on "fit" (lower = more margin)
const STORAGE_PREFIX = 'tree-graph:node-editor:positions:v1'

export class NodeEditorPanel {
  private readonly root: HTMLDivElement
  private readonly canvasHost: HTMLDivElement
  private readonly handle: HTMLDivElement
  private readonly appElement: HTMLElement
  private readonly onLayoutChange?: () => void
  // Add-node palette (button + dropdown menu); populated per-config in populatePalette.
  private readonly paletteWrap: HTMLDivElement
  private readonly paletteMenu: HTMLDivElement

  private editor: NodeEditor<Schemes> | null = null
  private area: AreaPlugin<Schemes, AreaExtra> | null = null
  private arrange: AutoArrangePlugin<ArrangeSchemes> | null = null
  private building = false
  private open_ = false
  private layoutArrangement: LayoutArrangement = 'down'
  private storageKey: string | null = null
  private nodeIdsByRuntimeId = new Map<string, string>()
  // The active config, so the connection pipe can call its onConnect/onDisconnect hooks.
  private config: EditorGraphConfig | null = null
  // One Socket instance per port kind (typed ports), reused across rebuilds.
  private readonly sockets = new Map<string, ClassicPreset.Socket>()

  // Docked size in px (width for left, height for top/bottom). Defaults to 50% of the viewport
  // until the user drags the resize handle.
  private mode: DockMode = 'bottom'
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

    // Add-node palette: a button toggling a menu of node types (filled per config in populatePalette).
    this.paletteWrap = document.createElement('div')
    this.paletteWrap.className = 'ne-palette'
    this.paletteWrap.hidden = true
    const paletteBtn = document.createElement('button')
    paletteBtn.className = 'ne-dock__btn'
    paletteBtn.title = 'Add node'
    paletteBtn.setAttribute('aria-label', 'Add node')
    appendLucideIcon(paletteBtn, Plus)
    this.paletteMenu = document.createElement('div')
    this.paletteMenu.className = 'ne-palette__menu'
    this.paletteMenu.hidden = true
    paletteBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.paletteMenu.hidden = !this.paletteMenu.hidden
    })
    document.addEventListener('click', () => {
      this.paletteMenu.hidden = true
    })
    this.paletteWrap.append(paletteBtn, this.paletteMenu)
    header.appendChild(this.paletteWrap)

    // Zoom controls: out / fit / in (plain wheel pans; Shift + wheel zooms — see `ensureEditor`).
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

    const layout = document.createElement('div')
    layout.className = 'ne-layout'
    for (const arrangement of LAYOUT_ARRANGEMENTS) {
      const btn = document.createElement('button')
      btn.className = 'ne-dock__btn'
      btn.dataset.arrangement = arrangement
      btn.title = `Auto layout ${arrangement}`
      btn.setAttribute('aria-label', btn.title)
      appendLucideIcon(btn, LAYOUT_ICON[arrangement])
      btn.addEventListener('click', () => this.setLayoutArrangement(arrangement))
      layout.appendChild(btn)
    }
    header.appendChild(layout)

    const dock = document.createElement('div')
    dock.className = 'ne-dock'
    for (const m of DOCK_MODES) {
      const btn = document.createElement('button')
      btn.className = `ne-dock__btn ne-dock__btn--${m}`
      btn.dataset.mode = m
      btn.title = `Dock ${m}`
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
    const tip = document.createElement('div')
    tip.className = 'ne-canvas__tip'
    tip.textContent = 'Shift + Scroll to Zoom'
    this.canvasHost.appendChild(tip)

    // Drag handle on the panel's inner edge (repositioned per dock mode in `applyDock`).
    this.handle = document.createElement('div')
    this.handle.className = 'ne-resize'
    this.handle.addEventListener('pointerdown', this.onHandleDown)

    this.root.appendChild(header)
    this.root.appendChild(this.canvasHost)
    this.root.appendChild(this.handle)
    ;(options.host ?? document.body).appendChild(this.root)
    this.updateLayoutButtons()
  }

  isOpen(): boolean {
    return this.open_
  }

  open(config: EditorGraphConfig, mode: DockMode = 'bottom'): void {
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
    // Reflow the selected arrangement into the changed viewport, then refit.
    requestAnimationFrame(() => void this.arrangeGraph())
  }

  setLayoutArrangement(arrangement: LayoutArrangement): void {
    this.layoutArrangement = arrangement
    this.updateLayoutButtons()
    requestAnimationFrame(() => void this.arrangeGraph())
  }

  dispose(): void {
    this.canvasHost.removeEventListener('wheel', this.onWheelPan)
    this.area?.destroy()
    this.area = null
    this.arrange = null
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
    // Position the resize handle on the inner edge.
    this.handle.className = `ne-resize ne-resize--${mode}`
    this.handle.hidden = false
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

    if (this.mode === 'left') {
      this.sideSize = clamp(this.sideSize, MIN_SIDE, window.innerWidth - EDGE_MARGIN)
      root.width = `${this.sideSize}px`
      app.paddingLeft = `${this.sideSize}px`
    } else if (this.mode === 'top' || this.mode === 'bottom') {
      const maxStrip = Math.max(96, window.innerHeight - MIN_CONTROL_VIEWPORT)
      this.stripSize = clamp(this.stripSize, Math.min(MIN_STRIP, maxStrip), maxStrip)
      root.height = `${this.stripSize}px`
      app[this.mode === 'top' ? 'paddingTop' : 'paddingBottom'] = `${this.stripSize}px`
      app.setProperty(`--node-editor-${this.mode}-inset`, `${this.stripSize}px`)
    }
    this.notifyLayout()
  }

  private clearAppPadding(): void {
    const s = this.appElement.style
    s.paddingLeft = s.paddingRight = s.paddingTop = s.paddingBottom = ''
    s.removeProperty('--node-editor-top-inset')
    s.removeProperty('--node-editor-bottom-inset')
  }

  private readonly onHandleDown = (event: PointerEvent): void => {
    event.preventDefault()
    const horizontal = this.mode === 'left'
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
    if (this.mode === 'left') this.sideSize = size + (event.clientX - x)
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
    const arrange = new AutoArrangePlugin<ArrangeSchemes>()

    arrange.addPreset(ArrangePresets.classic.setup({ spacing: 34, top: 48, bottom: 24 }))

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
    area.use(arrange as never)

    // Plain wheel pans. Shift + wheel zooms through our handler, so disable Rete's built-in wheel zoom.
    area.area.setZoomHandler(null)
    this.canvasHost.addEventListener('wheel', this.onWheelPan, { passive: false })

    // Clamp zoom to range, and keep any pan (wheel or background drag) within the content
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
      if (context.type === 'nodetranslated' && !this.building) {
        this.saveNodePositions()
      }
      return context
    })

    // User-driven topology edits. Programmatic build sets `building` so our own additions pass through
    // untouched. A config without onConnect stays read-only (the hooks veto every user edit).
    editor.addPipe(async (context) => {
      if (this.building) return context

      if (context.type === 'connectioncreate') {
        const conn = this.toConfigConnection(context.data)
        // No hook, or the owner rejects it (e.g. incompatible port kinds) → veto; the wire snaps back.
        if (!conn || !this.config?.onConnect || !this.config.onConnect(conn)) return undefined
        // Single input per socket: drop any existing wire into the same input first.
        await this.removeConnectionsIntoInput(context.data.target, context.data.targetInput, context.data.id)
        return context
      }

      if (context.type === 'connectionremove') {
        const conn = this.toConfigConnection(context.data)
        if (conn) this.config?.onDisconnect?.(conn)
        return context
      }

      return context
    })

    this.editor = editor
    this.area = area
    this.arrange = arrange
  }

  private async rebuild(config: EditorGraphConfig): Promise<void> {
    this.ensureEditor()
    const editor = this.editor!

    this.config = config
    this.building = true
    // Clear any previous graph.
    for (const conn of [...editor.getConnections()]) await editor.removeConnection(conn.id)
    for (const node of [...editor.getNodes()]) await editor.removeNode(node.id)

    const byId = new Map<string, EditorNode>()
    this.storageKey = this.getStorageKey(config)
    this.nodeIdsByRuntimeId.clear()
    const stored = this.loadStoredPositions()
    for (const def of config.nodes) {
      const node = await this.createNode(def, stored?.[def.id] ?? def.position)
      byId.set(def.id, node)
    }
    this.populatePalette(config)

    for (const c of config.connections) {
      const from = byId.get(c.from) as ClassicPreset.Node | undefined
      const to = byId.get(c.to) as ClassicPreset.Node | undefined
      if (!from || !to) continue
      await editor.addConnection(
        new ClassicPreset.Connection(from, c.fromOutput as never, to, c.toInput as never),
      )
    }
    this.building = false

    requestAnimationFrame(() => {
      if (stored) void this.zoomToFit()
      else void this.arrangeGraph()
    })
  }

  // One reusable Socket per port kind (typed ports). Distinct instances let the UI/connection layer
  // tell kinds apart; compatibility itself is enforced by the config's onConnect hook.
  private socketFor(kind?: string): ClassicPreset.Socket {
    const key = kind ?? 'any'
    let socket = this.sockets.get(key)
    if (!socket) {
      socket = new ClassicPreset.Socket(key)
      this.sockets.set(key, socket)
    }
    return socket
  }

  // Map a runtime Rete connection to config-id terms (the ids the owner understands).
  private toConfigConnection(data: {
    source: string
    sourceOutput: string
    target: string
    targetInput: string
  }): EditorConnectionConfig | null {
    const from = this.nodeIdsByRuntimeId.get(data.source)
    const to = this.nodeIdsByRuntimeId.get(data.target)
    if (!from || !to) return null
    return { from, fromOutput: data.sourceOutput, to, toInput: data.targetInput }
  }

  // Enforce one connection per input socket: remove any wire already feeding this input (other than the
  // one being created). Runs under `building` so it doesn't re-fire the disconnect hook.
  private async removeConnectionsIntoInput(
    target: string,
    targetInput: string,
    exceptId: string,
  ): Promise<void> {
    const editor = this.editor
    if (!editor) return
    const existing = editor
      .getConnections()
      .filter((c) => c.target === target && c.targetInput === targetInput && c.id !== exceptId)
    if (existing.length === 0) return
    this.building = true
    for (const c of existing) await editor.removeConnection(c.id)
    this.building = false
  }

  // Build + place a single editor node from its config, registering its id mapping. Used by rebuild
  // and by palette adds. Connections are wired separately (rebuild) — a palette node starts unwired.
  private async createNode(def: EditorNodeConfig, position?: { x: number; y: number }): Promise<EditorNode> {
    const editor = this.editor!
    const area = this.area!
    const node = new EditorNode(def.title)
    node.enabled = def.enabled ?? true
    node.enableable = Boolean(def.onToggle)
    node.onToggle = def.onToggle
    node.onDelete =
      def.deletable && this.config?.onDeleteNode ? () => void this.deleteNode(def.id, node.id) : undefined
    node.mountControls = def.mountControls

    for (const input of def.inputs ?? []) {
      node.addInput(input.key, new ClassicPreset.Input(this.socketFor(input.kind), input.label, false))
    }
    for (const output of def.outputs ?? []) {
      node.addOutput(output.key, new ClassicPreset.Output(this.socketFor(output.kind), output.label, true))
    }
    if (def.mountControls) {
      node.addControl('params', new PaneControl(def.mountControls))
    }

    await editor.addNode(node)
    this.nodeIdsByRuntimeId.set(node.id, def.id)
    if (position) await area.translate(node.id, position)
    return node
  }

  // Add a node of `type` from the palette: the owner creates it (and returns its editor config), then
  // it is placed at the current viewport centre.
  private async addPaletteNode(type: string): Promise<void> {
    if (!this.config?.onAddNode) return
    const position = this.viewportCentre()
    const def = this.config.onAddNode(type, position)
    if (!def) return
    this.building = true
    await this.createNode(def, def.position ?? position)
    this.building = false
    this.saveNodePositions()
  }

  // Remove a node: tell the owner, then drop the node + its connections from the canvas.
  private async deleteNode(configId: string, runtimeId: string): Promise<void> {
    const editor = this.editor
    if (!editor) return
    this.config?.onDeleteNode?.(configId)
    this.building = true
    for (const conn of editor.getConnections().filter((c) => c.source === runtimeId || c.target === runtimeId)) {
      await editor.removeConnection(conn.id)
    }
    await editor.removeNode(runtimeId)
    this.nodeIdsByRuntimeId.delete(runtimeId)
    this.building = false
    this.saveNodePositions()
  }

  // The graph-space coordinate at the centre of the visible canvas (so new nodes land in view).
  private viewportCentre(): { x: number; y: number } {
    const area = this.area
    if (!area) return { x: 0, y: 0 }
    const { x, y, k } = area.area.transform
    const rect = this.canvasHost.getBoundingClientRect()
    return { x: (rect.width / 2 - x) / k, y: (rect.height / 2 - y) / k }
  }

  // (Re)build the palette menu items from the config. Hidden when no palette/onAddNode is supplied.
  private populatePalette(config: EditorGraphConfig): void {
    const canAdd = Boolean(config.onAddNode && config.palette && config.palette.length > 0)
    this.paletteWrap.hidden = !canAdd
    this.paletteMenu.replaceChildren()
    if (!canAdd) return
    for (const item of config.palette!) {
      const btn = document.createElement('button')
      btn.className = 'ne-palette__item'
      btn.textContent = item.label
      if (item.category) btn.dataset.category = item.category
      btn.addEventListener('click', () => {
        this.paletteMenu.hidden = true
        void this.addPaletteNode(item.type)
      })
      this.paletteMenu.appendChild(btn)
    }
  }

  // DEV/test helper: simulate a user-drawn connection by config ids. Goes through the same
  // connectioncreate pipe a drag triggers (validation + single-input + onConnect), so it verifies the
  // edit path without pixel-perfect socket dragging. Returns true if the connection stuck.
  async simulateConnect(fromId: string, fromOutput: string, toId: string, toInput: string): Promise<boolean> {
    const editor = this.editor
    if (!editor) return false
    const runtimeFrom = [...this.nodeIdsByRuntimeId.entries()].find(([, cid]) => cid === fromId)?.[0]
    const runtimeTo = [...this.nodeIdsByRuntimeId.entries()].find(([, cid]) => cid === toId)?.[0]
    if (!runtimeFrom || !runtimeTo) return false
    const from = editor.getNode(runtimeFrom)
    const to = editor.getNode(runtimeTo)
    if (!from || !to) return false
    const before = editor.getConnections().length
    try {
      await editor.addConnection(
        new ClassicPreset.Connection(from, fromOutput as never, to, toInput as never),
      )
    } catch {
      // A vetoed connection throws inside Rete; treat as "did not stick".
    }
    return editor.getConnections().length > before
  }

  private async zoomToFit(): Promise<void> {
    if (!this.area || !this.editor) return
    await AreaExtensions.zoomAt(this.area, this.editor.getNodes(), { scale: FIT_SCALE })
  }

  private async arrangeGraph(): Promise<void> {
    if (!this.arrange || !this.area || !this.editor) return
    await nextFrame()
    this.measureNodeSizes()
    await this.arrange.layout({ options: this.getLayoutOptions() })
    await nextFrame()
    this.saveNodePositions()
    await this.zoomToFit()
    this.clampPan()
  }

  private measureNodeSizes(): void {
    if (!this.area || !this.editor) return
    for (const node of this.editor.getNodes()) {
      const view = this.area.nodeViews.get(node.id)
      const element = (view?.element.querySelector('ne-node') ?? view?.element) as HTMLElement | undefined
      const measuredNode = node as EditorNode
      const width = element?.offsetWidth || measuredNode.width || 288
      const height = element?.offsetHeight || measuredNode.height || 240
      measuredNode.width = width
      measuredNode.height = height
    }
  }

  private getLayoutOptions(): LayoutOptions {
    return {
      'elk.direction': this.getElkDirection(),
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '130',
      'elk.spacing.nodeNode': '70',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    }
  }

  private getElkDirection(): string {
    if (this.layoutArrangement === 'down') return 'DOWN'
    if (this.layoutArrangement === 'right') return 'RIGHT'
    if (this.layoutArrangement === 'up') return 'UP'
    return 'LEFT'
  }

  // Zoom around the viewport centre, clamped to [MIN_ZOOM, MAX_ZOOM]; re-clamp the pan afterwards
  // since the content's on-screen extent changed.
  private async zoomBy(factor: number): Promise<void> {
    await this.zoomByAt(factor, this.canvasHost.clientWidth / 2, this.canvasHost.clientHeight / 2)
  }

  private async zoomByAt(factor: number, originX: number, originY: number): Promise<void> {
    const area = this.area
    if (!area) return
    const k = clamp(area.area.transform.k * factor, MIN_ZOOM, MAX_ZOOM)
    if (k === area.area.transform.k) return
    await area.area.zoom(k, originX, originY)
    this.clampPan()
  }

  private readonly onWheelPan = (event: WheelEvent): void => {
    if (this.shouldHandleWheelZoom(event)) {
      event.preventDefault()
      void this.zoomByWheel(event)
      return
    }

    if (event.shiftKey || !this.shouldHandleWheelPan(event)) {
      return
    }

    event.preventDefault()
    const dx = normalizedWheelDelta(event.deltaX, event.deltaMode)
    const dy = normalizedWheelDelta(event.deltaY, event.deltaMode)
    // Scroll down/right reveals lower/right content, i.e. translate the content the opposite way.
    this.panBy(-dx, -dy)
  }

  private shouldHandleWheelZoom(event: WheelEvent): boolean {
    if (!this.isCanvasWheelEvent(event)) return false
    if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false
    const deltaY = normalizedWheelDelta(event.deltaY, event.deltaMode)
    return Number.isFinite(deltaY) && deltaY !== 0
  }

  private shouldHandleWheelPan(event: WheelEvent): boolean {
    if (!this.isCanvasWheelEvent(event)) return false
    if (event.altKey || event.ctrlKey || event.metaKey) return false
    const dx = normalizedWheelDelta(event.deltaX, event.deltaMode)
    const dy = normalizedWheelDelta(event.deltaY, event.deltaMode)
    return Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0)
  }

  private isCanvasWheelEvent(event: WheelEvent): boolean {
    if (event.type !== 'wheel' || event.defaultPrevented) return false
    if (!this.open_ || !this.area || this.dragStart) return false
    return !isInteractiveWheelTarget(event)
  }

  private async zoomByWheel(event: WheelEvent): Promise<void> {
    const deltaY = normalizedWheelDelta(event.deltaY, event.deltaMode)
    const orbitScale = orbitWheelZoomScale(deltaY)
    const factor = deltaY < 0 ? 1 / orbitScale : orbitScale
    const rect = this.canvasHost.getBoundingClientRect()
    await this.zoomByAt(factor, event.clientX - rect.left, event.clientY - rect.top)
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

  private updateLayoutButtons(): void {
    this.root
      .querySelectorAll<HTMLButtonElement>('.ne-layout [data-arrangement]')
      .forEach((b) => b.classList.toggle('is-active', b.dataset.arrangement === this.layoutArrangement))
  }

  private getStorageKey(config: EditorGraphConfig): string {
    const signature = config.nodes.map((node) => node.id).join('|')
    return `${STORAGE_PREFIX}:${signature}`
  }

  private loadStoredPositions(): StoredPositions | null {
    if (!this.storageKey) return null
    try {
      const raw = sessionStorage.getItem(this.storageKey)
      if (!raw) return null
      const parsed = JSON.parse(raw) as StoredPositions
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  private saveNodePositions(): void {
    if (!this.storageKey || !this.area) return
    const positions: StoredPositions = {}
    for (const [runtimeId, graphId] of this.nodeIdsByRuntimeId) {
      const view = this.area.nodeViews.get(runtimeId)
      if (!view) continue
      positions[graphId] = { x: view.position.x, y: view.position.y }
    }
    try {
      sessionStorage.setItem(this.storageKey, JSON.stringify(positions))
    } catch {
      // Storage can fail in private browsing or quota-constrained contexts; the editor still works.
    }
  }
}

const DOCK_ICON: Record<DockMode, IconNode> = {
  left: PanelLeft,
  top: PanelTop,
  bottom: PanelBottom,
}

const LAYOUT_ICON: Record<LayoutArrangement, IconNode> = {
  down: ArrowDown,
  right: ArrowRight,
  up: ArrowUp,
  left: ArrowLeft,
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

function normalizedWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * WHEEL_LINE_DELTA_PX
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * WHEEL_PAGE_DELTA_PX
  return delta
}

function orbitWheelZoomScale(deltaY: number): number {
  return Math.pow(WHEEL_ZOOM_BASE, WHEEL_ZOOM_SPEED * Math.abs(deltaY * 0.01))
}

function isInteractiveWheelTarget(event: WheelEvent): boolean {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue
    if (target.matches('input, select, textarea, button, [contenteditable="true"]')) return true
    if (target.classList.contains('tp-dfwv') || target.classList.contains('tp-rotv')) return true
  }
  return false
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

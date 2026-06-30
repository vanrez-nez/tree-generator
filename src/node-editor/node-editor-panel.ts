// A dockable panel hosting a Rete v2 node editor. The graph is supplied as a plain `EditorGraphConfig`
// (decoupled — see types.ts) and is treated as read-only topology: nodes/connections are placed
// programmatically and user-initiated create/remove is vetoed, so the underlying fixed pipeline can't
// be broken from the UI. Docking is done by padding `#app` on the docked edge so the 3D canvas
// shrinks into the remaining area and the existing resize handler picks it up.
import { NodeEditor, ClassicPreset, type GetSchemes } from 'rete'
import { AreaPlugin, AreaExtensions } from 'rete-area-plugin'
import { ConnectionPlugin, Presets as ConnectionPresets } from 'rete-connection-plugin'
import { LitPlugin, Presets as LitPresets, type LitArea2D } from '@retejs/lit-plugin'
import { getDOMSocketPosition } from 'rete-render-utils'
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
  Download,
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

// Zoom is via the header buttons or the mouse wheel (toward the cursor). Clamped to this range; each
// header step multiplies/divides by ZOOM_STEP.
const MIN_ZOOM = 0.1
const MAX_ZOOM = 2.5
const ZOOM_STEP = 1.2
const WHEEL_LINE_DELTA_PX = 16
const WHEEL_PAGE_DELTA_PX = 100
const WHEEL_ZOOM_BASE = 0.95
const WHEEL_ZOOM_SPEED = 1
// Dot-grid tile size in px at zoom 1 (matches the .ne-canvas CSS background-size). syncBackground scales
// and pans this with the area transform so the grid tracks the nodes.
const GRID_SIZE = 22
// Empty breathing room kept around the node graph (in rem), so connectors never sit flush against
// the panel edges. Baked into the content bounds used for panning + centring, and into the fit gap.
const CONTENT_PADDING_REM = 5
// Minimum px of the (padded) content bounds kept on screen when panning/zooming. A loose guard so the
// graph can't be scrolled fully into the void — but it never force-centres, so zoom-to-cursor is preserved.
const CONTENT_KEEP_PX = 96
const NODE_FALLBACK_SIZE = 288 // node element size fallback when offsetWidth/Height isn't measured yet
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
  // Group navigation trail (root → current group); hidden at the root.
  private readonly breadcrumb: HTMLDivElement
  // Export-graph button; shown only when the active config provides an onExport hook.
  private readonly exportBtn: HTMLButtonElement

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

    // Breadcrumb trail (left-aligned, doubles as the editor title). Its root "Material" crumb replaces the
    // former static title; deeper crumbs appear as the user navigates into groups.
    this.breadcrumb = document.createElement('div')
    this.breadcrumb.className = 'ne-breadcrumb'
    header.appendChild(this.breadcrumb)
    // Esc exits one group level.
    document.addEventListener('keydown', (e) => {
      if (!this.open_ || e.key !== 'Escape' || !this.config?.onExit) return
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return
      e.preventDefault()
      this.config.onExit()
    })

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

    // Export button: download the current graph as JSON (delegated to the config's onExport hook).
    // Hidden until a config that supplies onExport is loaded (toggled in `rebuild`).
    this.exportBtn = document.createElement('button')
    this.exportBtn.className = 'ne-dock__btn ne-export__btn'
    this.exportBtn.title = 'Export JSON'
    this.exportBtn.setAttribute('aria-label', 'Export JSON')
    this.exportBtn.hidden = true
    appendLucideIcon(this.exportBtn, Download)
    this.exportBtn.addEventListener('click', () => this.config?.onExport?.())
    header.appendChild(this.exportBtn)

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
    tip.textContent = 'Scroll to zoom · Shift + scroll to pan · Double-click a title to focus'
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

  open(config: EditorGraphConfig, mode?: DockMode): void {
    this.root.hidden = false
    this.open_ = true
    this.appElement.classList.add('editor-open')
    // Keep the current dock when re-opening (e.g. group navigation re-renders); default to bottom.
    this.applyDock(mode ?? this.mode)
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
    this.canvasHost.removeEventListener('wheel', this.onWheelPan, { capture: true } as EventListenerOptions)
    window.removeEventListener('pointerdown', this.onTitlePointerDown, {
      capture: true,
    } as EventListenerOptions)
    window.removeEventListener('mousedown', this.onTitleDblClick, { capture: true } as EventListenerOptions)
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
        // Rete's default DOMSocketPosition pushes the wire anchor ±12px outward from the socket
        // centre (it assumes the library's 24px sockets). Our dots are 12px and centred on the node
        // border, so that offset leaves a visible gap between the dot and the wire. getElementCenter
        // already returns the socket host's centre (= our dot), so anchor there directly (identity).
        socketPositionWatcher: getDOMSocketPosition({
          offset: (position) => ({ x: position.x, y: position.y }),
        }),
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

    // Plain wheel zooms toward the cursor; Shift + wheel pans. We handle both, so disable Rete's built-in
    // wheel zoom. Capture phase so the canvas claims the wheel before any node input / Tweakpane control
    // (which would otherwise consume it), making zoom/pan work everywhere over the graph.
    area.area.setZoomHandler(null)
    this.canvasHost.addEventListener('wheel', this.onWheelPan, { passive: false, capture: true })
    // Double-click on a node title → focus it. Rete's drag handle suppresses the browser's click/dblclick
    // on titles (they never fire — verified), so there's no `dblclick` to listen to. We use the events that
    // DO fire: `pointerdown` carries the real title target; the paired `mousedown` carries the browser's
    // native consecutive-click count in `event.detail` (governed by the OS double-click speed). detail===2
    // on a title = an OS double-click. Window + capture so nothing upstream can stop it.
    window.addEventListener('pointerdown', this.onTitlePointerDown, { capture: true })
    window.addEventListener('mousedown', this.onTitleDblClick, { capture: true })

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
      // Keep the dot-grid aligned with the content so the background pans + scales with the nodes.
      if (context.type === 'translated' || context.type === 'zoomed') this.syncBackground()
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
    this.syncBackground() // align the grid to the initial transform
  }

  private async rebuild(config: EditorGraphConfig): Promise<void> {
    this.ensureEditor()
    const editor = this.editor!

    // A same-graph rebuild (e.g. a declare-driven param change adding/removing sockets) keeps the same
    // node ids → same storage key. In that case preserve the user's pan/zoom instead of refitting; only a
    // genuinely different graph (preset load, group navigation) should refit. Captured before storageKey
    // is reassigned below.
    const prevKey = this.storageKey
    const prevTransform = this.area ? { ...this.area.area.transform } : null

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
    this.populateBreadcrumb(config)
    this.exportBtn.hidden = !config.onExport

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
      if (prevTransform && prevKey === this.storageKey) void this.restoreTransform(prevTransform)
      else if (stored) void this.zoomToFit()
      else void this.arrangeGraph()
    })
  }

  // Reapply an exact area transform (zoom around the origin to set k, then translate to set x/y). Used to
  // keep the viewport steady across a same-graph rebuild. The emitted zoomed/translated events resync the
  // grid; the clamp pipe leaves an already-valid transform untouched.
  private async restoreTransform(t: { k: number; x: number; y: number }): Promise<void> {
    const area = this.area
    if (!area) return
    await area.area.zoom(t.k, 0, 0)
    await area.area.translate(t.x, t.y)
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
    node.nodeClass = def.nodeClass
    node.soloed = def.soloed ?? false
    node.onSolo = def.onSolo
    node.onDelete =
      def.deletable && this.config?.onDeleteNode ? () => void this.deleteNode(def.id, node.id) : undefined
    node.onEnter = def.onEnter
    node.onRename = def.onRename
    node.defaultTitle = def.defaultTitle
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

  // (Re)build the group-navigation breadcrumb. Always shows at least the root "Material" crumb (it doubles
  // as the editor title); deeper crumbs are appended as the user enters groups.
  private populateBreadcrumb(config: EditorGraphConfig): void {
    const trail = config.breadcrumb ?? []
    this.breadcrumb.replaceChildren()
    this.breadcrumb.hidden = trail.length === 0
    trail.forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement('span')
        sep.className = 'ne-breadcrumb__sep'
        sep.textContent = '›'
        this.breadcrumb.appendChild(sep)
      }
      const btn = document.createElement('button')
      btn.className = 'ne-breadcrumb__crumb'
      btn.textContent = crumb.label
      if (i === trail.length - 1) btn.classList.add('current')
      btn.addEventListener('click', () => crumb.onClick())
      this.breadcrumb.appendChild(btn)
    })
  }

  // (Re)build the palette menu items from the config, grouped by category (the node class) into labelled
  // sections — mirroring Blender's Add menu. Hidden when no palette/onAddNode is supplied.
  private populatePalette(config: EditorGraphConfig): void {
    const canAdd = Boolean(config.onAddNode && config.palette && config.palette.length > 0)
    this.paletteWrap.hidden = !canAdd
    this.paletteMenu.replaceChildren()
    if (!canAdd) return

    // Group preserving the order categories first appear; uncategorised items fall under "Other".
    const groups = new Map<string, EditorGraphConfig['palette'] & object>()
    for (const item of config.palette!) {
      const key = item.category ?? 'other'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(item)
    }

    for (const [category, items] of groups) {
      const heading = document.createElement('div')
      heading.className = 'ne-palette__group'
      heading.dataset.category = category
      heading.textContent = category
      this.paletteMenu.appendChild(heading)
      for (const item of items) {
        const btn = document.createElement('button')
        btn.className = 'ne-palette__item'
        btn.textContent = item.label
        btn.dataset.category = category
        btn.addEventListener('click', () => {
          this.paletteMenu.hidden = true
          void this.addPaletteNode(item.type)
        })
        this.paletteMenu.appendChild(btn)
      }
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

  // Zoom toward the screen point (originX, originY): keep the world point under it fixed. Rete's
  // area.zoom(k, ox, oy) does NOT pivot around (ox, oy) (it just offsets the pan), so we set the zoom and
  // compute the cursor-anchored pan ourselves.
  private async zoomByAt(factor: number, originX: number, originY: number): Promise<void> {
    const area = this.area
    if (!area) return
    const t = area.area.transform
    const k = clamp(t.k * factor, MIN_ZOOM, MAX_ZOOM)
    if (k === t.k) return
    const ratio = k / t.k
    const x = originX - (originX - t.x) * ratio
    const y = originY - (originY - t.y) * ratio
    await area.area.zoom(k, 0, 0) // ox=oy=0 → sets the zoom without shifting the pan
    const c = this.clampedXY(x, y)
    await area.area.translate(c.x, c.y)
  }

  // Double-click on a node's title bar: snap to 100% zoom and centre the node (a fixed zoom, not relative
  // to the node's size — large nodes shouldn't stay zoomed out nor small ones blow up).
  private async zoomToNode(runtimeId: string): Promise<void> {
    const area = this.area
    if (!area) return
    const view = area.nodeViews.get(runtimeId)
    if (!view) return
    const w = view.element.offsetWidth || NODE_FALLBACK_SIZE
    const h = view.element.offsetHeight || NODE_FALLBACK_SIZE
    const cx = view.position.x + w / 2
    const cy = view.position.y + h / 2
    const k = 1 // 100% zoom
    await area.area.zoom(k, 0, 0) // set the zoom (origin 0,0), then place the pan to centre the node
    await area.area.translate(this.canvasHost.clientWidth / 2 - cx * k, this.canvasHost.clientHeight / 2 - cy * k)
    this.clampPan()
    this.syncBackground()
  }

  // Plain wheel zooms toward the cursor (Figma/Blender-style); Shift + wheel pans for those who prefer
  // scroll-to-pan. Capture phase, so it works over node inputs / Tweakpane controls too.
  private readonly onWheelPan = (event: WheelEvent): void => {
    if (!this.isCanvasWheelEvent(event)) return

    if (event.shiftKey) {
      const dx = normalizedWheelDelta(event.deltaX, event.deltaMode)
      const dy = normalizedWheelDelta(event.deltaY, event.deltaMode)
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return
      event.preventDefault()
      event.stopPropagation()
      // Scroll down/right reveals lower/right content, i.e. translate the content the opposite way.
      this.panBy(-dx, -dy)
      return
    }

    const deltaY = normalizedWheelDelta(event.deltaY, event.deltaMode)
    if (event.altKey || event.metaKey || !Number.isFinite(deltaY) || deltaY === 0) return
    event.preventDefault()
    event.stopPropagation()
    void this.zoomByWheel(event)
  }

  // The node whose title the most recent pointerdown landed on (null if not a title). Recorded on
  // pointerdown because its target is reliable, unlike the paired mousedown's (retargeted by Rete's drag).
  private dblTitleNode: string | null = null
  private readonly onTitlePointerDown = (event: PointerEvent): void => {
    this.dblTitleNode = null
    const area = this.area
    if (!area || !this.open_) return
    const title = (event.target as HTMLElement | null)?.closest('.title')
    if (!title) return
    for (const [runtimeId, view] of area.nodeViews) {
      if (view.element.contains(title)) {
        this.dblTitleNode = runtimeId
        return
      }
    }
  }

  // Second press of an OS double-click (mousedown.detail === 2) on a title: groups enter their subgraph,
  // every other node zooms + centres. `detail` is the browser's native, OS-speed-governed click counter.
  private readonly onTitleDblClick = (event: MouseEvent): void => {
    if (event.detail !== 2) return
    const id = this.dblTitleNode
    const editor = this.editor
    if (!id || !editor) return
    const node = editor.getNode(id) as EditorNode | undefined
    if (node?.onEnter) node.onEnter()
    else void this.zoomToNode(id)
  }

  private isCanvasWheelEvent(event: WheelEvent): boolean {
    if (event.type !== 'wheel' || event.defaultPrevented) return false
    if (!this.open_ || !this.area || this.dragStart) return false
    // The canvas owns the wheel anywhere over the graph — including node inputs and title bars — so zoom/
    // pan isn't swallowed by a control. (Wheel-to-tweak on a number field is traded away for this.)
    return true
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

  // Align the CSS dot-grid to the area transform: pan it by the translation and scale the tile by the
  // zoom, so the background moves together with the nodes (Figma/Blender-style).
  private syncBackground(): void {
    const area = this.area
    if (!area) return
    const { x, y, k } = area.area.transform
    const size = GRID_SIZE * k
    const s = this.canvasHost.style
    s.backgroundSize = `${size}px ${size}px`
    s.backgroundPosition = `${x}px ${y}px`
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

  // Clamp a desired pan offset so the content can't be scrolled fully into empty space, while keeping the
  // view free to sit off-centre (so zoom-to-cursor isn't undone). At least CONTENT_KEEP_PX of the padded
  // content stays on screen on each axis; within that, any position is allowed.
  private clampedXY(x: number, y: number): { x: number; y: number } {
    const area = this.area
    const bounds = this.contentBounds()
    if (!area || !bounds) return { x, y }
    const k = area.area.transform.k
    const axis = (value: number, lo: number, hi: number, viewport: number): number => {
      // `lo`/`hi` already include CONTENT_PADDING_REM. Keep `keep` px of content overlapping the viewport
      // (capped at the content's own on-screen size so small graphs aren't over-constrained).
      const keep = Math.min(CONTENT_KEEP_PX, (hi - lo) * k)
      const min = keep - hi * k // content pushed left until only `keep` px remain at the right edge
      const max = viewport - keep - lo * k // pushed right until only `keep` px remain at the left edge
      return clamp(value, Math.min(min, max), Math.max(min, max))
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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

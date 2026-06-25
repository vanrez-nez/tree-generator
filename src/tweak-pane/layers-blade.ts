/* eslint-disable */
// Vendored Tweakpane blade plugin: a sortable "Layers" list with per-row eye toggle,
// a footer "Add Layer" type-picker menu, and a centered "Remove" confirmation dialog.
// Reordering is powered by @atlaskit/pragmatic-drag-and-drop. All chrome is styled with
// Tweakpane CSS variables so it matches the surrounding pane.
import {
  BladeApi,
  BladeController,
  type BladePlugin,
  ClassName,
  createPlugin,
  Emitter,
  parseRecord,
  type TpPluginBundle,
  type View,
} from '@tweakpane/core'
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter'
import { combine } from '@atlaskit/pragmatic-drag-and-drop/combine'
import {
  attachClosestEdge,
  extractClosestEdge,
  type Edge,
} from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge'
import { EYE_CLOSED_SVG, EYE_OPEN_SVG } from './eye-icons'

export type LayerItem = {
  id: string
  name: string
  visible: boolean
}

type LayersBladeParams = {
  addLabel?: string
  types?: string[]
  view: 'layers'
}

export type LayersEvents = {
  add: { type: string }
  remove: { id: string }
  reorder: { ids: string[] }
  select: { id: string }
  visibility: { id: string; visible: boolean }
}

const LAYERS_PLUGIN_ID = 'layers-list'
const LAYERS_VIEW = 'layers'
const DRAG_DATA_TYPE = 'layers-row'

const cn = ClassName('layers')

const GRIP_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><circle cx="6" cy="4" r="1.3"/><circle cx="10" cy="4" r="1.3"/><circle cx="6" cy="8" r="1.3"/><circle cx="10" cy="8" r="1.3"/><circle cx="6" cy="12" r="1.3"/><circle cx="10" cy="12" r="1.3"/></svg>'

class LayersPaneView implements View {
  readonly element: HTMLElement
  readonly emitter = new Emitter<LayersEvents>()
  private readonly doc: Document
  private readonly listElement: HTMLDivElement
  private readonly addButton: HTMLButtonElement
  private readonly removeButton: HTMLButtonElement
  private readonly menuElement: HTMLDivElement
  private readonly confirmElement: HTMLDivElement
  private readonly confirmMessage: HTMLDivElement
  private items: LayerItem[] = []
  private selectedId: string | null = null
  private types: string[]
  private rowCleanup: (() => void) | null = null
  private menuOpen = false
  private confirmOpen = false

  constructor(doc: Document, params: { addLabel?: string; types?: string[] }) {
    this.doc = doc
    this.types = params.types ?? []

    this.element = doc.createElement('div')
    this.element.classList.add(cn())

    this.listElement = doc.createElement('div')
    this.listElement.classList.add(cn('list'))
    this.element.appendChild(this.listElement)

    const footer = doc.createElement('div')
    footer.classList.add(cn('footer'))
    this.addButton = doc.createElement('button')
    this.addButton.type = 'button'
    this.addButton.classList.add(cn('btn'))
    this.addButton.textContent = params.addLabel ?? 'Add Layer'
    this.removeButton = doc.createElement('button')
    this.removeButton.type = 'button'
    this.removeButton.classList.add(cn('btn'))
    this.removeButton.textContent = 'Remove'
    footer.appendChild(this.addButton)
    footer.appendChild(this.removeButton)
    this.element.appendChild(footer)

    // Add-type popover menu (anchored to the footer).
    this.menuElement = doc.createElement('div')
    this.menuElement.classList.add(cn('menu'))
    this.menuElement.hidden = true
    this.element.appendChild(this.menuElement)

    // Centered confirmation overlay.
    this.confirmElement = doc.createElement('div')
    this.confirmElement.classList.add(cn('confirm'))
    this.confirmElement.hidden = true
    const panel = doc.createElement('div')
    panel.classList.add(cn('confirmPanel'))
    this.confirmMessage = doc.createElement('div')
    this.confirmMessage.classList.add(cn('confirmMsg'))
    const confirmActions = doc.createElement('div')
    confirmActions.classList.add(cn('confirmActions'))
    const cancelButton = doc.createElement('button')
    cancelButton.type = 'button'
    cancelButton.classList.add(cn('btn'))
    cancelButton.textContent = 'Cancel'
    const okButton = doc.createElement('button')
    okButton.type = 'button'
    okButton.classList.add(cn('btn'), cn('btn', 'danger'))
    okButton.textContent = 'Remove'
    confirmActions.appendChild(cancelButton)
    confirmActions.appendChild(okButton)
    panel.appendChild(this.confirmMessage)
    panel.appendChild(confirmActions)
    this.confirmElement.appendChild(panel)
    this.element.appendChild(this.confirmElement)

    this.addButton.addEventListener('click', this.handleAddClick)
    this.removeButton.addEventListener('click', this.handleRemoveClick)
    cancelButton.addEventListener('click', this.closeConfirm)
    okButton.addEventListener('click', this.handleConfirmRemove)
    this.confirmElement.addEventListener('click', this.handleConfirmBackdrop)

    // A single monitor handles all drops; it reads live state via closures.
    this.rowCleanup = null
    this.monitorCleanup = monitorForElements({
      canMonitor: ({ source }) => source.data.dndType === DRAG_DATA_TYPE,
      onDrop: this.handleDrop,
    })

    this.renderMenu()
    this.renderRows()
  }

  private readonly monitorCleanup: () => void

  setItems(items: LayerItem[]): void {
    this.items = items.map((item) => ({ ...item }))
    if (this.selectedId && !this.items.some((item) => item.id === this.selectedId)) {
      this.selectedId = null
    }
    this.renderRows()
  }

  getItems(): LayerItem[] {
    return this.items.map((item) => ({ ...item }))
  }

  addItem(item: LayerItem): void {
    this.items.push({ ...item })
    this.renderRows()
  }

  removeItem(id: string): void {
    this.items = this.items.filter((item) => item.id !== id)
    if (this.selectedId === id) {
      this.selectedId = null
    }
    this.renderRows()
  }

  setName(id: string, name: string): void {
    const item = this.items.find((entry) => entry.id === id)
    if (item && item.name !== name) {
      item.name = name
      this.renderRows()
    }
  }

  setVisible(id: string, visible: boolean): void {
    const item = this.items.find((entry) => entry.id === id)
    if (item && item.visible !== visible) {
      item.visible = visible
      this.renderRows()
    }
  }

  select(id: string | null): void {
    this.selectedId = id
    this.renderRows()
  }

  getSelected(): string | null {
    return this.selectedId
  }

  setTypes(types: string[]): void {
    this.types = [...types]
    this.renderMenu()
  }

  setAddLabel(label: string): void {
    this.addButton.textContent = label
  }

  dispose(): void {
    this.rowCleanup?.()
    this.rowCleanup = null
    this.monitorCleanup()
    this.removeDocumentListeners()
  }

  private renderRows(): void {
    this.rowCleanup?.()
    this.rowCleanup = null
    this.listElement.replaceChildren()

    if (this.items.length === 0) {
      const empty = this.doc.createElement('div')
      empty.classList.add(cn('empty'))
      empty.textContent = 'No layers'
      this.listElement.appendChild(empty)
      return
    }

    const cleanups: Array<() => void> = []

    for (const item of this.items) {
      const row = this.doc.createElement('div')
      row.classList.add(cn('row'))
      row.dataset.id = item.id
      if (item.id === this.selectedId) {
        row.classList.add(cn('row', 'selected'))
      }

      const handle = this.doc.createElement('span')
      handle.classList.add(cn('handle'))
      handle.innerHTML = GRIP_SVG

      const name = this.doc.createElement('span')
      name.classList.add(cn('name'))
      name.textContent = item.name

      const eye = this.doc.createElement('button')
      eye.type = 'button'
      eye.classList.add(cn('eye'))
      if (!item.visible) {
        eye.classList.add(cn('eye', 'off'))
      }
      eye.innerHTML = item.visible ? EYE_OPEN_SVG : EYE_CLOSED_SVG
      eye.title = item.visible ? 'Hide layer' : 'Show layer'
      eye.addEventListener('click', (event) => {
        event.stopPropagation()
        this.emitter.emit('visibility', { id: item.id, visible: !item.visible })
      })

      row.appendChild(handle)
      row.appendChild(name)
      row.appendChild(eye)
      row.addEventListener('click', () => {
        this.select(item.id)
        this.emitter.emit('select', { id: item.id })
      })

      cleanups.push(
        combine(
          draggable({
            element: row,
            dragHandle: handle,
            getInitialData: () => ({ dndType: DRAG_DATA_TYPE, id: item.id }),
            onDragStart: () => row.classList.add(cn('row', 'dragging')),
            onDrop: () => row.classList.remove(cn('row', 'dragging')),
          }),
          dropTargetForElements({
            element: row,
            canDrop: ({ source }) => source.data.dndType === DRAG_DATA_TYPE,
            getData: ({ input, element }) =>
              attachClosestEdge(
                { id: item.id },
                { input, element, allowedEdges: ['top', 'bottom'] },
              ),
            onDrag: ({ self, source }) => {
              if (source.data.id === item.id) {
                this.clearRowEdge(row)
                return
              }
              this.setRowEdge(row, extractClosestEdge(self.data))
            },
            onDragLeave: () => this.clearRowEdge(row),
            onDrop: () => this.clearRowEdge(row),
          }),
        ),
      )

      this.listElement.appendChild(row)
    }

    this.rowCleanup = () => {
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
  }

  private setRowEdge(row: HTMLElement, edge: Edge | null): void {
    row.classList.remove(cn('row', 'over-top'), cn('row', 'over-bottom'))
    if (edge === 'top') {
      row.classList.add(cn('row', 'over-top'))
    } else if (edge === 'bottom') {
      row.classList.add(cn('row', 'over-bottom'))
    }
  }

  private clearRowEdge(row: HTMLElement): void {
    row.classList.remove(cn('row', 'over-top'), cn('row', 'over-bottom'))
  }

  private readonly handleDrop = (args: Parameters<
    NonNullable<Parameters<typeof monitorForElements>[0]['onDrop']>
  >[0]): void => {
    const target = args.location.current.dropTargets[0]
    if (!target) {
      return
    }

    const sourceId = args.source.data.id as string
    const targetId = target.data.id as string
    if (sourceId === targetId) {
      return
    }

    const edge = extractClosestEdge(target.data)
    const fromIndex = this.items.findIndex((item) => item.id === sourceId)
    let targetIndex = this.items.findIndex((item) => item.id === targetId)
    if (fromIndex === -1 || targetIndex === -1) {
      return
    }

    const [moved] = this.items.splice(fromIndex, 1)
    if (!moved) {
      return
    }
    // Recompute the target index after removal, then honor the closest edge.
    targetIndex = this.items.findIndex((item) => item.id === targetId)
    const insertIndex = edge === 'bottom' ? targetIndex + 1 : targetIndex
    this.items.splice(insertIndex, 0, moved)

    this.renderRows()
    this.emitter.emit('reorder', { ids: this.items.map((item) => item.id) })
  }

  private renderMenu(): void {
    this.menuElement.replaceChildren()
    for (const type of this.types) {
      const option = this.doc.createElement('button')
      option.type = 'button'
      option.classList.add(cn('menuItem'))
      option.textContent = type
      option.addEventListener('click', () => {
        this.closeMenu()
        this.emitter.emit('add', { type })
      })
      this.menuElement.appendChild(option)
    }
  }

  private readonly handleAddClick = (): void => {
    if (this.types.length === 0) {
      return
    }
    if (this.menuOpen) {
      this.closeMenu()
    } else {
      this.openMenu()
    }
  }

  private openMenu(): void {
    this.menuOpen = true
    this.menuElement.hidden = false
    this.addDocumentListeners()
  }

  private readonly closeMenu = (): void => {
    if (!this.menuOpen) {
      return
    }
    this.menuOpen = false
    this.menuElement.hidden = true
    this.removeDocumentListeners()
  }

  private readonly handleRemoveClick = (): void => {
    if (!this.selectedId) {
      return
    }
    const item = this.items.find((entry) => entry.id === this.selectedId)
    this.confirmMessage.textContent = `Remove "${item?.name ?? 'layer'}"?`
    this.confirmOpen = true
    this.confirmElement.hidden = false
    this.addDocumentListeners()
  }

  private readonly closeConfirm = (): void => {
    if (!this.confirmOpen) {
      return
    }
    this.confirmOpen = false
    this.confirmElement.hidden = true
    this.removeDocumentListeners()
  }

  private readonly handleConfirmRemove = (): void => {
    const id = this.selectedId
    this.closeConfirm()
    if (id) {
      this.emitter.emit('remove', { id })
    }
  }

  private readonly handleConfirmBackdrop = (event: MouseEvent): void => {
    if (event.target === this.confirmElement) {
      this.closeConfirm()
    }
  }

  private addDocumentListeners(): void {
    this.doc.addEventListener('pointerdown', this.handleOutsidePointer, true)
    this.doc.addEventListener('keydown', this.handleKeydown)
  }

  private removeDocumentListeners(): void {
    this.doc.removeEventListener('pointerdown', this.handleOutsidePointer, true)
    this.doc.removeEventListener('keydown', this.handleKeydown)
  }

  private readonly handleOutsidePointer = (event: PointerEvent): void => {
    const node = event.target as Node
    if (this.menuOpen && !this.menuElement.contains(node) && node !== this.addButton) {
      this.closeMenu()
    }
  }

  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeMenu()
      this.closeConfirm()
    }
  }
}

class LayersPaneController extends BladeController<LayersPaneView> {
  constructor(args: {
    blade: ConstructorParameters<typeof BladeController>[0]['blade']
    document: Document
    addLabel?: string
    types?: string[]
    viewProps: ConstructorParameters<typeof BladeController>[0]['viewProps']
  }) {
    const view = new LayersPaneView(args.document, {
      addLabel: args.addLabel,
      types: args.types,
    })

    super({
      blade: args.blade,
      view,
      viewProps: args.viewProps,
    })

    args.viewProps.handleDispose(() => {
      view.dispose()
    })
  }
}

export class LayersBladeApi extends BladeApi<LayersPaneController> {
  addItem(item: LayerItem): void {
    this.controller.view.addItem(item)
  }

  removeItem(id: string): void {
    this.controller.view.removeItem(id)
  }

  setItems(items: LayerItem[]): void {
    this.controller.view.setItems(items)
  }

  getItems(): LayerItem[] {
    return this.controller.view.getItems()
  }

  setName(id: string, name: string): void {
    this.controller.view.setName(id, name)
  }

  setVisible(id: string, visible: boolean): void {
    this.controller.view.setVisible(id, visible)
  }

  select(id: string | null): void {
    this.controller.view.select(id)
  }

  getSelected(): string | null {
    return this.controller.view.getSelected()
  }

  setTypes(types: string[]): void {
    this.controller.view.setTypes(types)
  }

  setAddLabel(label: string): void {
    this.controller.view.setAddLabel(label)
  }

  on<EventName extends keyof LayersEvents>(
    eventName: EventName,
    handler: (event: LayersEvents[EventName]) => void,
  ): this {
    this.controller.view.emitter.on(eventName, handler)
    return this
  }
}

const LayersBladePlugin: BladePlugin<LayersBladeParams> = createPlugin({
  id: LAYERS_VIEW,
  type: 'blade',
  accept(params) {
    const result = parseRecord<LayersBladeParams>(params, (parser) => ({
      addLabel: parser.optional.string,
      types: parser.optional.array(parser.required.string),
      view: parser.required.constant(LAYERS_VIEW),
    }))

    return result ? { params: result } : null
  },
  controller(args) {
    return new LayersPaneController({
      blade: args.blade,
      document: args.document,
      addLabel: args.params.addLabel,
      types: args.params.types,
      viewProps: args.viewProps,
    })
  },
  api(args) {
    if (args.controller instanceof LayersPaneController) {
      return new LayersBladeApi(args.controller)
    }

    return null
  },
})

export const LayersPluginBundle: TpPluginBundle = {
  id: LAYERS_PLUGIN_ID,
  plugin: LayersBladePlugin,
  css: `
    .${cn()} {
      box-sizing: border-box;
      display: block;
      padding: var(--cnt-vp) var(--cnt-hp);
      position: relative;
      width: 100%;
    }

    .${cn('list')} {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .${cn('empty')} {
      color: var(--lbl-fg);
      font-size: 11px;
      opacity: 0.6;
      padding: 4px var(--bld-hp);
    }

    .${cn('row')} {
      align-items: center;
      background-color: var(--in-bg);
      border-radius: var(--bld-br);
      box-sizing: border-box;
      color: var(--in-fg);
      cursor: pointer;
      display: flex;
      gap: 4px;
      height: var(--cnt-usz);
      padding: 0 var(--bld-hp);
      position: relative;
      user-select: none;
    }

    .${cn('row')}:hover {
      background-color: var(--in-bg-h);
    }

    .${cn('row', 'selected')} {
      background-color: var(--in-bg-a);
      box-shadow: 0 0 0 1px var(--in-fg) inset;
    }

    .${cn('row', 'dragging')} {
      opacity: 0.4;
    }

    .${cn('row', 'over-top')}::before,
    .${cn('row', 'over-bottom')}::after {
      background-color: var(--in-fg);
      content: '';
      height: 2px;
      left: 0;
      position: absolute;
      right: 0;
    }

    .${cn('row', 'over-top')}::before {
      top: -1px;
    }

    .${cn('row', 'over-bottom')}::after {
      bottom: -1px;
    }

    .${cn('handle')} {
      align-items: center;
      color: var(--in-fg);
      cursor: grab;
      display: flex;
      flex: none;
      fill: currentColor;
      opacity: 0.6;
    }

    .${cn('handle')}:active {
      cursor: grabbing;
    }

    .${cn('name')} {
      flex: 1;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .${cn('eye')} {
      align-items: center;
      background: none;
      border: none;
      color: var(--in-fg);
      cursor: pointer;
      display: flex;
      fill: currentColor;
      flex: none;
      padding: 2px;
    }

    .${cn('eye', 'off')} {
      opacity: 0.35;
    }

    .${cn('footer')} {
      display: flex;
      gap: 4px;
      margin-top: var(--cnt-usp);
    }

    .${cn('btn')} {
      background-color: var(--btn-bg);
      border: none;
      border-radius: var(--bld-br);
      color: var(--btn-fg);
      cursor: pointer;
      flex: 1;
      font-family: inherit;
      font-size: 11px;
      height: var(--cnt-usz);
      padding: 0 var(--bld-hp);
    }

    .${cn('btn')}:hover {
      background-color: var(--btn-bg-h);
    }

    .${cn('btn')}:active {
      background-color: var(--btn-bg-a);
    }

    .${cn('btn', 'danger')} {
      color: #e8564f;
    }

    .${cn('menu')}:not([hidden]) {
      background-color: var(--bs-bg);
      border-radius: var(--bs-br);
      bottom: calc(var(--cnt-usz) + var(--cnt-vp) + 2px);
      box-shadow: 0 2px 8px var(--bs-sh);
      display: flex;
      flex-direction: column;
      left: var(--cnt-hp);
      overflow: hidden;
      padding: 4px;
      position: absolute;
      z-index: 10;
    }

    .${cn('menuItem')} {
      background: none;
      border: none;
      border-radius: var(--bld-br);
      color: var(--cnt-fg);
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
      padding: 4px 12px;
      text-align: left;
      white-space: nowrap;
    }

    .${cn('menuItem')}:hover {
      background-color: var(--in-bg-h);
    }

    .${cn('confirm')}:not([hidden]) {
      align-items: center;
      background-color: rgba(0, 0, 0, 0.45);
      border-radius: var(--bld-br);
      bottom: 0;
      display: flex;
      justify-content: center;
      left: 0;
      position: absolute;
      right: 0;
      top: 0;
      z-index: 20;
    }

    .${cn('confirmPanel')} {
      background-color: var(--bs-bg);
      border-radius: var(--bs-br);
      box-shadow: 0 2px 8px var(--bs-sh);
      box-sizing: border-box;
      max-width: calc(100% - 24px);
      padding: 10px;
    }

    .${cn('confirmMsg')} {
      color: var(--cnt-fg);
      font-size: 11px;
      margin-bottom: 8px;
      text-align: center;
    }

    .${cn('confirmActions')} {
      display: flex;
      gap: 4px;
    }
  `,
}

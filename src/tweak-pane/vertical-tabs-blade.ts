/* eslint-disable */
// Tweakpane blade plugin: vertical icon tabs with container pages. It mirrors the
// public shape of Tweakpane's tab API, but renders an icon rail suited to compact
// bottom-of-panel tools.
import {
  BladeApi,
  type BladePlugin,
  ClassName,
  ContainerBladeApi,
  ContainerBladeController,
  createBlade,
  createPlugin,
  Emitter,
  parseRecord,
  RackController,
  type Blade,
  TabPageApi,
  TabPageController,
  type TabPagePropsObject,
  type TpPluginBundle,
  ValueMap,
  ViewProps,
  type View,
} from '@tweakpane/core'
import {
  createElement as createLucideElement,
  type IconNode,
} from 'lucide'

type SizeParam = number | string

export type VerticalTabPageParams = {
  activeColor?: string
  color?: string
  icon: IconNode
  title: string
  tooltip?: string
}

type VerticalTabPageParamsWithIndex = VerticalTabPageParams & {
  index?: number
}

type VerticalTabsBladeParams = {
  height?: SizeParam
  maxHeight?: SizeParam
  minHeight?: SizeParam
  pages: VerticalTabPageParams[]
  selectedIndex?: number
  view: 'verticalTabs'
}

type VerticalTabsEvents = {
  select: { index: number; title: string }
}

type TabItemPropsObject = {
  selected: boolean
  title: string | undefined
}

type PluginPoolLike = {
  createApi(controller: unknown): BladeApi
}

const PLUGIN_ID = 'vertical-tabs'
const VIEW = 'verticalTabs'
const DEFAULT_MIN_HEIGHT = '20rem'
const DEFAULT_ICON_COLOR = 'var(--lbl-fg)'
const DEFAULT_ACTIVE_ICON_COLOR = 'var(--in-fg)'
const cn = ClassName('vtabs')

class VerticalTabsView implements View {
  readonly element: HTMLElement
  readonly navElement: HTMLDivElement
  readonly contentsElement: HTMLDivElement
  readonly emitter = new Emitter<VerticalTabsEvents>()
  private readonly doc: Document

  constructor(doc: Document, params: {
    height?: SizeParam
    maxHeight?: SizeParam
    minHeight?: SizeParam
  }) {
    this.doc = doc
    this.element = doc.createElement('div')
    this.element.classList.add(cn())

    const body = doc.createElement('div')
    body.classList.add(cn('body'))
    this.element.appendChild(body)

    this.navElement = doc.createElement('div')
    this.navElement.classList.add(cn('rail'))
    this.navElement.setAttribute('role', 'tablist')
    this.navElement.setAttribute('aria-orientation', 'vertical')
    body.appendChild(this.navElement)

    this.contentsElement = doc.createElement('div')
    this.contentsElement.classList.add(cn('contents'))
    body.appendChild(this.contentsElement)

    this.setSize(params)
  }

  setSize(params: {
    height?: SizeParam
    maxHeight?: SizeParam
    minHeight?: SizeParam
  }): void {
    this.element.style.setProperty('--vtabs-min-height', toCssSize(params.minHeight ?? DEFAULT_MIN_HEIGHT))
    setOptionalStyle(this.element, '--vtabs-height', params.height)
    setOptionalStyle(this.element, '--vtabs-max-height', params.maxHeight)
  }

  renderTabs(pages: VerticalTabPageParams[], selectedIndex: number): void {
    this.navElement.replaceChildren()

    pages.forEach((page, index) => {
      const selected = index === selectedIndex
      const button = this.doc.createElement('button')
      const tooltipId = `vtabs-tip-${index}-${hashText(page.title)}`
      button.type = 'button'
      button.classList.add(cn('tab'))
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-label', page.tooltip ?? page.title)
      button.setAttribute('aria-selected', selected ? 'true' : 'false')
      button.setAttribute('aria-describedby', tooltipId)
      button.tabIndex = selected ? 0 : -1
      button.style.color = selected
        ? (page.activeColor ?? page.color ?? DEFAULT_ACTIVE_ICON_COLOR)
        : (page.color ?? DEFAULT_ICON_COLOR)
      if (selected) {
        button.classList.add(cn('tab', 'selected'))
      }

      const icon = createLucideElement(page.icon, {
        'aria-hidden': 'true',
        height: 16,
        stroke: 'currentColor',
        width: 16,
      })
      icon.classList.add(cn('icon'))
      button.appendChild(icon)

      const tooltip = this.doc.createElement('span')
      tooltip.classList.add(cn('tooltip'))
      tooltip.id = tooltipId
      tooltip.role = 'tooltip'
      tooltip.textContent = page.tooltip ?? page.title
      button.appendChild(tooltip)

      button.addEventListener('click', () => {
        button.focus()
        this.emitter.emit('select', { index, title: page.title })
      })
      button.addEventListener('keydown', (event) => {
        this.handleTabKeydown(event, index, pages.length)
      })
      this.navElement.appendChild(button)
    })
  }

  focusTab(index: number): void {
    const button = this.navElement.children[index] as HTMLButtonElement | undefined
    button?.focus()
  }

  private handleTabKeydown(event: KeyboardEvent, index: number, pageCount: number): void {
    let nextIndex: number | null = null

    if (event.key === 'ArrowUp') {
      nextIndex = modulo(index - 1, pageCount)
    } else if (event.key === 'ArrowDown') {
      nextIndex = modulo(index + 1, pageCount)
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = pageCount - 1
    } else if (event.key === 'Enter' || event.key === ' ') {
      nextIndex = index
    }

    if (nextIndex == null) {
      return
    }

    event.preventDefault()
    const page = this.navElement.children[nextIndex]
    this.emitter.emit('select', {
      index: nextIndex,
      title: page?.getAttribute('aria-label') ?? '',
    })
    window.requestAnimationFrame(() => this.focusTab(nextIndex))
  }
}

class VerticalTabsController extends ContainerBladeController<VerticalTabsView> {
  readonly emitter = new Emitter<VerticalTabsEvents>()
  readonly pageControllers: TabPageController[] = []
  private readonly pages: VerticalTabPageParams[] = []
  private selectedIndexValue = -1

  constructor(args: {
    blade: Blade
    height?: SizeParam
    maxHeight?: SizeParam
    minHeight?: SizeParam
    pages: VerticalTabPageParams[]
    selectedIndex?: number
    viewProps: ViewProps
    document: Document
  }) {
    const view = new VerticalTabsView(args.document, {
      height: args.height,
      maxHeight: args.maxHeight,
      minHeight: args.minHeight,
    })

    super({
      blade: args.blade,
      rackController: new RackController({
        blade: args.blade,
        element: view.contentsElement,
        viewProps: args.viewProps,
      }),
      view,
    })

    view.emitter.on('select', ({ index }) => {
      this.setSelectedIndex(index)
    })

    args.pages.forEach((page) => this.addPage(page))
    this.setSelectedIndex(args.selectedIndex ?? 0, { force: true })
  }

  get selectedIndex(): number {
    return this.selectedIndexValue
  }

  setSelectedIndex(index: number, options?: { force?: boolean }): void {
    if (this.pageControllers.length === 0) {
      this.selectedIndexValue = -1
      this.view.renderTabs(this.pages, this.selectedIndexValue)
      return
    }

    const nextIndex = clamp(index, 0, this.pageControllers.length - 1)
    if (!options?.force && nextIndex === this.selectedIndexValue) {
      return
    }

    this.selectedIndexValue = nextIndex
    this.pageControllers.forEach((controller, pageIndex) => {
      controller.props.set('selected', pageIndex === nextIndex)
    })
    this.view.renderTabs(this.pages, nextIndex)

    const page = this.pages[nextIndex]
    if (page) {
      this.emitter.emit('select', { index: nextIndex, title: page.title })
    }
  }

  addPage(params: VerticalTabPageParamsWithIndex): TabPageController {
    const index = clamp(
      params.index ?? this.pageControllers.length,
      0,
      this.pageControllers.length,
    )
    const page = normalizePageParams(params)
    const controller = new TabPageController(this.view.element.ownerDocument, {
      blade: createBlade(),
      itemProps: ValueMap.fromObject<TabItemPropsObject>({
        selected: false,
        title: page.title,
      }),
      props: ValueMap.fromObject<TabPagePropsObject>({
        selected: false,
      }),
      viewProps: ViewProps.create(),
    })

    this.pages.splice(index, 0, page)
    this.pageControllers.splice(index, 0, controller)
    this.rackController.rack.add(controller, index)

    if (this.selectedIndexValue < 0) {
      this.setSelectedIndex(0, { force: true })
    } else {
      if (index <= this.selectedIndexValue) {
        this.selectedIndexValue += 1
      }
      this.setSelectedIndex(this.selectedIndexValue, { force: true })
    }

    return controller
  }

  removePage(index: number): void {
    const controller = this.pageControllers[index]
    if (!controller) {
      return
    }

    this.rackController.rack.remove(controller)
    this.pageControllers.splice(index, 1)
    this.pages.splice(index, 1)
    this.setSelectedIndex(Math.min(this.selectedIndexValue, this.pageControllers.length - 1), {
      force: true,
    })
  }

  setPageMeta(index: number, params: Partial<VerticalTabPageParams>): void {
    const page = this.pages[index]
    if (!page) {
      return
    }

    const next = normalizePageParams({ ...page, ...params })
    this.pages[index] = next
    this.pageControllers[index]?.itemController.props.set('title', next.title)
    this.view.renderTabs(this.pages, this.selectedIndexValue)
  }
}

export class VerticalTabsApi extends ContainerBladeApi<VerticalTabsController> {
  private readonly pool: PluginPoolLike

  constructor(controller: VerticalTabsController, pool: PluginPoolLike) {
    super(controller, pool as never)
    this.pool = pool
  }

  get pages(): TabPageApi[] {
    return this.controller.pageControllers.map(
      (controller) => new TabPageApi(controller, this.pool as never),
    )
  }

  get selectedIndex(): number {
    return this.controller.selectedIndex
  }

  set selectedIndex(index: number) {
    this.controller.setSelectedIndex(index)
  }

  addPage(params: VerticalTabPageParamsWithIndex): TabPageApi {
    return new TabPageApi(this.controller.addPage(params), this.pool as never)
  }

  removePage(index: number): void {
    this.controller.removePage(index)
  }

  setPageMeta(index: number, params: Partial<VerticalTabPageParams>): void {
    this.controller.setPageMeta(index, params)
  }

  on<EventName extends keyof VerticalTabsEvents>(
    eventName: EventName,
    handler: (event: VerticalTabsEvents[EventName]) => void,
  ): this {
    this.controller.emitter.on(eventName, handler)
    return this
  }

  off<EventName extends keyof VerticalTabsEvents>(
    eventName: EventName,
    handler: (event: VerticalTabsEvents[EventName]) => void,
  ): this {
    this.controller.emitter.off(eventName, handler)
    return this
  }
}

const VerticalTabsBladePlugin: BladePlugin<VerticalTabsBladeParams> = createPlugin({
  id: VIEW,
  type: 'blade',
  accept(params) {
    const result = parseRecord<VerticalTabsBladeParams>(params, (parser) => ({
      height: parser.optional.custom(parseSizeParam),
      maxHeight: parser.optional.custom(parseSizeParam),
      minHeight: parser.optional.custom(parseSizeParam),
      pages: parser.required.array(parser.required.custom(parsePageParams)),
      selectedIndex: parser.optional.number,
      view: parser.required.constant(VIEW),
    }))

    return result && result.pages.length > 0 ? { params: result } : null
  },
  controller(args) {
    return new VerticalTabsController({
      blade: args.blade,
      document: args.document,
      height: args.params.height,
      maxHeight: args.params.maxHeight,
      minHeight: args.params.minHeight,
      pages: args.params.pages,
      selectedIndex: args.params.selectedIndex,
      viewProps: args.viewProps,
    })
  },
  api(args) {
    if (args.controller instanceof VerticalTabsController) {
      return new VerticalTabsApi(args.controller, args.pool as PluginPoolLike)
    }
    if (args.controller instanceof TabPageController) {
      return new TabPageApi(args.controller, args.pool as never)
    }
    return null
  },
})

export const VerticalTabsPluginBundle: TpPluginBundle = {
  id: PLUGIN_ID,
  plugin: VerticalTabsBladePlugin,
  css: `
    .${cn()} {
      --vtabs-height: auto;
      --vtabs-max-height: none;
      --vtabs-min-height: ${DEFAULT_MIN_HEIGHT};
      box-sizing: border-box;
      display: block;
      padding: var(--cnt-vp) var(--cnt-hp);
      width: 100%;
    }

    .${cn('body')} {
      background-color: var(--mo-bg);
      border-radius: var(--bld-br);
      box-sizing: border-box;
      display: flex;
      height: var(--vtabs-height);
      max-height: var(--vtabs-max-height);
      min-height: var(--vtabs-min-height);
      overflow: hidden;
      width: 100%;
    }

    .${cn('rail')} {
      align-items: center;
      background-color: var(--cnt-bg);
      border-right: 1px solid var(--grv-fg);
      display: flex;
      flex: none;
      flex-direction: column;
      gap: 2px;
      padding: var(--cnt-vp) 2px;
      width: calc(var(--cnt-usz) + 12px);
    }

    .${cn('tab')} {
      align-items: center;
      background: transparent;
      border: 0;
      border-radius: var(--bld-br);
      color: var(--lbl-fg);
      cursor: pointer;
      display: flex;
      flex: none;
      height: calc(var(--cnt-usz) + 4px);
      justify-content: center;
      padding: 0;
      position: relative;
      width: calc(var(--cnt-usz) + 4px);
    }

    .${cn('tab')}:hover {
      background-color: var(--cnt-bg-h);
    }

    .${cn('tab')}:focus {
      background-color: var(--cnt-bg-f);
      outline: none;
    }

    .${cn('tab')}:active {
      background-color: var(--cnt-bg-a);
    }

    .${cn('tab', 'selected')} {
      background-color: var(--in-bg-a);
      box-shadow: inset 2px 0 0 currentColor;
    }

    .${cn('icon')} {
      display: block;
      pointer-events: none;
      stroke-width: 2;
    }

    .${cn('tooltip')} {
      background-color: var(--in-fg);
      border-radius: var(--bld-br);
      color: var(--bs-bg);
      font-size: 11px;
      left: calc(100% + 7px);
      line-height: 1;
      opacity: 0;
      padding: 4px 6px;
      pointer-events: none;
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      transition: opacity 0.08s linear;
      white-space: nowrap;
      z-index: 30;
    }

    .${cn('tooltip')}::before {
      border-color: transparent var(--in-fg) transparent transparent;
      border-style: solid;
      border-width: 3px;
      content: '';
      height: 0;
      position: absolute;
      right: 100%;
      top: calc(50% - 3px);
      width: 0;
    }

    .${cn('tab')}:hover .${cn('tooltip')},
    .${cn('tab')}:focus .${cn('tooltip')} {
      opacity: 1;
    }

    .${cn('contents')} {
      box-sizing: border-box;
      flex: 1;
      min-width: 0;
      overflow: auto;
      padding: var(--cnt-vp) var(--cnt-hp);
      scrollbar-color: var(--mo-fg) rgba(0, 0, 0, 0);
      scrollbar-width: thin;
    }

    .${cn('contents')}::-webkit-scrollbar {
      height: 8px;
      width: 8px;
    }

    .${cn('contents')}::-webkit-scrollbar-corner {
      background-color: rgba(0, 0, 0, 0);
    }

    .${cn('contents')}::-webkit-scrollbar-thumb {
      background-clip: padding-box;
      background-color: var(--mo-fg);
      border: rgba(0, 0, 0, 0) solid 2px;
      border-radius: 4px;
    }
  `,
}

function parseSizeParam(value: unknown): SizeParam | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined
}

function parsePageParams(value: unknown): VerticalTabPageParams | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }

  const result = parseRecord<VerticalTabPageParams>(value as Record<string, unknown>, (parser) => ({
    activeColor: parser.optional.string,
    color: parser.optional.string,
    icon: parser.required.custom(parseIconNode),
    title: parser.required.string,
    tooltip: parser.optional.string,
  }))

  return result ? normalizePageParams(result) : undefined
}

function parseIconNode(value: unknown): IconNode | undefined {
  return Array.isArray(value) ? (value as IconNode) : undefined
}

function normalizePageParams(params: VerticalTabPageParams): VerticalTabPageParams {
  return {
    activeColor: params.activeColor,
    color: params.color,
    icon: params.icon,
    title: params.title,
    tooltip: params.tooltip ?? params.title,
  }
}

function setOptionalStyle(element: HTMLElement, name: string, value: SizeParam | undefined): void {
  if (value === undefined) {
    element.style.removeProperty(name)
    return
  }
  element.style.setProperty(name, toCssSize(value))
}

function toCssSize(value: SizeParam): string {
  return typeof value === 'number' ? `${value}px` : value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor
}

function hashText(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

/* eslint-disable */
// Tweakpane blade: a 2D, infinitely-pannable preview of a generated (tileable) texture. Drag in any
// direction to scroll; the image tiles to fill the view so repetition/seams are obvious. A "seams"
// toggle overlays tile-boundary lines. Wheel zooms. Feed it pixels via `setImageData`.
import {
  BladeApi,
  BladeController,
  type BladePlugin,
  ClassName,
  createPlugin,
  parseRecord,
  type TpPluginBundle,
  type View,
} from '@tweakpane/core'

type TexturePreviewParams = {
  label?: string
  view: 'texturePreview'
  height?: number
}

const PLUGIN_ID = 'texture-preview'
const VIEW = 'texturePreview'
const DEFAULT_HEIGHT = 220
const DEFAULT_TILE_PX = 110
const MIN_TILE_PX = 16
const MAX_TILE_PX = 1024

const cn = ClassName('texpv')

class TexturePreviewView implements View {
  readonly element: HTMLElement
  private readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D
  private readonly resizeObserver: ResizeObserver

  // The texture pixels live on an offscreen canvas we tile from.
  private readonly source: HTMLCanvasElement
  private readonly sourceContext: CanvasRenderingContext2D
  private hasImage = false

  private readonly cssHeight: number
  private cssWidth = MIN_TILE_PX
  private panX = 0
  private panY = 0
  private tilePx = DEFAULT_TILE_PX
  private seams = false

  private dragging = false
  private lastX = 0
  private lastY = 0

  constructor(doc: Document, label: string | undefined, height: number) {
    this.cssHeight = height
    this.element = doc.createElement('div')
    this.element.classList.add(cn())
    this.element.title = label ?? 'Texture preview'

    this.canvas = doc.createElement('canvas')
    this.canvas.classList.add(cn('canvas'))
    this.canvas.style.height = `${height}px`
    this.canvas.style.width = '100%'
    this.element.appendChild(this.canvas)

    const context = this.canvas.getContext('2d')
    if (!context) throw new Error('Texture preview requires a 2D canvas context.')
    this.context = context

    this.source = doc.createElement('canvas')
    const sctx = this.source.getContext('2d')
    if (!sctx) throw new Error('Texture preview requires a 2D canvas context.')
    this.sourceContext = sctx

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerup', this.onPointerUp)
    this.canvas.addEventListener('pointercancel', this.onPointerUp)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })

    this.resizeObserver = new ResizeObserver(this.onResize)
    this.resizeObserver.observe(this.element)
    window.requestAnimationFrame(() => this.resizeToElement())
  }

  setImageData(data: ImageData): void {
    if (this.source.width !== data.width || this.source.height !== data.height) {
      this.source.width = data.width
      this.source.height = data.height
    }
    this.sourceContext.putImageData(data, 0, 0)
    this.hasImage = true
    this.redraw()
  }

  setSeams(enabled: boolean): void {
    this.seams = enabled
    this.redraw()
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerup', this.onPointerUp)
    this.canvas.removeEventListener('pointercancel', this.onPointerUp)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.resizeObserver.disconnect()
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.dragging = true
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.canvas.setPointerCapture(e.pointerId)
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return
    this.panX += e.clientX - this.lastX
    this.panY += e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.redraw()
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.dragging = false
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId)
  }

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    // Zoom about the cursor so the texel under the pointer stays put.
    const rect = this.canvas.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const factor = Math.exp(-e.deltaY * 0.0015)
    const next = Math.min(MAX_TILE_PX, Math.max(MIN_TILE_PX, this.tilePx * factor))
    const ratio = next / this.tilePx
    this.panX = cx - (cx - this.panX) * ratio
    this.panY = cy - (cy - this.panY) * ratio
    this.tilePx = next
    this.redraw()
  }

  private readonly onResize = (): void => {
    this.resizeToElement()
  }

  private resizeToElement(): void {
    const width = Math.max(Math.floor(this.element.clientWidth), MIN_TILE_PX)
    const dpr = Math.max(Math.round(window.devicePixelRatio || 1), 1)
    if (width === this.cssWidth && this.canvas.width === width * dpr) return
    this.cssWidth = width
    this.canvas.width = width * dpr
    this.canvas.height = this.cssHeight * dpr
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.redraw()
  }

  private redraw(): void {
    const ctx = this.context
    const w = this.cssWidth
    const h = this.cssHeight
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#181818'
    ctx.fillRect(0, 0, w, h)

    if (!this.hasImage) {
      ctx.fillStyle = 'rgba(187,188,196,0.4)'
      ctx.font = '11px sans-serif'
      ctx.fillText('no texture', 8, 18)
      return
    }

    const tile = this.tilePx
    const offX = ((this.panX % tile) + tile) % tile
    const offY = ((this.panY % tile) + tile) % tile

    ctx.imageSmoothingEnabled = tile < this.source.width
    for (let x = offX - tile; x < w; x += tile) {
      for (let y = offY - tile; y < h; y += tile) {
        ctx.drawImage(this.source, 0, 0, this.source.width, this.source.height, x, y, tile, tile)
      }
    }

    if (this.seams) {
      ctx.strokeStyle = 'rgba(120,200,255,0.9)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let x = offX - tile; x <= w; x += tile) {
        ctx.moveTo(Math.round(x) + 0.5, 0)
        ctx.lineTo(Math.round(x) + 0.5, h)
      }
      for (let y = offY - tile; y <= h; y += tile) {
        ctx.moveTo(0, Math.round(y) + 0.5)
        ctx.lineTo(w, Math.round(y) + 0.5)
      }
      ctx.stroke()
    }
  }
}

class TexturePreviewController extends BladeController<TexturePreviewView> {
  constructor(args: {
    blade: ConstructorParameters<typeof BladeController>[0]['blade']
    document: Document
    label?: string
    height: number
    viewProps: ConstructorParameters<typeof BladeController>[0]['viewProps']
  }) {
    const view = new TexturePreviewView(args.document, args.label, args.height)
    super({ blade: args.blade, view, viewProps: args.viewProps })
    args.viewProps.handleDispose(() => view.dispose())
  }
}

export class TexturePreviewBladeApi extends BladeApi<TexturePreviewController> {
  setImageData(data: ImageData): void {
    this.controller.view.setImageData(data)
  }
  setSeams(enabled: boolean): void {
    this.controller.view.setSeams(enabled)
  }
}

const TexturePreviewBladePlugin: BladePlugin<TexturePreviewParams> = createPlugin({
  id: VIEW,
  type: 'blade',
  accept(params) {
    const result = parseRecord<TexturePreviewParams>(params, (parser) => ({
      label: parser.optional.string,
      view: parser.required.constant(VIEW),
      height: parser.optional.number,
    }))
    return result ? { params: result } : null
  },
  controller(args) {
    return new TexturePreviewController({
      blade: args.blade,
      document: args.document,
      label: args.params.label,
      height: args.params.height ?? DEFAULT_HEIGHT,
      viewProps: args.viewProps,
    })
  },
  api(args) {
    if (args.controller instanceof TexturePreviewController) {
      return new TexturePreviewBladeApi(args.controller)
    }
    return null
  },
})

export const TexturePreviewPluginBundle: TpPluginBundle = {
  id: PLUGIN_ID,
  plugin: TexturePreviewBladePlugin,
  css: `
    .${cn()} {
      box-sizing: border-box;
      display: block;
      padding: var(--cnt-vp) var(--cnt-hp);
      width: 100%;
    }
    .${cn('canvas')} {
      background-color: var(--mo-bg);
      border-radius: var(--bld-br);
      box-sizing: border-box;
      cursor: grab;
      display: block;
      touch-action: none;
      width: 100%;
    }
    .${cn('canvas')}:active {
      cursor: grabbing;
    }
  `,
}

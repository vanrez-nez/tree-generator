// Composes the `layers` blade with per-layer Tweakpane controls. Each layer type defines
// its controls via a `build(folder, layer)` callback; the controls are added straight into
// the layers folder (no extra wrapper), and selecting a layer shows that layer's controls
// while hiding the others. The blade owns the Add/Remove footer (and its type-picker menu +
// confirm dialog); this helper reacts to its events and manages the controls.
import type { BladeApi, ContainerApi, FolderApi } from '@tweakpane/core'
import {
  type LayerItem,
  LayersBladeApi,
  LayersPluginBundle,
} from './layers-blade'

export { LayersPluginBundle }

export type LayerHandle<T = unknown> = {
  readonly id: string
  readonly type: string
  name: string
  visible: boolean
  state: T
}

export type LayerType<T = any> = {
  /** Display name; also the label shown in the "Add Layer" menu. */
  name: string
  /** Add this layer's controls (folders, bindings) into the layers folder. */
  build: (folder: FolderApi, layer: LayerHandle<T>) => void
  /** Create the per-layer control state object bound by `build`. */
  createState?: () => T
}

/** A layer to pre-populate the list with (e.g. one per existing object). */
export type InitialLayer = {
  type: string
  id?: string
  name?: string
  state?: unknown
  visible?: boolean
}

export type CreateLayersOptions = {
  title?: string
  addLabel?: string
  types: LayerType[]
  /** Layers added before the first user interaction. The first becomes selected. */
  initialLayers?: InitialLayer[]
  onSelect?: (layer: LayerHandle | null) => void
  onVisibility?: (layer: LayerHandle) => void
  onAdd?: (layer: LayerHandle) => void
  onRemove?: (layer: LayerHandle) => void
  onReorder?: (layers: LayerHandle[]) => void
}

export type LayersController = {
  /** Programmatically add a layer of the given type name. */
  addLayer: (typeName: string) => LayerHandle | null
  getLayers: () => LayerHandle[]
  blade: LayersBladeApi
  folder: FolderApi
}

type LayerRecord = {
  id: string
  type: string
  handle: LayerHandle
  controls: BladeApi[]
}

export function createLayers(
  container: ContainerApi,
  options: CreateLayersOptions,
): LayersController {
  const types = new Map(options.types.map((type) => [type.name, type]))
  const records = new Map<string, LayerRecord>()
  let counter = 0

  const folder = container.addFolder({ title: options.title ?? 'Layers' })
  const blade = folder.addBlade({
    view: 'layers',
    addLabel: options.addLabel ?? 'Add Layer',
    types: options.types.map((type) => type.name),
  }) as LayersBladeApi

  function findHandle(id: string): LayerHandle | null {
    return records.get(id)?.handle ?? null
  }

  function showOnly(selectedId: string | null): void {
    for (const record of records.values()) {
      const hidden = record.id !== selectedId
      for (const control of record.controls) {
        control.hidden = hidden
      }
    }
  }

  function createLayer(
    typeName: string,
    init?: { id?: string; name?: string; state?: unknown; visible?: boolean },
  ): LayerHandle | null {
    const type = types.get(typeName)
    if (!type) {
      return null
    }

    let id = init?.id
    if (!id) {
      counter += 1
      id = `layer-${counter}`
    }
    const name = init?.name ?? `${type.name} ${counter}`
    const handle: LayerHandle = {
      id,
      type: type.name,
      name,
      visible: init?.visible ?? true,
      state:
        init?.state !== undefined
          ? init.state
          : type.createState
            ? type.createState()
            : ({} as unknown),
    }

    // Add this layer's controls straight into the layers folder, then track the blades
    // that were created so they can be shown/hidden as a group on selection.
    const startIndex = folder.children.length
    // Tweakpane-native rename: editing the name field updates the row label live.
    folder
      .addBinding(handle, 'name', { label: 'name' })
      .on('change', (event) => {
        blade.setName(handle.id, event.value)
      })
    type.build(folder, handle)
    const controls = folder.children.slice(startIndex)
    for (const control of controls) {
      control.hidden = true
    }

    records.set(handle.id, { id: handle.id, type: type.name, handle, controls })
    blade.addItem({
      id: handle.id,
      name: handle.name,
      visible: handle.visible,
    } satisfies LayerItem)
    return handle
  }

  function addLayer(typeName: string): LayerHandle | null {
    const handle = createLayer(typeName)
    if (!handle) {
      return null
    }
    blade.select(handle.id)
    showOnly(handle.id)
    options.onAdd?.(handle)
    options.onSelect?.(handle)
    return handle
  }

  blade.on('add', ({ type }) => {
    addLayer(type)
  })

  blade.on('select', ({ id }) => {
    showOnly(id)
    options.onSelect?.(findHandle(id))
  })

  blade.on('visibility', ({ id, visible }) => {
    const record = records.get(id)
    if (!record) {
      return
    }
    record.handle.visible = visible
    blade.setVisible(id, visible)
    options.onVisibility?.(record.handle)
  })

  blade.on('reorder', ({ ids }) => {
    options.onReorder?.(
      ids
        .map((id) => records.get(id)?.handle)
        .filter((handle): handle is LayerHandle => handle != null),
    )
  })

  blade.on('remove', ({ id }) => {
    const record = records.get(id)
    if (!record) {
      return
    }
    for (const control of record.controls) {
      control.dispose()
    }
    records.delete(id)
    blade.removeItem(id)

    const next = blade.getItems()[0]?.id ?? null
    if (next) {
      blade.select(next)
      showOnly(next)
      options.onSelect?.(findHandle(next))
    } else {
      showOnly(null)
      options.onSelect?.(null)
    }
    options.onRemove?.(record.handle)
  })

  for (const init of options.initialLayers ?? []) {
    createLayer(init.type, init)
  }
  const firstId = blade.getItems()[0]?.id ?? null
  if (firstId) {
    blade.select(firstId)
    showOnly(firstId)
    options.onSelect?.(findHandle(firstId))
  }

  return {
    addLayer,
    getLayers: () => Array.from(records.values()).map((record) => record.handle),
    blade,
    folder,
  }
}
